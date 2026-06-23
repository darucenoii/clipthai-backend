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

// ─── Player detection: find centroid of non-grass pixels (players, ball, goal) ─
// Returns [{t, cx_norm, cy_norm}] sampled every 0.25s
async function detectPlayerCentroids(videoPath, startTime, endTime, vw, vh) {
  return new Promise((resolve) => {
    const duration = Math.min(endTime - startTime, 45);
    // Scale down for speed, keep aspect ratio
    const scaleW = 160, scaleH = Math.round(160 * vh / vw);

    const proc = spawn('ffmpeg', [
      '-ss', String(startTime), '-t', String(duration),
      '-i', videoPath,
      '-vf', `scale=${scaleW}:${scaleH}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-r', '4', 'pipe:1'
    ]);

    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve([]));
    setTimeout(() => { proc.kill(); resolve([]); }, 25000);

    proc.on('close', () => {
      try {
        const fw = scaleW, fh = scaleH;
        const fsize = fw * fh * 3; // RGB
        const raw = Buffer.concat(chunks);
        const nFrames = Math.floor(raw.length / fsize);
        if (nFrames < 1) return resolve([]);

        const results = [];
        // Skip scoreboard: top 10% of frame
        const skipTop = Math.floor(fh * 0.10);

        for (let i = 0; i < nFrames; i++) {
          const base = i * fsize;
          let sumX = 0, sumY = 0, count = 0;

          for (let y = skipTop; y < fh; y++) {
            for (let x = 0; x < fw; x++) {
              const idx = base + (y * fw + x) * 3;
              const R = raw[idx], G = raw[idx+1], B = raw[idx+2];

              // Detect grass: high green, low red/blue relative to green
              // Grass hue ~100-140 deg in HSV, roughly G >> R and G >> B
              const isGrass = G > 80 && G > R * 1.3 && G > B * 1.15 && G < 210;

              if (!isGrass) {
                sumX += x;
                sumY += y;
                count++;
              }
            }
          }

          const cx_norm = count > 50 ? sumX / count / fw : 0.5;
          const cy_norm = count > 50 ? sumY / count / fh : 0.4;
          results.push({ t: startTime + i / 4, cx_norm, cy_norm });
        }

        resolve(results);
      } catch(e) {
        console.log('detectPlayerCentroids error:', e.message);
        resolve([]);
      }
    });
  });
}

function smooth(arr, w = 12) {
  return arr.map((_, i) => {
    const s = arr.slice(Math.max(0, i-w), i+w+1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
}

// ─── Smart crop: motion-based dynamic zoom + pan ────────────────────────────
async function buildSmartCrop(videoPath, startTime, endTime, vw, vh, aspectRatio, clipId) {
  const inputRatio = vw / vh;

  if (aspectRatio === '16:9') {
    if (Math.abs(inputRatio - 16/9) < 0.05) return { vf: 'scale=1280:720', scFile: null };
    const cropH = Math.floor(vw * 9/16);
    const cy    = Math.floor((vh - cropH) / 2);
    return { vf: `crop=${vw}:${cropH}:0:${cy},scale=1280:720`, scFile: null };
  }

  const outW = 720;
  const outH = aspectRatio === '9:16' ? 1280 : 720;

  // For 16:9 input: pre-crop to correct ratio based on aspectRatio
  let srcW = vw, srcH = vh, preCrop = '';
  if (inputRatio > 1.5) {
    if (aspectRatio === '9:16') {
      // 16:9 → take 9:16 center slice
      srcW = Math.floor(vh * 9/16);
      const preX = Math.floor((vw - srcW) / 2);
      preCrop = `crop=${srcW}:${srcH}:${preX}:0,`;
    } else if (aspectRatio === '1:1') {
      // 16:9 → take center square slice
      srcW = vh;
      const preX = Math.floor((vw - srcW) / 2);
      preCrop = `crop=${srcW}:${srcH}:${preX}:0,`;
    }
  }

  const raw = await analyzeMotionFrames(videoPath, startTime, endTime, srcW, srcH);

  if (raw.length < 3) {
    const cw = Math.floor(srcW / 1.3), ch = Math.floor(srcH / 1.3);
    const cx = Math.floor((srcW - cw) / 2), cy = Math.floor((srcH - ch) / 4);
    return { vf: `${preCrop}crop=${cw}:${ch}:${cx}:${cy},scale=${outW}:${outH}:flags=lanczos`, scFile: null };
  }

  const motion_s = smoothArr(raw.map(r => r.motion), 6);
  const cx_s     = smoothArr(raw.map(r => r.cx), 15);
  const cy_s     = smoothArr(raw.map(r => r.cy), 15);
  const maxM     = Math.max(...motion_s, 1);

  // Fixed zoom per clip based on average motion intensity
  const avgM  = motion_s.reduce((a,b) => a+b, 0) / motion_s.length;
  const ZOOM  = 1.0 + Math.min(0.6, (avgM / maxM) * 0.6);
  const cropW = Math.max(80, Math.floor(srcW / ZOOM));
  const cropH = Math.max(80, Math.floor(srcH / ZOOM));
  const maxX  = srcW - cropW;
  const maxY  = srcH - cropH;
  console.log(`  zoom=${ZOOM.toFixed(2)}x crop=${cropW}x${cropH}`);

  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    const cx_px = Math.max(0, Math.min(maxX, Math.floor(cx_s[i]*srcW - cropW/2)));
    const cy_px = Math.max(0, Math.min(maxY, Math.floor(cy_s[i]*srcH*0.82 - cropH/2)));
    const rel   = Math.max(0, raw[i].t - startTime);
    lines.push(`${rel.toFixed(3)} crop x ${cx_px};`);
    lines.push(`${rel.toFixed(3)} crop y ${cy_px};`);
  }

  const cx0 = Math.max(0, Math.min(maxX, Math.floor(cx_s[0]*srcW - cropW/2)));
  const cy0 = Math.max(0, Math.min(maxY, Math.floor(cy_s[0]*srcH*0.82 - cropH/2)));

  const scPath = path.join(TMP_DIR, `${clipId}_sc.txt`);
  await writeFile(scPath, lines.join('\n'));

  const vf = [
    preCrop + `sendcmd=f='${scPath}'`,
    `crop=${cropW}:${cropH}:${cx0}:${cy0}`,
    `scale=${outW}:${outH}:flags=lanczos`
  ].join(',');

  return { vf, scFile: scPath };
}

async function analyzeMotionFrames(videoPath, startTime, endTime, vw, vh) {
  return new Promise((resolve) => {
    const duration = Math.min(endTime - startTime, 45);
    const fw = 180, fh = Math.round(180*vh/vw);
    const proc = spawn('ffmpeg', [
      '-ss', String(startTime), '-t', String(duration),
      '-i', videoPath,
      '-vf', `scale=${fw}:${fh}`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-r', '10', 'pipe:1'
    ]);
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve([]));
    setTimeout(() => { proc.kill(); resolve([]); }, 25000);
    proc.on('close', () => {
      try {
        const fsize = fw * fh;
        const raw = Buffer.concat(chunks);
        const nFrames = Math.floor(raw.length / fsize);
        if (nFrames < 2) return resolve([]);
        const results = [];
        const skipY = Math.floor(fh * 0.08);
        for (let i = 1; i < nFrames; i++) {
          const prev = raw.slice((i-1)*fsize, i*fsize);
          const curr = raw.slice(i*fsize, (i+1)*fsize);
          const cols = new Float32Array(fw);
          const rows = new Float32Array(fh);
          let total = 0;
          for (let y = skipY; y < fh; y++) {
            for (let x = 0; x < fw; x++) {
              const d = Math.abs(curr[y*fw+x] - prev[y*fw+x]);
              cols[x] += d; rows[y] += d; total += d;
            }
          }
          const cx = total > 300 ? cols.reduce((s,v,x)=>s+v*x,0)/(total*fw) : 0.5;
          const cy = total > 300 ? rows.reduce((s,v,y)=>s+v*y,0)/(total*fh) : 0.4;
          results.push({ t: startTime + i/10, motion: total/fsize, cx, cy });
        }
        resolve(results);
      } catch(e) { resolve([]); }
    });
  });
}

function smoothArr(arr, w) {
  return arr.map((_, i) => {
    const s = arr.slice(Math.max(0,i-w), i+w+1);
    return s.reduce((a,b)=>a+b,0) / s.length;
  });
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
  let cookiesArg = [];
  const _cookiesB64 = process.env.YOUTUBE_COOKIES_BASE64;
  if (_cookiesB64 && _cookiesB64.length > 100) {
    try {
      const cookiesPath = '/tmp/yt_cookies.txt';
      const cookiesContent = Buffer.from(_cookiesB64.trim(), 'base64').toString('utf8');
      if (cookiesContent.length < 100) throw new Error('Decoded cookies too short');
      // Use sync write to ensure file exists before yt-dlp runs
      const { writeFileSync } = await import('node:fs');
      writeFileSync(cookiesPath, cookiesContent, 'utf8');
      // Verify file was written
      const { statSync } = await import('node:fs');
      const stat = statSync(cookiesPath);
      if (stat.size > 0) {
        cookiesArg = ['--cookies', cookiesPath];
        console.log('Cookies ready:', cookiesPath, stat.size, 'bytes');
      } else {
        throw new Error('Cookies file empty after write');
      }
    } catch(e) {
      console.log('Cookies setup failed:', e.message);
      cookiesArg = []; // ensure no broken path
    }
  } else {
    console.log('YOUTUBE_COOKIES_BASE64 not set or too short, skipping cookies');
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
