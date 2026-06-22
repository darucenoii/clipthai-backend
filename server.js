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

// Analyze where the action is in a 16:9 clip using motion vectors
// Returns x offset (0.0 = left edge, 1.0 = right edge) of action center
async function detectActionCenterX(videoPath, startTime, endTime) {
  return new Promise((resolve) => {
    const duration = Math.min(endTime - startTime, 10);
    // Sample frames and compute motion per horizontal zone (left/center/right thirds)
    const proc = spawn('ffmpeg', [
      '-ss', String(startTime),
      '-t', String(duration),
      '-i', videoPath,
      '-vf', 'select=not(mod(n\\,5)),scale=320:180,mestimate=method=epzs:mb_size=16,metadata=print:file=-',
      '-an', '-f', 'null', '/dev/null'
    ]);

    let output = '';
    proc.stderr.on('data', d => output += d.toString());
    proc.stdout.on('data', d => output += d.toString());

    proc.on('close', () => {
      // Parse motion vector data — count motion events per horizontal zone
      // Zone: left (x < 33%), center (33-66%), right (> 66%) of 320px wide = 106px each
      const lines = output.split('\n');
      let leftMotion = 0, centerMotion = 0, rightMotion = 0;
      let totalFrames = 0;

      for (const line of lines) {
        // Look for significant frame differences as proxy for motion zones
        const match = line.match(/mean=(\d+\.?\d*)/);
        if (match) {
          totalFrames++;
          const val = parseFloat(match[1]);
          // We use frame position metadata to guess zone — fallback: equal weight
          centerMotion += val;
        }
      }

      // Better approach: extract actual frames and compare horizontal strips
      resolve(0.5); // default center, will be refined below
    });

    proc.on('error', () => resolve(0.5));
    setTimeout(() => { proc.kill(); resolve(0.5); }, 15000);
  });
}

// Better: sample frames, compute per-column motion, find hottest horizontal band
async function findActionCropX(videoPath, startTime, endTime, inputW, inputH) {
  try {
    const duration = Math.min(endTime - startTime, 8);
    const sampleCount = 6;
    const framePaths = [];

    // Extract sample frames
    for (let i = 0; i < sampleCount; i++) {
      const t = startTime + (duration / sampleCount) * i + 0.5;
      const fp = path.join(TMP_DIR, `crop_sample_${Date.now()}_${i}.jpg`);
      await execFileAsync('ffmpeg', [
        '-ss', String(t), '-i', videoPath,
        '-frames:v', '1', '-vf', 'scale=160:90', '-q:v', '5', '-y', fp
      ], { timeout: 8000 });
      framePaths.push(fp);
    }

    // Use ffmpeg to compute difference between consecutive frames, get column sums
    // Simplified: use crop probing — test left/center/right crops and pick highest variance
    // This tells us which zone has most "interesting" content (players, ball, goal)

    const zones = [
      { name: 'left',   x: 0.0 },
      { name: 'center', x: 0.5 },
      { name: 'right',  x: 1.0 },
      { name: 'left-center',   x: 0.25 },
      { name: 'right-center',  x: 0.75 },
    ];

    const targetW = Math.floor(inputH * 9 / 16);
    const scores = [];

    for (const zone of zones) {
      const maxCx = inputW - targetW;
      const cx = Math.floor(zone.x * maxCx);
      let totalVariance = 0;

      for (const fp of framePaths) {
        try {
          // Crop zone and measure variance (higher variance = more action/detail)
          const result = await execFileAsync('ffmpeg', [
            '-i', fp,
            '-vf', `scale=${inputW}:${inputH},crop=${targetW}:${inputH}:${cx}:0,scale=80:45,signalstats`,
            '-f', 'null', '-'
          ], { timeout: 5000 }).catch(() => ({ stderr: '' }));

          const stderr = result.stderr || '';
          const varMatch = stderr.match(/YDIF=(\d+\.?\d*)/);
          if (varMatch) totalVariance += parseFloat(varMatch[1]);
        } catch {}
      }

      scores.push({ ...zone, score: totalVariance });
    }

    // Cleanup frames
    for (const fp of framePaths) { try { await unlink(fp); } catch {} }

    // Pick zone with highest variance score
    scores.sort((a, b) => b.score - a.score);
    console.log(`Crop zone scores: ${scores.map(z => `${z.name}=${z.score.toFixed(0)}`).join(', ')}`);
    console.log(`Best zone: ${scores[0].name} (x=${scores[0].x})`);

    return scores[0].x;

  } catch (err) {
    console.log(`findActionCropX failed: ${err.message.slice(0, 60)}, using center`);
    return 0.5;
  }
}

// Build smart crop filter for 16:9 → 9:16
// actionX: 0.0=left, 0.5=center, 1.0=right
function buildSmartCropFilter(vw, vh, actionX) {
  const targetW = Math.floor(vh * 9 / 16);

  if (targetW > vw) {
    // Input is already narrower than 9:16, just scale
    return `scale=720:1280:flags=lanczos`;
  }

  const maxCx = vw - targetW;
  
  // Clamp so crop doesn't go out of bounds
  // Add slight inward bias to avoid cutting off players at edges
  const biasedX = Math.max(0.1, Math.min(0.9, actionX));
  const cx = Math.floor(biasedX * maxCx);

  console.log(`Smart crop: input=${vw}x${vh}, cropW=${targetW}, cx=${cx} (actionX=${actionX.toFixed(2)})`);

  return `crop=${targetW}:${vh}:${cx}:0,scale=720:1280:flags=lanczos`;
}

function buildVfFilter(aspectRatio, vw, vh, actionX = 0.5) {
  const inputRatio = vw / vh;

  if (aspectRatio === '16:9') {
    if (Math.abs(inputRatio - 16/9) < 0.05) return `scale=1280:720`;
    const cropH = Math.floor(vw * 9 / 16);
    if (cropH <= vh) {
      const cy = Math.floor((vh - cropH) / 2);
      return `crop=${vw}:${cropH}:0:${cy},scale=1280:720`;
    }
    const cropW = Math.floor(vh * 16 / 9);
    const maxCx = vw - cropW;
    const cx = Math.floor(actionX * maxCx);
    return `crop=${cropW}:${vh}:${cx}:0,scale=1280:720`;

  } else if (aspectRatio === '1:1') {
    if (Math.abs(inputRatio - 1) < 0.05) return `scale=720:720`;
    const size = Math.min(vw, vh);
    const maxCx = vw - size;
    const cx = Math.floor(actionX * maxCx);
    const cy = Math.floor((vh - size) / 2);
    return `crop=${size}:${size}:${cx}:${cy},scale=720:720`;

  } else {
    // 9:16 output
    if (Math.abs(inputRatio - 9/16) < 0.02) {
      // Already 9:16 — just scale, no crop needed
      return `scale=720:1280:flags=lanczos`;
    }
    // 16:9 or wider → smart crop to 9:16
    return buildSmartCropFilter(vw, vh, actionX);
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

    // Find where the action is for this specific clip segment
    let actionX = 0.5; // default center
    const inputRatio = vw / vh;
    const needs916Crop = aspectRatio === '9:16' && Math.abs(inputRatio - 9/16) > 0.02;

    if (needs916Crop) {
      console.log(`Clip ${i+1}: detecting action zone for smart crop...`);
      actionX = await findActionCropX(videoPath, h.start, h.end, vw, vh);
    }

    const vfFilter = buildVfFilter(aspectRatio, vw, vh, actionX);
    console.log(`Clip ${i+1} [${h.start}-${h.end}s] actionX=${actionX.toFixed(2)} vf=${vfFilter}`);

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
      cropInfo: { actionX: actionX.toFixed(2) },
    });

    set({ progress: 75 + Math.floor((i + 1) / highlights.length * 20) });
  }

  try { await unlink(videoPath); await unlink(audioPath); } catch {}
  jobs.set(jobId, { jobId, status: 'done', progress: 100, clips, completedAt: Date.now() });
}

app.listen(PORT, () => console.log(`ClipThai backend listening on :${PORT}`));
