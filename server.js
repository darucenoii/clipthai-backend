import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import OpenAI from 'openai';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const OUTPUT_DIR = path.join(__dirname, 'public', 'outputs');
const TEMP_DIR = path.join(__dirname, 'tmp');

await mkdir(OUTPUT_DIR, { recursive: true });
await mkdir(TEMP_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const jobs = new Map();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/outputs', express.static(OUTPUT_DIR));

// ---------- HEALTH ----------
app.get('/', (req, res) => res.json({ status: 'ClipThai backend running', version: '4.0.0' }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ---------- STATUS ----------
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ jobId: req.params.jobId, ...job });
});

// ---------- HELPERS ----------
function runJob(jobId, fn) {
  jobs.set(jobId, { status: 'processing', progress: 0, clips: [], createdAt: Date.now() });
  (async () => {
    try {
      const clips = await fn((progress) => {
        const current = jobs.get(jobId);
        jobs.set(jobId, { ...current, progress });
      });
      jobs.set(jobId, { status: 'completed', progress: 100, clips, completedAt: Date.now() });
    } catch (err) {
      console.error(`[${jobId}]`, err);
      jobs.set(jobId, { status: 'failed', error: err.message, clips: [], failedAt: Date.now() });
    }
  })();
}

async function downloadYouTube(url, outputPath) {
  console.log(`Downloading YouTube: ${url}`);
  await execAsync(`yt-dlp -f "best[ext=mp4]/best" -o "${outputPath}" "${url}" --no-playlist`);
}

async function extractAudio(videoPath, audioPath) {
  await execAsync(`ffmpeg -i "${videoPath}" -vn -ar 16000 -ac 1 -c:a pcm_s16le "${audioPath}" -y`);
}

async function transcribeAudio(audioPath) {
  const { createReadStream } = await import('fs');
  const transcription = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: 'whisper-1',
    language: 'th',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });
  return transcription;
}

async function findHighlights(transcription, videoDuration) {
  const segments = transcription.segments || [];
  const segmentText = segments.map(s => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s]: ${s.text}`).join('\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `วิเคราะห์ transcript นี้และเลือกช่วงที่น่าสนใจที่สุด 3-8 ช่วง
แต่ละช่วงความยาว 10-30 วินาที เน้นช่วงที่:
- มีข้อมูลสำคัญ
- น่าตื่นเต้นหรือน่าสนใจ
- เป็น highlight หรือ key moment

Transcript:
${segmentText}

ตอบเป็น JSON array เท่านั้น ไม่มีข้อความอื่น:
[
  {
    "start": 0.0,
    "end": 25.0,
    "title": "ชื่อสั้นๆ ภาษาไทย",
    "keyword": "คำสำคัญ",
    "viral_score": 8
  }
]`,
    }],
  });

  const text = response.choices[0].message.content.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function cutClip(videoPath, start, end, outputPath) {
  const duration = end - start;
  await execAsync(`ffmpeg -ss ${start} -i "${videoPath}" -t ${duration} -c:v libx264 -c:a aac -movflags +faststart "${outputPath}" -y`);
}

// ---------- MODE 1 — ตัดซอยคลิปไฮไลท์ ----------
app.post('/mode1', async (req, res) => {
  try {
    const { videoUrl, youtubeUrl, language = 'th' } = req.body;
    if (!videoUrl && !youtubeUrl) {
      return res.status(400).json({ error: 'Missing videoUrl or youtubeUrl' });
    }

    const jobId = `mode1_${randomUUID()}`;
    res.json({ jobId });

    runJob(jobId, async (setProgress) => {
      const videoPath = path.join(TEMP_DIR, `${jobId}.mp4`);
      const audioPath = path.join(TEMP_DIR, `${jobId}.wav`);

      // Step 1: Download video
      setProgress(10);
      if (youtubeUrl) {
        await downloadYouTube(youtubeUrl, videoPath);
      } else {
        const { default: fetch } = await import('node-fetch');
        const response = await fetch(videoUrl);
        const buffer = Buffer.from(await response.arrayBuffer());
        await writeFile(videoPath, buffer);
      }

      // Step 2: Extract audio
      setProgress(25);
      await extractAudio(videoPath, audioPath);

      // Step 3: Transcribe
      setProgress(40);
      const transcription = await transcribeAudio(audioPath);

      // Step 4: Find highlights
      setProgress(60);
      const highlights = await findHighlights(transcription);

      // Step 5: Cut clips
      setProgress(70);
      const clips = [];
      for (let i = 0; i < highlights.length; i++) {
        const h = highlights[i];
        const clipId = `${jobId}_clip${i + 1}`;
        const clipPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);
        await cutClip(videoPath, h.start, h.end, clipPath);
        clips.push({
          url: `${PUBLIC_BASE_URL}/outputs/${clipId}.mp4`,
          title: h.title || `Clip ${i + 1}`,
          keyword: h.keyword || '',
          start: h.start,
          end: h.end,
          duration: h.end - h.start,
          viral_score: h.viral_score || 5,
        });
        setProgress(70 + Math.floor((i + 1) / highlights.length * 25));
      }

      // Cleanup temp files
      try {
        await unlink(videoPath);
        await unlink(audioPath);
      } catch {}

      return clips;
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- START ----------
app.listen(PORT, () => console.log(`ClipThai backend listening on :${PORT}`));
