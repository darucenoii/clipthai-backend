import express from 'express';
import cors from 'cors';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import { unlink, readFile } from 'fs/promises';
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

// Aspect ratio crop filters for ffmpeg
// Analyze motion to find the most active x-position in video
async function getMotionCropX(videoPath, targetWidth, videoWidth) {
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      const ffmpeg = require('child_process').spawn('ffmpeg', [
        '-i', videoPath,
        '-vf', 'mestimate=method=epzs:mb_size=16:search_param=7,metadata=print:file=-',
        '-frames:v', '60',  // analyze first 60 frames
        '-f', 'null', '-'
      ]);
      let out = '';
      ffmpeg.stderr.on('data', d => out += d.toString());
      ffmpeg.on('close', code => resolve({ stdout: out }));
      ffmpeg.on('error', reject);
    });

    // Parse motion vectors to find active region
    const matches = [...stdout.matchAll(/MV_x=([+-]?\d+\.?\d*)/g)];
    if (matches.length === 0) return Math.floor((videoWidth - targetWidth) / 2);

    const avgX = matches.reduce((sum, m) => sum + Math.abs(parseFloat(m[1])), 0) / matches.length;
    const centerX = Math.min(Math.max(Math.floor(videoWidth / 2 + avgX - targetWidth / 2), 0), videoWidth - targetWidth);
    return centerX;
  } catch {
    return Math.floor((videoWidth - targetWidth) / 2); // fallback to center
  }
}

async function getVideoDimensions(videoPath) {
  try {
    const { stderr } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', videoPath
    ]);
    const [w, h] = stderr.split(',').map(Number);
    return { width: w || 640, height: h || 360 };
  } catch {
    return { width: 640, height: 360 };
  }
}

async function buildCropFilter(aspectRatio, videoPath) {
  try {
    // Get video dimensions via ffprobe stdout
    const result = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', videoPath
    ]);
    const parts = (result.stdout || result.stderr || '640,360').trim().split(',');
    const vw = parseInt(parts[0]) || 640;
    const vh = parseInt(parts[1]) || 360;

    if (aspectRatio === '16:9') {
      return `scale=1280:720`;
    }

    if (aspectRatio === '1:1') {
      // crop square from center
      const size = Math.min(vw, vh);
      const x = Math.floor((vw - size) / 2);
      const y = Math.floor((vh - size) / 2);
      return `crop=${size}:${size}:${x}:${y},scale=720:720`;
    }

    // 9:16 — smart motion crop
    const targetW = Math.floor(vh * 9 / 16);
    if (targetW >= vw) {
      // video is already narrow — just scale
      return `scale=720:1280`;
    }

    // analyze motion to find best x crop position
    let cropX = Math.floor((vw - targetW) / 2); // default center
    try {
      const probe = await execFileAsync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'json', videoPath
      ]);
      // Use ffmpeg to get motion info from first 3 seconds
      const motionResult = await execFileAsync('ffmpeg', [
        '-i', videoPath,
        '-t', '3',
        '-vf', `mestimate=method=epzs:mb_size=16,metadata=print:file=-`,
        '-an', '-f', 'null', '/dev/null'
      ], { timeout: 15000 });

      const mvMatches = [...(motionResult.stderr || '').matchAll(/MV_x=([+-]?\d+\.?\d*)/g)];
      if (mvMatches.length > 0) {
        const avgMVX = mvMatches.reduce((s, m) => s + parseFloat(m[1]), 0) / mvMatches.length;
        // shift crop toward where motion is happening
        cropX = Math.min(
          Math.max(Math.floor(vw / 2 + avgMVX * 2 - targetW / 2), 0),
          vw - targetW
        );
      }
    } catch {
      // keep center crop as fallback
    }

    return `crop=${targetW}:${vh}:${cropX}:0,scale=720:1280`;
  } catch {
    // ultimate fallback
    return aspectRatio === '1:1' ? 'crop=ih:ih:(iw-ih)/2:0,scale=720:720' : 'crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=720:1280';
  }
}

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
  const { youtubeUrl, videoUrl, aspectRatio = '9:16' } = req.body;
  if (!youtubeUrl && !videoUrl) return res.status(400).json({ error: 'youtubeUrl or videoUrl required' });
  const jobId = `mode1_${randomUUID()}`;
  jobs.set(jobId, { jobId, status: 'processing', progress: 0, clips: [] });
  res.json({ jobId });
  processMode1(jobId, youtubeUrl || videoUrl, aspectRatio).catch(err => {
    jobs.set(jobId, { jobId, status: 'failed', error: err.message, clips: [], failedAt: Date.now() });
  });
});

async function ytdlpDownload(url, outputPath) {
  const strategies = [
    ['--extractor-args', 'youtube:player_client=android',
     '--format', 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best',
     '--merge-output-format', 'mp4',
     '--no-playlist', '--no-check-certificate', '--output', outputPath, url],
    ['--extractor-args', 'youtube:player_client=ios',
     '--format', 'best[ext=mp4][height<=720]/best',
     '--no-playlist', '--no-check-certificate', '--output', outputPath, url],
    ['--format', 'best[height<=720]/best',
     '--no-playlist', '--no-check-certificate', '--output', outputPath, url],
  ];
  let lastError;
  for (const args of strategies) {
    try {
      await execFileAsync('yt-dlp', args, { timeout: 180000 });
      return;
    } catch (err) {
      lastError = err;
      console.log(`Strategy failed: ${err.message.slice(0, 80)}`);
    }
  }
  throw new Error(`All yt-dlp strategies failed: ${lastError.message.slice(0, 200)}`);
}

async function processMode1(jobId, inputUrl, aspectRatio) {
  const set = (update) => jobs.set(jobId, { ...jobs.get(jobId), ...update });

  const videoPath = path.join(TMP_DIR, `${jobId}.mp4`);
  const audioPath = path.join(TMP_DIR, `${jobId}.mp3`);
  const isYoutube = /youtube\.com|youtu\.be/.test(inputUrl);

  console.log(`Processing job ${jobId} | aspectRatio: ${aspectRatio}`);

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
      {
        role: 'system',
        content: `You are a viral video editor. Pick 3-5 best highlight clips.
RULES:
- Each clip minimum 6 seconds (end - start >= 6)
- Each clip maximum 60 seconds (end - start <= 60)
- Never return a clip shorter than 6 seconds
Return JSON: {"highlights":[{"start":0,"end":30,"title":"...","keyword":"...","viral_score":8}]}`
      },
      { role: 'user', content: `Find highlights:\n${segText}` }
    ],
    max_tokens: 1000,
  });

  let { highlights = [] } = JSON.parse(gptRes.choices[0].message.content);

  // Safety: enforce duration
  highlights = highlights.map(h => {
    if (h.end - h.start < 6) h.end = h.start + 6;
    if (h.end - h.start > 60) h.end = h.start + 60;
    return h;
  });

  // Step 5: Cut + crop clips — build smart crop filter from downloaded video
  set({ progress: 75, step: 'cutting_clips' });
  const cropFilter = await buildCropFilter(aspectRatio, videoPath);
  console.log(`Smart crop filter: ${cropFilter}`);
  const clips = [];

  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    const clipId = `${jobId}_clip${i + 1}`;
    const clipPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);

    await execFileAsync('ffmpeg', [
      '-i', videoPath,
      '-ss', String(h.start),
      '-to', String(h.end),
      '-vf', cropFilter,          // crop to aspect ratio
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-preset', 'fast',
      '-crf', '23',
      '-movflags', '+faststart',
      '-y', clipPath
    ], { timeout: 120000 });

    clips.push({
      url: `${PUBLIC_BASE_URL}/outputs/${clipId}.mp4`,
      title: h.title || `Clip ${i + 1}`,
      keyword: h.keyword || '',
      start: h.start,
      end: h.end,
      duration: Math.round(h.end - h.start),
      viral_score: h.viral_score || 5,
      aspectRatio,
    });

    set({ progress: 75 + Math.floor((i + 1) / highlights.length * 20) });
  }

  try { await unlink(videoPath); await unlink(audioPath); } catch {}

  jobs.set(jobId, { jobId, status: 'done', progress: 100, clips, completedAt: Date.now() });
}

app.listen(PORT, () => console.log(`ClipThai backend listening on :${PORT}`));
