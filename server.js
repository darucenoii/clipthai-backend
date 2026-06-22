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

// ─── Smart crop: zoom + pan XY following players ──────────────────────────────
async function buildSmartCrop(videoPath, startTime, endTime, vw, vh, aspectRatio, clipId) {
  const inputRatio = vw / vh;

  // Non 9:16 outputs: simple crop
  if (aspectRatio === '16:9') {
    if (Math.abs(inputRatio - 16/9) < 0.05) return { vf: 'scale=1280:720', scFile: null };
    const cropH = Math.floor(vw * 9/16);
    const cy = Math.floor((vh - cropH) / 2);
    return { vf: `crop=${vw}:${cropH}:0:${cy},scale=1280:720`, scFile: null };
  }
  if (aspectRatio === '1:1') {
    const s = Math.min(vw, vh);
    return { vf: `crop=${s}:${s}:${Math.floor((vw-s)/2)}:0,scale=720:720`, scFile: null };
  }

  // ── 9:16 output ──────────────────────────────────────────────────────────────
  // Two cases:
  // A) Input is 16:9 (e.g. 1920x1080, 1280x720, 640x360) → crop 9:16 window + zoom
  // B) Input is already 9:16 (e.g. 720x1280) → zoom + pan XY only

  const is169  = inputRatio > 1.5;    // 16:9 or wider
  const is916  = Math.abs(inputRatio - 9/16) < 0.05;

  console.log(`  Input: ${vw}x${vh} ratio=${inputRatio.toFixed(2)} is169=${is169} is916=${is916}`);

  // Detect where players actually are
  const raw = await detectPlayerCentroids(videoPath, startTime, endTime, vw, vh);

  if (raw.length < 3) {
    // Fallback: static crop
    if (is169) {
      const cw = Math.floor(vh * 9/16);
      const cx = Math.floor((vw - cw) / 2);
      return { vf: `crop=${cw}:${vh}:${cx}:0,scale=720:1280:flags=lanczos`, scFile: null };
    }
    return { vf: 'scale=720:1280:flags=lanczos', scFile: null };
  }

  const cx_s = smooth(raw.map(r => r.cx_norm), 15);
  const cy_s = smooth(raw.map(r => r.cy_norm), 15);
  const avgCx = cx_s.reduce((a,b)=>a+b,0)/cx_s.length;
  const avgCy = cy_s.reduce((a,b)=>a+b,0)/cy_s.length;
  console.log(`  Player centroid: cx=${avgCx.toFixed(2)} cy=${avgCy.toFixed(2)}`);

  // Zoom 1.5x — enough to remove empty space, not too tight
  const ZOOM = 1.5;

  let outW, outH, cropW, cropH, lines, cw0, ch0, cx0, cy0;

  if (is169) {
    // 16:9 → 9:16: first pick 9:16 window, then zoom
    const base9_16W = Math.floor(vh * 9 / 16);
    cropW = Math.floor(base9_16W / ZOOM);
    cropH = Math.floor(vh / ZOOM);
    outW = 720; outH = 1280;

    lines = [];
    for (let i = 0; i < raw.length; i++) {
      const maxX = vw - cropW, maxY = vh - cropH;
      const cx = Math.max(0, Math.min(maxX, Math.floor(cx_s[i]*vw - cropW/2)));
      const cy = Math.max(0, Math.min(maxY, Math.floor(cy_s[i]*vh - cropH/2)));
      const rel = Math.max(0, raw[i].t - startTime);
      lines.push(`${rel.toFixed(3)} crop x ${cx};`);
      lines.push(`${rel.toFixed(3)} crop y ${cy};`);
    }
    cx0 = Math.max(0, Math.min(vw-cropW, Math.floor(cx_s[0]*vw - cropW/2)));
    cy0 = Math.max(0, Math.min(vh-cropH, Math.floor(cy_s[0]*vh - cropH/2)));
    cw0 = cropW; ch0 = cropH;

  } else {
    // Already 9:16: zoom + pan XY
    cropW = Math.floor(vw / ZOOM);
    cropH = Math.floor(vh / ZOOM);
    outW = vw; outH = vh;

    lines = [];
    for (let i = 0; i < raw.length; i++) {
      const maxX = vw - cropW, maxY = vh - cropH;
      const cx = Math.max(0, Math.min(maxX, Math.floor(cx_s[i]*vw - cropW/2)));
      const cy = Math.max(0, Math.min(maxY, Math.floor(cy_s[i]*vh - cropH/2)));
      const rel = Math.max(0, raw[i].t - startTime);
      lines.push(`${rel.toFixed(3)} crop x ${cx};`);
      lines.push(`${rel.toFixed(3)} crop y ${cy};`);
    }
    cx0 = Math.max(0, Math.min(vw-cropW, Math.floor(cx_s[0]*vw - cropW/2)));
    cy0 = Math.max(0, Math.min(vh-cropH, Math.floor(cy_s[0]*vh - cropH/2)));
    cw0 = cropW; ch0 = cropH;
  }

  const scPath = path.join(TMP_DIR, `${clipId}_sc.txt`);
  await writeFile(scPath, lines.join('\n'));

  const vf = [
    `sendcmd=f='${scPath}'`,
    `crop=${cw0}:${ch0}:${cx0}:${cy0}`,
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
