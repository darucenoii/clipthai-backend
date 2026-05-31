import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const OUTPUT_DIR = path.join(__dirname, 'public', 'outputs');

await mkdir(OUTPUT_DIR, { recursive: true });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/outputs', express.static(OUTPUT_DIR));

const jobs = new Map();

// ---------- HELPERS ----------
function toStr(val) {
  if (!val) return '';
  return Array.isArray(val) ? val[0] || '' : val;
}

async function generateTTS(text, voiceId) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.4, use_speaker_boost: true },
      }),
    }
  );
  if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function renderRemotion(compositionId, inputProps, jobId) {
  const bundleLocation = await bundle({
    entryPoint: path.join(__dirname, 'remotion', 'src', 'index.ts'),
    webpackOverride: (c) => c,
  });
  const composition = await selectComposition({ serveUrl: bundleLocation, id: compositionId, inputProps });
  const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  await renderMedia({
    composition: { ...composition, width: 1080, height: 1920, fps: 30 },
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps,
  });
  return `${PUBLIC_BASE_URL}/outputs/${jobId}.mp4`;
}

function runJob(jobId, fn) {
  jobs.set(jobId, { status: 'processing', progress: 0, createdAt: Date.now() });
  (async () => {
    try {
      const outputUrl = await fn();
      jobs.set(jobId, { status: 'completed', progress: 100, outputUrl, completedAt: Date.now() });
    } catch (err) {
      console.error(`[${jobId}]`, err);
      jobs.set(jobId, { status: 'failed', error: err.message, failedAt: Date.now() });
    }
  })();
}

// ---------- HEALTH ----------
app.get('/', (req, res) => res.json({ status: 'ClipThai backend running', version: '3.0.0' }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ---------- STATUS ----------
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ jobId: req.params.jobId, ...job });
});

// ---------- MODE 1 ----------
app.post('/mode1', async (req, res) => {
  try {
    const { videoUrl, language = 'th' } = req.body;
    if (!videoUrl) return res.status(400).json({ error: 'Missing videoUrl' });
    const jobId = `mode1_${randomUUID()}`;
    res.json({ jobId });
    runJob(jobId, async () => {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: `วิดีโอ: ${videoUrl}\nเลือก 3 ช่วงที่น่าสนใจ 20-45 วินาที ตอบเป็น JSON array: [{"start":0,"end":30,"reason":"..."}]` }],
      });
      return `${PUBLIC_BASE_URL}/outputs/${jobId}_result.json`;
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- MODE 2 ----------
app.post('/mode2', async (req, res) => {
  try {
    const { scriptText, voiceId, footageUrls, productName, price } = req.body;
    if (!scriptText || !voiceId) return res.status(400).json({ error: 'Missing scriptText or voiceId' });
    const jobId = `mode2_${randomUUID()}`;
    res.json({ jobId });
    runJob(jobId, async () => {
      const audioBuffer = await generateTTS(scriptText, voiceId);
      const audioPath = path.join(OUTPUT_DIR, `${jobId}.mp3`);
      await writeFile(audioPath, audioBuffer);
      const audioUrl = `${PUBLIC_BASE_URL}/outputs/${jobId}.mp3`;
      const urls = Array.isArray(footageUrls) ? footageUrls : [footageUrls].filter(Boolean);
      return await renderRemotion('review-clip', { audioUrl, footageUrls: urls, scriptText, productName: productName || '', price: price || '', captionStyle: 'review' }, jobId);
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- MODE 3 ----------
app.post('/mode3', async (req, res) => {
  try {
    const { scriptText, voiceId, footageUrls, productName, price, platform, cta } = req.body;
    if (!scriptText || !voiceId) return res.status(400).json({ error: 'Missing scriptText or voiceId' });
    const jobId = `mode3_${randomUUID()}`;
    res.json({ jobId });
    runJob(jobId, async () => {
      const audioBuffer = await generateTTS(scriptText, voiceId);
      const audioPath = path.join(OUTPUT_DIR, `${jobId}.mp3`);
      await writeFile(audioPath, audioBuffer);
      const audioUrl = `${PUBLIC_BASE_URL}/outputs/${jobId}.mp3`;
      const urls = Array.isArray(footageUrls) ? footageUrls : [footageUrls].filter(Boolean);
      return await renderRemotion('hybrid-clip', { audioUrl, footageUrls: urls, scriptText, productName: productName || '', price: price || '', platform: platform || 'tiktok', cta: cta || '', showPriceOverlay: true }, jobId);
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- MODE 5 ----------
app.post('/mode5', async (req, res) => {
  try {
    const { keyword, footage, imageUrls, videoUrls, bgm } = req.body;
    if (!keyword) return res.status(400).json({ error: 'Missing keyword' });
    const allMedia = imageUrls || videoUrls || footage || [];
    const firstMedia = Array.isArray(allMedia) ? (allMedia[0] || '') : (allMedia || '');
    const jobId = `mode5_${randomUUID()}`;
    res.json({ jobId });
    runJob(jobId, async () => {
      const bgmStr = toStr(bgm);
      return await renderRemotion('mode5-viral', { keyword, footage: firstMedia, bgm: bgmStr }, jobId);
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- MODE 6 ----------
app.post('/mode6', async (req, res) => {
  try {
    const { footageTop, speakerVideo, ratio, captionStyle, keywordColor, bgmMood } = req.body;
    const footageTopStr = toStr(footageTop);
    const speakerVideoStr = toStr(speakerVideo);
    if (!footageTopStr || !speakerVideoStr) return res.status(400).json({ error: 'Missing footageTop or speakerVideo' });
    const jobId = `mode6_${randomUUID()}`;
    res.json({ jobId });
    runJob(jobId, async () => {
      return await renderRemotion('mode6-split', {
        footageTop: footageTopStr,
        speakerVideo: speakerVideoStr,
        ratio: ratio || '55/45',
        captionStyle: captionStyle || 'balltalk',
        keywordColor: keywordColor || '#FFD700',
        bgmMood: bgmMood || 'dramatic',
      }, jobId);
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- START ----------
app.listen(PORT, () => console.log(`ClipThai backend listening on :${PORT}`));
