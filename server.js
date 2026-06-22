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

// ─── Video info ────────────────────────────────────────────────────────────────
async function getVideoDimensions(videoPath) {
  try {
    const r = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'csv=p=0', videoPath
    ]);
    const parts = (r.stdout || '1280,720,30/1').trim().split(',');
    const w = parseInt(parts[0]) || 1280;
    const h = parseInt(parts[1]) || 720;
    const fp = parts[2] || '30/1';
    const fps = Math.round(parseInt(fp) / (parseInt(fp.split('/')[1]) || 1)) || 30;
    return { width: w, height: h, fps };
  } catch { return { width: 1280, height: 720, fps: 30 }; }
}

// ─── Motion analysis: find where the action is per frame ──────────────────────
// Samples the clip at 5fps, returns [{t, cx_norm, motion_score}]
// cx_norm: 0.0=left edge, 1.0=right edge of frame
async function analyzeMotion(videoPath, startTime, endTime, vw, vh) {
  return new Promise((resolve) => {
    const duration = Math.min(endTime - startTime, 45);
    // Skip scoreboard (top 13%) for motion analysis
    const roiY = Math.round(vh * 0.13);
    const roiH = vh - roiY;

    const proc = spawn('ffmpeg', [
      '-ss', String(startTime), '-t', String(duration),
      '-i', videoPath,
      '-vf', `crop=${vw}:${roiH}:0:${roiY},scale=160:${Math.round(160*roiH/vw)}`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-r', '5', 'pipe:1'
    ]);

    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve([]));
    setTimeout(() => { proc.kill(); resolve([]); }, 25000);

    proc.on('close', () => {
      try {
        const fw = 160;
        const fh = Math.round(160 * roiH / vw);
        const fsize = fw * fh;
        const raw = Buffer.concat(chunks);
        const nFrames = Math.floor(raw.length / fsize);
        if (nFrames < 2) return resolve([]);

        const results = [];
        for (let i = 1; i < nFrames; i++) {
          const prev = raw.slice((i-1)*fsize, i*fsize);
          const curr = raw.slice(i*fsize, (i+1)*fsize);

          const cols = new Float32Array(fw);
          let total = 0;
          for (let y = 0; y < fh; y++) {
            for (let x = 0; x < fw; x++) {
              const d = Math.abs(curr[y*fw+x] - prev[y*fw+x]);
              cols[x] += d;
              total += d;
            }
          }

          const cx_norm = total > 300
            ? (cols.reduce((s,v,x) => s + v*x, 0) / total) / fw
            : 0.5;
          const motion_score = total / fsize;

          results.push({ t: startTime + i/5, cx_norm, motion_score });
        }
        resolve(results);
      } catch(e) { resolve([]); }
    });
  });
}

// Moving average smoother
function smooth(arr, w = 12) {
  return arr.map((_, i) => {
    const s = arr.slice(Math.max(0, i-w), i+w+1);
    return s.reduce((a,b) => a+b, 0) / s.length;
  });
}

// ─── Smart crop: 16:9 → 9:16 with dynamic pan + zoom ─────────────────────────
//
// Zoom logic (relative to full-height 9:16 window):
//   motion low  → zoom 1.0x (show full pitch width in 9:16)
//   motion high → zoom 1.4x (tighter on action)
//
// Pan: follows motion centroid X, smoothed to avoid jitter
//
async function buildSmartCrop(videoPath, startTime, endTime, vw, vh, aspectRatio, clipId) {
  const inputRatio = vw / vh;

  // Already 9:16 — just scale
  if (aspectRatio !== '9:16' || Math.abs(inputRatio - 9/16) < 0.05) {
    if (aspectRatio === '16:9') return { vf: `scale=1280:720`, scFile: null };
    if (aspectRatio === '1:1')  return { vf: `crop=${Math.min(vw,vh)}:${Math.min(vw,vh)}:${Math.floor((vw-Math.min(vw,vh))/2)}:0,scale=720:720`, scFile: null };
    return { vf: `scale=720:1280:flags=lanczos`, scFile: null };
  }

  // 16:9 → 9:16
  // base crop window: full height, 9:16 width
  // e.g. 1080p: 607x1080, 720p: 405x720, 360p: 202x360
  const baseCropW = Math.floor(vh * 9 / 16);
  const cropY     = Math.floor(vh * 0.13);   // skip scoreboard
  const cropH     = vh - cropY;              // usable height

  console.log(`  Smart crop: ${vw}x${vh} baseCropW=${baseCropW} cropH=${cropH}`);

  const raw = await analyzeMotion(videoPath, startTime, endTime, vw, vh);

  // Fallback: static center crop
  if (raw.length < 3) {
    const cx = Math.floor((vw - baseCropW) / 2);
    return { vf: `crop=${baseCropW}:${cropH}:${cx}:${cropY},scale=720:1280:flags=lanczos`, scFile: null };
  }

  const cx_smooth     = smooth(raw.map(r => r.cx_norm), 12);
  const motion_smooth = smooth(raw.map(r => r.motion_score), 15);

  // Zoom range: 1.0x – 1.4x only (safe for any resolution)
  // 1.0x = baseCropW (widest), 1.4x = baseCropW/1.4 (tightest)
  const MIN_ZOOM = 1.0, MAX_ZOOM = 1.4;
  // Normalize motion to zoom
  const maxMotion = Math.max(...motion_smooth, 1);
  const zoom_arr  = motion_smooth.map(m =>
    MIN_ZOOM + (Math.min(m, maxMotion*0.7) / (maxMotion*0.7)) * (MAX_ZOOM - MIN_ZOOM)
  );
  const zoom_smooth = smooth(zoom_arr, 15);

  // Build sendcmd keyframes
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    const zoom = zoom_smooth[i];
    const cw   = Math.max(Math.floor(baseCropW * 0.7), Math.floor(baseCropW / zoom));
    const maxX = vw - cw;
    const cx   = Math.max(0, Math.min(maxX, Math.floor(cx_smooth[i] * vw - cw/2)));
    const rel  = Math.max(0, raw[i].t - startTime);
    lines.push(`${rel.toFixed(3)} crop x ${cx};`);
    lines.push(`${rel.toFixed(3)} crop w ${cw};`);
  }

  // Initial values from first frame
  const z0  = zoom_smooth[0];
  const cw0 = Math.max(Math.floor(baseCropW * 0.7), Math.floor(baseCropW / z0));
  const cx0 = Math.max(0, Math.min(vw - cw0, Math.floor(cx_smooth[0] * vw - cw0/2)));

  const avgZoom = zoom_smooth.reduce((a,b)=>a+b,0)/zoom_smooth.length;
  const avgCx   = cx_smooth.reduce((a,b)=>a+b,0)/cx_smooth.length;
  console.log(`  avg_zoom=${avgZoom.toFixed(2)}x  avg_cx=${avgCx.toFixed(2)}  samples=${raw.length}`);

  const scPath = path.join(TMP_DIR, `${clipId}_sc.txt`);
  await writeFile(scPath, lines.join('\n'));

  const vf = [
    `sendcmd=f='${scPath}'`,
    `crop=${cw0}:${cropH}:${cx0}:${cropY}`,
    `scale=720:1280:flags=lanczos`
  ].join(',');

  return { vf, scFile: scPath };
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
  processMode1(jobId, youtubeUrl || videoUrl, aspectRatio).catch(err =>
    jobs.set(jobId, { jobId, status: 'failed', error: err.message, clips: [], failedAt: Date.now() })
  );
});

async function ytdlpDownload(url, outputPath) {
  // Auto-update yt-dlp to handle YouTube API changes
  try { await execFileAsync('yt-dlp', ['-U'], { timeout: 30000 }); console.log('yt-dlp updated'); }
  catch { console.log('yt-dlp update skipped'); }

  const base = ['--no-playlist', '--no-check-certificate', '--socket-timeout', '30', '--retries', '3', '--output', outputPath];
  const strategies = [
    // Strategy 1: android + 1080p
    ['--extractor-args', 'youtube:player_client=android',
     '--format', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best',
     '--merge-output-format', 'mp4', ...base, url],
    // Strategy 2: ios client
    ['--extractor-args', 'youtube:player_client=ios',
     '--format', 'best[ext=mp4][height<=1080]/best[ext=mp4][height<=720]/best',
     ...base, url],
    // Strategy 3: tv_embedded (bypasses some restrictions)
    ['--extractor-args', 'youtube:player_client=tv_embedded',
     '--format', 'best[height<=1080]/best[height<=720]/best',
     ...base, url],
    // Strategy 4: web last resort
    ['--format', 'best[height<=720]/best', ...base, url],
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
      { role: 'system', content: `You are a viral sports video editor. Pick 3-5 best highlight clips.
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
    if (h.end - h.start < 6)  h.end = h.start + 6;
    if (h.end - h.start > 45) h.end = h.start + 45;
    h.end = h.end + 2;
    return h;
  });

  set({ progress: 75, step: 'cutting_clips' });
  const clips = [];
  const scFiles = [];

  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    const clipId   = `${jobId}_clip${i+1}`;
    const clipPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);
    console.log(`\nClip ${i+1}: [${h.start.toFixed(1)}-${h.end.toFixed(1)}s] "${h.title}"`);

    const { vf, scFile } = await buildSmartCrop(
      videoPath, h.start, h.end, vw, vh, aspectRatio, clipId
    );
    if (scFile) scFiles.push(scFile);

    await execFileAsync('ffmpeg', [
      '-i', videoPath,
      '-ss', String(h.start), '-to', String(h.end),
      '-vf', vf,
      '-c:v', 'libx264', '-c:a', 'aac',
      '-preset', 'fast', '-crf', '23',
      '-movflags', '+faststart',
      '-y', clipPath
    ], { timeout: 180000 });

    clips.push({
      url: `${PUBLIC_BASE_URL}/outputs/${clipId}.mp4`,
      title: h.title || `Clip ${i+1}`,
      keyword: h.keyword || '',
      start: h.start, end: h.end,
      duration: Math.round(h.end - h.start),
      viral_score: h.viral_score || 5,
      aspectRatio,
    });

    set({ progress: 75 + Math.floor((i+1) / highlights.length * 20) });
  }

  try { await unlink(videoPath); await unlink(audioPath); } catch {}
  for (const f of scFiles) { try { await unlink(f); } catch {} }

  jobs.set(jobId, { jobId, status: 'done', progress: 100, clips, completedAt: Date.now() });
}

app.listen(PORT, () => console.log(`ClipThai backend listening on :${PORT}`));
