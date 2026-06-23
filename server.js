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

// ─── Motion-based crop: find action column X, fixed Y bias ─────────────────────
// Strategy:
//   1. Sample frames at 5fps, diff consecutive frames → per-column motion sum
//   2. Smooth cx over time (window=15) to avoid jitter
//   3. Y: fixed bias — always crop from y=10% to y=72% (removes scoreboard + empty grass)
//   4. Zoom: 1.3x for 9:16 portrait, 1.5x for 1:1 square

async function analyzeMotionCx(videoPath, startTime, endTime, vw, vh) {
  return new Promise((resolve) => {
    const duration = Math.min(endTime - startTime, 45);
    const y1 = Math.round(vh * 0.10);
    const y2 = Math.round(vh * 0.72);
    const roiH = y2 - y1;

    const proc = spawn('ffmpeg', [
      '-ss', String(startTime), '-t', String(duration),
      '-i', videoPath,
      '-vf', `crop=${vw}:${roiH}:0:${y1},scale=160:${Math.round(160*roiH/vw)}`,
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
            ? cols.reduce((s,v,x) => s + v*x, 0) / (total * fw)
            : 0.5;
          results.push({ t: startTime + i/5, cx_norm });
        }
        resolve(results);
      } catch(e) { resolve([]); }
    });
  });
}

function smooth(arr, w = 15) {
  return arr.map((_, i) => {
    const s = arr.slice(Math.max(0, i-w), i+w+1);
    return s.reduce((a,b) => a+b, 0) / s.length;
  });
}

// ─── Smart crop: motion X pan + fixed Y bias + zoom ──────────────────────────
async function buildSmartCrop(videoPath, startTime, endTime, vw, vh, aspectRatio, clipId) {
  const inputRatio = vw / vh;

  // 16:9 output: simple letterbox crop
  if (aspectRatio === '16:9') {
    if (Math.abs(inputRatio - 16/9) < 0.05) return { vf: 'scale=1280:720', scFile: null };
    const cropH = Math.floor(vw * 9/16);
    const cy = Math.floor((vh - cropH) / 2);
    return { vf: `crop=${vw}:${cropH}:0:${cy},scale=1280:720`, scFile: null };
  }

  // Output dimensions
  const outW = 720;
  const outH = aspectRatio === '9:16' ? 1280 : 720;

  // Fixed Y: always crop action zone — skip scoreboard top 10%, skip empty grass bottom 28%
  const y1    = Math.round(vh * 0.10);
  const y2    = Math.round(vh * 0.72);
  const cropH = y2 - y1;  // 62% of frame height

  // Zoom: 1.3x for portrait 9:16, 1.5x for square 1:1
  const ZOOM = aspectRatio === '9:16' ? 1.3 : 1.5;

  // Crop width: for 9:16 output use 9:16 ratio of cropH, for 1:1 use cropH
  const baseCropW = aspectRatio === '9:16'
    ? Math.floor(cropH * 9 / 16)
    : cropH;
  const cropW = Math.max(60, Math.floor(baseCropW / ZOOM));
  const maxCx = vw - cropW;

  console.log(`  Crop: ${vw}x${vh} → ${cropW}x${cropH} at y=${y1} zoom=${ZOOM}x → ${outW}x${outH}`);

  // Analyze motion to find action column X
  const raw = await analyzeMotionCx(videoPath, startTime, endTime, vw, vh);

  // Fallback: center crop
  if (raw.length < 3) {
    const cx = Math.floor(maxCx / 2);
    return { vf: `crop=${cropW}:${cropH}:${cx}:${y1},scale=${outW}:${outH}:flags=lanczos`, scFile: null };
  }

  const cx_s = smooth(raw.map(r => r.cx_norm), 15);
  const avgCx = cx_s.reduce((a,b)=>a+b,0)/cx_s.length;
  console.log(`  Motion cx avg=${avgCx.toFixed(2)} samples=${raw.length}`);

  // Build sendcmd for smooth X pan
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    const cx = Math.max(0, Math.min(maxCx, Math.floor(cx_s[i]*vw - cropW/2)));
    const rel = Math.max(0, raw[i].t - startTime);
    lines.push(`${rel.toFixed(3)} crop x ${cx};`);
  }

  const cx0 = Math.max(0, Math.min(maxCx, Math.floor(cx_s[0]*vw - cropW/2)));
  const scPath = path.join(TMP_DIR, `${clipId}_sc.txt`);
  await writeFile(scPath, lines.join('\n'));

  const vf = [
    `sendcmd=f='${scPath}'`,
    `crop=${cropW}:${cropH}:${cx0}:${y1}`,
    `scale=${outW}:${outH}:flags=lanczos`
  ].join(',');

  return { vf, scFile: scPath };
}

// ─── Express ──────────────────────────────────────────────────────────────────
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
  // Auto-update yt-dlp
  try { await execFileAsync('yt-dlp', ['-U'], { timeout: 30000 }); console.log('yt-dlp updated'); }
  catch { console.log('yt-dlp update skipped'); }

  // Write cookies file from env variable if available
  // Write cookies file from env variable
  let cookiesArg = [];
  const cookiesB64 = process.env.YOUTUBE_COOKIES_BASE64;
  if (cookiesB64 && cookiesB64.length > 100) {
    try {
      const cookiesPath = '/tmp/yt_cookies.txt';
      const cookiesContent = Buffer.from(cookiesB64.trim(), 'base64').toString('utf8');
      await writeFile(cookiesPath, cookiesContent, 'utf8');
      cookiesArg = ['--cookies', cookiesPath];
      console.log('Using YouTube cookies, size:', cookiesContent.length);
    } catch(e) { console.log('Cookies setup failed:', e.message); }
  } else {
    console.log('No cookies env var, skipping');
  }

  const base = ['--no-playlist', '--no-check-certificate', '--socket-timeout', '30', '--retries', '3', '--output', outputPath, ...cookiesArg];
  const strategies = [
    ['--extractor-args', 'youtube:player_client=android',
     '--format', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best',
     '--merge-output-format', 'mp4', ...base, url],
    ['--extractor-args', 'youtube:player_client=ios',
     '--format', 'best[ext=mp4][height<=1080]/best[ext=mp4][height<=720]/best', ...base, url],
    ['--extractor-args', 'youtube:player_client=tv_embedded',
     '--format', 'best[height<=1080]/best[height<=720]/best', ...base, url],
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

  const { width: vw, height: vh } = await getVideoDimensions(videoPath);
  console.log(`Video: ${vw}x${vh}`);

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
RULES: min 6s, max 45s per clip. End at natural stopping point. Start 1-2s before action.
Return JSON: {"highlights":[{"start":0,"end":30,"title":"...","keyword":"...","viral_score":8}]}` },
      { role: 'user', content: `Find highlights:\n${segText}` }
    ],
    max_tokens: 1000,
  });

  let { highlights = [] } = JSON.parse(gptRes.choices[0].message.content);
  highlights = highlights.map(h => {
    if (h.end - h.start < 6)  h.end = h.start + 6;
    if (h.end - h.start > 45) h.end = h.start + 45;
    h.end += 2;
    return h;
  });

  set({ progress: 75, step: 'cutting_clips' });
  const clips = [], scFiles = [];

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
      '-movflags', '+faststart', '-y', clipPath
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
