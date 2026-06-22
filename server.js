import express from 'express';
import cors from 'cors';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { unlink, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

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

// ─── Health ───────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Status ───────────────────────────────────────────────
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── Mode 1 ───────────────────────────────────────────────
app.post('/mode1', async (req, res) => {
  const { youtubeUrl, videoUrl } = req.body;
  const jobId = `mode1_${randomUUID()}`;

  jobs.set(jobId, { jobId, status: 'processing', progress: 0, clips: [] });
  res.json({ jobId });

  processMode1(jobId, youtubeUrl || videoUrl).catch(err => {
    jobs.set(jobId, { jobId, status: 'failed', error: err.message, clips: [], failedAt: Date.now() });
  });
});

async function processMode1(jobId, inputUrl) {
  const setProgress = (p) => {
    const job = jobs.get(jobId);
    jobs.set(jobId, { ...job, progress: p });
  };

  // Step 1: Download
  setProgress(10);
  const videoPath = path.join(TMP_DIR, `${jobId}.mp4`);
  const audioPath = path.join(TMP_DIR, `${jobId}.mp3`);

  const isYoutube = inputUrl && (inputUrl.includes('youtube.com') || inputUrl.includes('youtu.be'));

  if (isYoutube) {
    // yt-dlp with anti-bot flags
    await execFileAsync('yt-dlp', [
      '--no-playlist',
      '--format', 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best',
      '--merge-output-format', 'mp4',
      '--no-check-certificate',
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--extractor-args', 'youtube:player_client=web,mweb',
      '--output', videoPath,
      inputUrl
    ], { timeout: 120000 });
  } else {
    // Direct URL download via curl
    await execAsync(`curl -L -o "${videoPath}" "${inputUrl}"`, { timeout: 120000 });
  }

  // Step 2: Extract audio
  setProgress(30);
  await execFileAsync('ffmpeg', [
    '-i', videoPath,
    '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k',
    '-y', audioPath
  ], { timeout: 60000 });

  // Step 3: Transcribe with Whisper
  setProgress(50);
  const audioBuffer = await readFile(audioPath);
  const audioFile = new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' });

  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  // Step 4: GPT-4o-mini finds highlights
  setProgress(65);
  const segments = transcription.segments || [];
  const segText = segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}s] ${s.text}`).join('\n');

  const gptRes = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are a viral video editor. Analyze transcript segments and pick the TOP 3-5 most engaging highlight clips (each 20-45 seconds). Return JSON: {"highlights":[{"start":0,"end":30,"title":"...","keyword":"...","viral_score":8}]}`
    }, {
      role: 'user',
      content: `Find the best highlights from this transcript:\n${segText}`
    }],
    max_tokens: 1000,
  });

  const parsed = JSON.parse(gptRes.choices[0].message.content);
  const highlights = parsed.highlights || [];

  // Step 5: Cut clips
  setProgress(75);
  const clips = [];

  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    const clipId = `${jobId}_clip${i + 1}`;
    const clipPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);

    await execFileAsync('ffmpeg', [
      '-i', videoPath,
      '-ss', String(h.start),
      '-to', String(h.end),
      '-c', 'copy',
      '-y', clipPath
    ], { timeout: 60000 });

    clips.push({
      url: `${PUBLIC_BASE_URL}/outputs/${clipId}.mp4`,
      title: h.title || `Clip ${i + 1}`,
      keyword: h.keyword || '',
      start: h.start,
      end: h.end,
      duration: Math.round(h.end - h.start),
      viral_score: h.viral_score || 5,
    });

    setProgress(75 + Math.floor((i + 1) / highlights.length * 20));
  }

  // Cleanup
  try { await unlink(videoPath); await unlink(audioPath); } catch {}

  jobs.set(jobId, { jobId, status: 'done', progress: 100, clips, completedAt: Date.now() });
}

app.listen(PORT, () => console.log(`ClipThai backend listening on :${PORT}`));
