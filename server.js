import express from 'express';
import cors from 'cors';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import { unlink, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const OUTPUT_DIR = path.join(__dirname, 'public', 'outputs');
const TMP_DIR = path.join(__dirname, 'tmp');

[OUTPUT_DIR, TMP_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const jobs = new Map();

const app = express();
app.use(cors());
app.use(express.json());
app.use('/outputs', express.static(OUTPUT_DIR));

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.post('/mode1', async (req, res) => {
  const { youtubeUrl, videoUrl } = req.body;
  if (!youtubeUrl && !videoUrl) return res.status(400).json({ error: 'youtubeUrl or videoUrl required' });
  const jobId = `mode1_${randomUUID()}`;
  jobs.set(jobId, { jobId, status: 'processing', progress: 0, clips: [] });
  res.json({ jobId });
  processMode1(jobId, youtubeUrl || videoUrl).catch(err => {
    jobs.set(jobId, { jobId, status: 'failed', error: err.message, clips: [], failedAt: Date.now() });
  });
});

async function ytdlpDownload(url, outputPath) {
  // Strategy 1: android client (no PO token needed, works on most IPs)
  const strategies = [
    // Android client - most reliable for server IPs
    ['--extractor-args', 'youtube:player_client=android',
     '--format', 'bestvideo[ext=mp4][height<=720]+bestaudio/best[height<=720]/best',
     '--no-playlist', '--no-check-certificate',
     '--output', outputPath, url],
    // iOS client
    ['--extractor-args', 'youtube:player_client=ios',
     '--format', 'best[height<=720]/best',
     '--no-playlist', '--no-check-certificate',
     '--output', outputPath, url],
    // TV client (no age gate, no bot detection)
    ['--extractor-args', 'youtube:player_client=tv_embedded',
     '--format', 'best[height<=720]/best',
     '--no-playlist', '--no-check-certificate',
     '--output', outputPath, url],
  ];

  let lastError;
  for (const args of strategies) {
    try {
      await execFileAsync('yt-dlp', args, { timeout: 180000 });
      return; // success
    } catch (err) {
      lastError = err;
      console.log(`Strategy failed, trying next... ${err.message.slice(0, 100)}`);
    }
  }
  throw new Error(`All yt-dlp strategies failed: ${lastError.message.slice(0, 300)}`);
}

async function processMode1(jobId, inputUrl) {
  const set = (update) => jobs.set(jobId, { ...jobs.get(jobId), ...update });

  const videoPath = path.join(TMP_DIR, `${jobId}.mp4`);
  const audioPath = path.join(TMP_DIR, `${jobId}.mp3`);

  const isYoutube = /youtube\.com|youtu\.be/.test(inputUrl);

  // Step 1: Download
  set({ progress: 10, step: 'downloading' });
  if (isYoutube) {
    await ytdlpDownload(inputUrl, videoPath);
  } else {
    await execFileAsync('curl', ['-L', '-o', videoPath, inputUrl], { timeout: 120000 });
  }

  // Step 2: Extract audio
  set({ progress: 30, step: 'extracting_audio' });
  await execFileAsync('ffmpeg', [
    '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', '-y', audioPath
  ], { timeout: 60000 });

  // Step 3: Whisper transcribe
  set({ progress: 50, step: 'transcribing' });
  const audioBuffer = await readFile(audioPath);
  const audioFile = new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' });
  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  // Step 4: GPT-4o-mini analyze
  set({ progress: 65, step: 'analyzing' });
  const segments = transcription.segments || [];
  const segText = segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}s] ${s.text}`).join('\n');

  const gptRes = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a viral video editor. Pick 3-5 best highlight clips (20-45s each). Return JSON: {"highlights":[{"start":0,"end":30,"title":"...","keyword":"...","viral_score":8}]}' },
      { role: 'user', content: `Find highlights:\n${segText}` }
    ],
    max_tokens: 1000,
  });

  const { highlights = [] } = JSON.parse(gptRes.choices[0].message.content);

  // Step 5: Cut clips
  set({ progress: 75, step: 'cutting_clips' });
  const clips = [];
  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    const clipId = `${jobId}_clip${i + 1}`;
    const clipPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);
    await execFileAsync('ffmpeg', [
      '-i', videoPath, '-ss', String(h.start), '-to', String(h.end), '-c', 'copy', '-y', clipPath
    ], { timeout: 60000 });
    clips.push({
      url: `${PUBLIC_BASE_URL}/outputs/${clipId}.mp4`,
      title: h.title || `Clip ${i + 1}`,
      keyword: h.keyword || '',
      start: h.start, end: h.end,
      duration: Math.round(h.end - h.start),
      viral_score: h.viral_score || 5,
    });
    set({ progress: 75 + Math.floor((i + 1) / highlights.length * 20) });
  }

  try { await unlink(videoPath); await unlink(audioPath); } catch {}

  jobs.set(jobId, { jobId, status: 'done', progress: 100, clips, completedAt: Date.now() });
}

app.listen(PORT, () => console.log(`ClipThai backend listening on :${PORT}`));
