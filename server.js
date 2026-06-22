import express from 'express';
import cors from 'cors';
import { execFile, spawn } from 'child_process';
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

async function getVideoDimensions(videoPath) {
  try {
    const result = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'csv=p=0', videoPath
    ]);
    const out = (result.stdout || result.stderr || '640,360,30/1').trim();
    const parts = out.split(',');
    const w = parseInt(parts[0]) || 640;
    const h = parseInt(parts[1]) || 360;
    const fpsStr = parts[2] || '30/1';
    const fpsParts = fpsStr.split('/');
    const fps = Math.round(parseInt(fpsParts[0]) / (parseInt(fpsParts[1]) || 1)) || 30;
    return { width: w, height: h, fps };
  } catch {
    return { width: 640, height: 360, fps: 30 };
  }
}

// Check if clip has high motion (bool)
async function hasHighMotion(videoPath, startTime, endTime) {
  return new Promise((resolve) => {
    const duration = Math.min(endTime - startTime, 8);
    const proc = spawn('ffmpeg', [
      '-ss', String(startTime), '-t', String(duration),
      '-i', videoPath,
      '-vf', 'mestimate=method=epzs:mb_size=16,metadata=print:file=-',
      '-an', '-f', 'null', '/dev/null'
    ]);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', () => {
      const matches = [...stderr.matchAll(/MV_[xy]=([+-]?\d+\.?\d*)/g)];
      if (matches.length === 0) return resolve(false);
      const avg = matches.reduce((s, m) => s + Math.abs(parseFloat(m[1])), 0) / matches.length;
      resolve(avg > 4);
    });
    proc.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 12000);
  });
}

function buildVfFilter(aspectRatio, vw, vh, highMotion) {
  const zoomFactor = highMotion ? 1.3 : 1.1;
  const inputRatio = vw / vh;

  if (aspectRatio === '16:9') {
    // Already 16:9?
    if (Math.abs(inputRatio - 16/9) < 0.05) return `scale=1280:720`;
    const cropH = Math.floor(vw * 9 / 16);
    if (cropH <= vh) {
      const cy = Math.floor((vh - cropH) / 2);
      return `crop=${vw}:${cropH}:0:${cy},scale=1280:720`;
    }
    const cropW = Math.floor(vh * 16 / 9);
    const cx = Math.floor((vw - cropW) / 2);
    return `crop=${cropW}:${vh}:${cx}:0,scale=1280:720`;

  } else if (aspectRatio === '1:1') {
    // Already 1:1?
    if (Math.abs(inputRatio - 1) < 0.05) return `scale=720:720`;
    const size = Math.floor(Math.min(vw, vh) / zoomFactor);
    const cx = Math.floor((vw - size) / 2);
    const cy = Math.floor((vh - size) / 2);
    return `crop=${size}:${size}:${cx}:${cy},scale=720:720`;

  } else {
    // 9:16
    // Already 9:16?
    if (Math.abs(inputRatio - 9/16) < 0.05) return `scale=720:1280`;
    // Input is wider — crop width to make 9:16, then scale up
    const targetW = Math.floor(vh * 9 / 16);
    if (targetW <= vw) {
      const zoomedW = Math.floor(targetW / zoomFactor);
      const cx = Math.floor((vw - zoomedW) / 2);
      return `crop=${zoomedW}:${vh}:${cx}:0,scale=720:1280:flags=lanczos`;
    }
    // Input is taller — crop height
    const targetH = Math.floor(vw * 16 / 9);
    const zoomedH = Math.floor(targetH / zoomFactor);
    const cy = Math.floor((vh - zoomedH) / 2);
    return `crop=${vw}:${zoomedH}:0:${cy},scale=720:1280:flags=lanczos`;
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

  set({ progress: 10, step: 'downloading' });
  if (isYoutube) {
    await ytdlpDownload(inputUrl, videoPath);
  } else {
    await execFileAsync('curl', ['-L', '-o', videoPath, inputUrl], { timeout: 120000 });
  }

  const { width: vw, height: vh, fps } = await getVideoDimensions(videoPath);
  console.log(`Video: ${vw}x${vh} @ ${fps}fps`);

  set({ progress: 30, step: 'extracting_audio' });
  await execFileAsync('ffmpeg', [
    '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', '-y', audioPath
  ], { timeout: 60000 });

  set({ progress: 50, step: 'transcribing' });
  const audioBuffer = await readFile(audioPath);
  const audioFile = new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' });
  const transcription = await openai.audio.transcriptions.create({
    file: audioFile, model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  set({ progress: 65, step: 'analyzing' });
  const segments = transcription.segments || [];
  const segText = segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}s] ${s.text}`).join('\n');

  const gptRes = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `You are a viral video editor. Pick 3-5 best highlight clips.
RULES:
- Each clip minimum 6 seconds (end - start >= 6)
- Each clip maximum 45 seconds (end - start <= 45)
- ALWAYS end each clip at a natural stopping point — after a sentence completes, after a goal/action finishes, after applause, or after a clear pause. Never cut mid-sentence or mid-action.
- Start clips slightly before the action begins (1-2s early) so context is clear
- Prefer clips that have a clear beginning, middle, and end
Return JSON: {"highlights":[{"start":0,"end":30,"title":"...","keyword":"...","viral_score":8}]}` },
      { role: 'user', content: `Find highlights:\n${segText}` }
    ],
    max_tokens: 1000,
  });

  let { highlights = [] } = JSON.parse(gptRes.choices[0].message.content);
  highlights = highlights.map(h => {
    if (h.end - h.start < 6) h.end = h.start + 6;
    if (h.end - h.start > 45) h.end = h.start + 45;
    // Add 2s buffer at end so action completes naturally
    h.end = h.end + 2;
    return h;
  });

  set({ progress: 75, step: 'cutting_clips' });
  const clips = [];

  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    const clipId = `${jobId}_clip${i + 1}`;
    const clipPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);
    const duration = h.end - h.start;

    const highMotion = await hasHighMotion(videoPath, h.start, h.end);
    const vfFilter = buildVfFilter(aspectRatio, vw, vh, highMotion);
    console.log(`Clip ${i+1} [${h.start}-${h.end}s] highMotion=${highMotion}`);

    await execFileAsync('ffmpeg', [
      '-i', videoPath,
      '-ss', String(h.start), '-to', String(h.end),
      '-vf', vfFilter,
      '-c:v', 'libx264', '-c:a', 'aac',
      '-preset', 'fast', '-crf', '23',
      '-movflags', '+faststart',
      '-y', clipPath
    ], { timeout: 180000 });

    clips.push({
      url: `${PUBLIC_BASE_URL}/outputs/${clipId}.mp4`,
      title: h.title || `Clip ${i + 1}`,
      keyword: h.keyword || '',
      start: h.start, end: h.end,
      duration: Math.round(duration),
      viral_score: h.viral_score || 5,
      aspectRatio,
    });

    set({ progress: 75 + Math.floor((i + 1) / highlights.length * 20) });
  }

  try { await unlink(videoPath); await unlink(audioPath); } catch {}
  jobs.set(jobId, { jobId, status: 'done', progress: 100, clips, completedAt: Date.now() });
}

app.listen(PORT, () => console.log(`ClipThai backend listening on :${PORT}`));
