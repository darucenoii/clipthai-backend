import express from 'express';
import cors from 'cors';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import { unlink, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const OUTPUT_DIR = path.join(__dirname, 'public', 'outputs');
const TMP_DIR = path.join(__dirname, 'tmp');

[OUTPUT_DIR, TMP_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const jobs = new Map();

// ─── Video info ────────────────────────────────────────────────────────────────
async function getVideoDimensions(videoPath) {
  try {
    const r = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'csv=p=0', videoPath
    ]);
    const parts = (r.stdout || '640,360,30/1').trim().split(',');
    const w = parseInt(parts[0]) || 640;
    const h = parseInt(parts[1]) || 360;
    const fp = parts[2] || '30/1';
    const fps = Math.round(parseInt(fp) / (parseInt(fp.split('/')[1]) || 1)) || 30;
    return { width: w, height: h, fps };
  } catch {
    return { width: 640, height: 360, fps: 30 };
  }
}

// ─── Smart crop: analyze where action is, output zoompan expression ───────────
//
// Strategy:
//   1. Sample N frames from the clip segment
//   2. For each consecutive pair, compute per-column frame difference
//   3. Find the "motion centroid X" per frame → where are the players/ball
//   4. Smooth the centroid over time (avoid jitter)
//   5. Build a ffmpeg zoompan filter that follows the smoothed centroid
//
async function analyzeMotionCentroids(videoPath, startTime, endTime, vw, vh) {
  return new Promise((resolve) => {
    // Sample every 0.2s, scale to 160x90 for speed, crop out scoreboard
    const duration = Math.min(endTime - startTime, 30);
    const sampleFps = 5; // 5 frames per second

    const proc = spawn('ffmpeg', [
      '-ss', String(startTime),
      '-t', String(duration),
      '-i', videoPath,
      // scale down, crop scoreboard (top 14%), crop bottom 15% empty pitch
      '-vf', `scale=160:90,crop=160:67:0:13`,
      '-f', 'rawvideo', '-pix_fmt', 'gray',
      '-r', String(sampleFps),
      'pipe:1'
    ]);

    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', () => {}); // suppress

    proc.on('close', () => {
      try {
        const frameW = 160, frameH = 67;
        const frameSize = frameW * frameH;
        const raw = Buffer.concat(chunks);
        const numFrames = Math.floor(raw.length / frameSize);

        if (numFrames < 2) return resolve([]);

        const centroids = []; // [{t, cx_norm}]

        for (let i = 1; i < numFrames; i++) {
          const prev = raw.slice((i-1) * frameSize, i * frameSize);
          const curr = raw.slice(i * frameSize, (i+1) * frameSize);

          // Per-column motion: sum |diff| over all rows for each column
          const colMotion = new Float32Array(frameW);
          for (let y = 0; y < frameH; y++) {
            for (let x = 0; x < frameW; x++) {
              colMotion[x] += Math.abs(curr[y * frameW + x] - prev[y * frameW + x]);
            }
          }

          const totalMotion = colMotion.reduce((a, b) => a + b, 0);
          let cx_norm = 0.5;
          if (totalMotion > 500) { // ignore very low motion frames
            let weightedSum = 0;
            for (let x = 0; x < frameW; x++) weightedSum += colMotion[x] * x;
            cx_norm = (weightedSum / totalMotion) / frameW;
          }

          const t = startTime + (i / sampleFps);
          centroids.push({ t, cx_norm });
        }

        resolve(centroids);
      } catch (e) {
        console.log('centroid analysis error:', e.message);
        resolve([]);
      }
    });

    proc.on('error', () => resolve([]));
    setTimeout(() => { proc.kill(); resolve([]); }, 20000);
  });
}

function smoothCentroids(centroids, windowSize = 10) {
  // Moving average smoothing to prevent camera jitter
  return centroids.map((c, i) => {
    const start = Math.max(0, i - windowSize);
    const end = Math.min(centroids.length - 1, i + windowSize);
    const slice = centroids.slice(start, end + 1);
    const avg = slice.reduce((s, x) => s + x.cx_norm, 0) / slice.length;
    return { t: c.t, cx_norm: avg };
  });
}

// Build ffmpeg zoompan expression for smooth pan following action
// For 16:9 → 9:16: crop window is (vh * 9/16) wide, full height
// cx varies per frame to follow the action
function buildZoompanFilter(vw, vh, smoothedCentroids, startTime, fps) {
  const cropW = Math.floor(vh * 9 / 16); // e.g. 202 for 360p
  const maxCx = vw - cropW;             // e.g. 438 for 640px wide

  if (smoothedCentroids.length === 0) {
    // Fallback: static center crop
    const cx = Math.floor(maxCx / 2);
    return `crop=${cropW}:${vh}:${cx}:0,scale=720:1280:flags=lanczos`;
  }

  // Build a lookup: frame_number → cx_pixels
  // We'll encode this as a ffmpeg 'if' chain... but that gets huge.
  // Better: write a per-frame crop list and use ffmpeg select+overlay.
  // Simplest reliable approach: use zoompan with piecewise linear cx.
  
  // For zoompan: z=zoom, x=crop_x, y=crop_y, d=duration_frames
  // We'll use z=1 (no zoom, we handle zoom via crop+scale)
  // Actually let's just use crop filter with smooth cx
  
  // The cleanest approach for Railway: precompute cx per frame, 
  // use ffmpeg -vf "crop=w:h:x:y" with a sendcmd file
  
  // Build sendcmd script: at each timestamp, set crop x
  const cmds = [];
  for (const c of smoothedCentroids) {
    const cx = Math.max(0, Math.min(maxCx, Math.floor(c.cx_norm * maxCx)));
    const relT = Math.max(0, c.t - startTime);
    cmds.push(`${relT.toFixed(3)} crop x ${cx};`);
  }

  return {
    type: 'sendcmd',
    cmds: cmds.join('\n'),
    cropW,
    maxCx,
    fallbackCx: Math.floor(maxCx / 2)
  };
}

// Main crop function: returns ffmpeg args for smart crop
async function buildSmartCropArgs(videoPath, startTime, endTime, vw, vh, aspectRatio, clipTmpPath) {
  const inputRatio = vw / vh;
  const target916 = aspectRatio === '9:16';

  // If already 9:16, just scale
  if (target916 && Math.abs(inputRatio - 9/16) < 0.02) {
    return { vfFilter: 'scale=720:1280:flags=lanczos', sendcmdFile: null };
  }

  // If 16:9 → 9:16 (main case)
  if (target916 && inputRatio > 1.5) {
    const cropW = Math.floor(vh * 9 / 16);
    const maxCx = vw - cropW;

    console.log(`  Analyzing motion for clip [${startTime.toFixed(1)}-${endTime.toFixed(1)}s]...`);
    const rawCentroids = await analyzeMotionCentroids(videoPath, startTime, endTime, vw, vh);

    if (rawCentroids.length < 3) {
      // Not enough data, use center
      const cx = Math.floor(maxCx / 2);
      console.log(`  Motion data insufficient, using center cx=${cx}`);
      return { vfFilter: `crop=${cropW}:${vh}:${cx}:0,scale=720:1280:flags=lanczos`, sendcmdFile: null };
    }

    const smoothed = smoothCentroids(rawCentroids, 8);

    // Log where the action was
    const avgCx = smoothed.reduce((s, c) => s + c.cx_norm, 0) / smoothed.length;
    const zone = avgCx < 0.35 ? 'LEFT' : avgCx > 0.65 ? 'RIGHT' : 'CENTER';
    console.log(`  Action zone: ${zone} (avg cx_norm=${avgCx.toFixed(2)})`);
    console.log(`  Centroid range: ${Math.min(...smoothed.map(c=>c.cx_norm)).toFixed(2)} - ${Math.max(...smoothed.map(c=>c.cx_norm)).toFixed(2)}`);

    // Write sendcmd file for dynamic crop
    const sendcmdPath = `${clipTmpPath}_sendcmd.txt`;
    const cmds = smoothed.map(c => {
      const cx = Math.max(0, Math.min(maxCx, Math.round(c.cx_norm * maxCx)));
      const relT = Math.max(0, c.t - startTime);
      return `${relT.toFixed(3)} crop x ${cx};`;
    }).join('\n');

    await writeFile(sendcmdPath, cmds);

    const vfFilter = `sendcmd=f='${sendcmdPath}',crop=${cropW}:${vh}:${Math.round(avgCx * maxCx)}:0,scale=720:1280:flags=lanczos`;
    return { vfFilter, sendcmdFile: sendcmdPath };
  }

  // Other aspect ratios (16:9 output, 1:1) - simple crop
  if (aspectRatio === '16:9') {
    if (Math.abs(inputRatio - 16/9) < 0.05) return { vfFilter: 'scale=1280:720', sendcmdFile: null };
    const cropH = Math.floor(vw * 9 / 16);
    if (cropH <= vh) {
      const cy = Math.floor((vh - cropH) / 2);
      return { vfFilter: `crop=${vw}:${cropH}:0:${cy},scale=1280:720`, sendcmdFile: null };
    }
  }

  if (aspectRatio === '1:1') {
    const size = Math.min(vw, vh);
    const cx = Math.floor((vw - size) / 2);
    return { vfFilter: `crop=${size}:${size}:${cx}:0,scale=720:720`, sendcmdFile: null };
  }

  return { vfFilter: 'scale=720:1280:flags=lanczos', sendcmdFile: null };
}

// ─── Express app ───────────────────────────────────────────────────────────────
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
    try { await execFileAsync('yt-dlp', args, { timeout: 180000 }); return; }
    catch (err) { lastError = err; console.log(`Strategy failed: ${err.message.slice(0,80)}`); }
  }
  throw new Error(`All yt-dlp strategies failed: ${lastError.message.slice(0,200)}`);
}

async function processMode1(jobId, inputUrl, aspectRatio) {
  const set = (u) => jobs.set(jobId, { ...jobs.get(jobId), ...u });

  const videoPath = path.join(TMP_DIR, `${jobId}.mp4`);
  const audioPath = path.join(TMP_DIR, `${jobId}.mp3`);
  const isYoutube = /youtube\.com|youtu\.be/.test(inputUrl);

  set({ progress: 10, step: 'downloading' });
  if (isYoutube) await ytdlpDownload(inputUrl, videoPath);
  else await execFileAsync('curl', ['-L', '-o', videoPath, inputUrl], { timeout: 120000 });

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
- Each clip minimum 6 seconds, maximum 45 seconds
- End at natural stopping point (after goal, applause, sentence end)
- Start 1-2s before action begins
Return JSON: {"highlights":[{"start":0,"end":30,"title":"...","keyword":"...","viral_score":8}]}` },
      { role: 'user', content: `Find highlights:\n${segText}` }
    ],
    max_tokens: 1000,
  });

  let { highlights = [] } = JSON.parse(gptRes.choices[0].message.content);
  highlights = highlights.map(h => {
    if (h.end - h.start < 6) h.end = h.start + 6;
    if (h.end - h.start > 45) h.end = h.start + 45;
    h.end = h.end + 2;
    return h;
  });

  set({ progress: 75, step: 'cutting_clips' });
  const clips = [];
  const sendcmdFiles = [];

  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    const clipId = `${jobId}_clip${i + 1}`;
    const clipPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);
    const clipTmpPath = path.join(TMP_DIR, clipId);

    console.log(`\nClip ${i+1}: [${h.start.toFixed(1)}-${h.end.toFixed(1)}s] "${h.title}"`);

    const { vfFilter, sendcmdFile } = await buildSmartCropArgs(
      videoPath, h.start, h.end, vw, vh, aspectRatio, clipTmpPath
    );
    if (sendcmdFile) sendcmdFiles.push(sendcmdFile);

    console.log(`  vf: ${vfFilter.slice(0, 80)}...`);

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
      duration: Math.round(h.end - h.start),
      viral_score: h.viral_score || 5,
      aspectRatio,
    });

    set({ progress: 75 + Math.floor((i + 1) / highlights.length * 20) });
  }

  // Cleanup
  try { await unlink(videoPath); await unlink(audioPath); } catch {}
  for (const f of sendcmdFiles) { try { await unlink(f); } catch {} }

  jobs.set(jobId, { jobId, status: 'done', progress: 100, clips, completedAt: Date.now() });
}

app.listen(PORT, () => console.log(`ClipThai backend listening on :${PORT}`));
