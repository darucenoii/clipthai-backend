const express = require('express');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '50mb' }));

const jobs = new Map();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3001';
const OUTPUT_DIR = path.join(os.tmpdir(), 'clipthai-renders');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use('/renders', express.static(OUTPUT_DIR));
app.use('/outputs', express.static(path.join(__dirname, 'public', 'outputs')));

// ---------- HEALTH ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ status: 'ClipThai backend running', version: '1.0.0' });
});

// ---------- HELPERS ----------
async function generateTTS(text, voiceId) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.4,
          use_speaker_boost: true,
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

function runJob(jobId, fn) {
  jobs.set(jobId, { status: 'processing', progress: 0, createdAt: Date.now() });
  (async () => {
    try {
      const outputUrl = await fn();
      jobs.set(jobId, {
        status: 'completed',
        progress: 100,
        outputUrl,
        completedAt: Date.now(),
      });
    } catch (err) {
      console.error(`[${jobId}]`, err);
      jobs.set(jobId, {
        status: 'failed',
        error: err.message,
        failedAt: Date.now(),
      });
    }
  })();
}

// ---------- STATUS ----------
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ jobId: req.params.jobId, ...job });
});

// ---------- MODE 1 — ตัดคลิปอัตโนมัติ ----------
app.post('/mode1', async (req, res) => {
  try {
    const { videoUrl, language = 'th' } = req.body;
    if (!videoUrl) return res.status(400).json({ error: 'Missing videoUrl' });

    const jobId = `mode1_${randomUUID()}`;
    res.json({ jobId });

    runJob(jobId, async () => {
      // Whisper transcribe
      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: (() => {
          const fd = new FormData();
          fd.append('model', 'whisper-1');
          fd.append('language', language);
          fd.append('url', videoUrl);
          return fd;
        })(),
      });

      const transcript = await whisperRes.json();

      // Claude เลือกช่วงที่ดีที่สุด
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: `จาก transcript นี้: ${JSON.stringify(transcript)}
เลือกช่วงเวลาที่น่าสนใจที่สุด 3 ช่วง สำหรับตัดเป็น clip สั้น 20-45 วินาที
ตอบเป็น JSON array: [{"start": 0, "end": 30, "reason": "..."}]`,
          }],
        }),
      });

      const claudeData = await claudeRes.json();
      const segments = JSON.parse(claudeData.content[0].text);

      return `${PUBLIC_BASE_URL}/status/${jobId}`;
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- MODE 2 — สร้างรีวิวจากฟุตเทจ ----------
app.post('/mode2', async (req, res) => {
  try {
    const { scriptText, voiceId, footageUrls, productName, price } = req.body;
    if (!scriptText || !voiceId || !Array.isArray(footageUrls) || footageUrls.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: scriptText, voiceId, footageUrls' });
    }

    const jobId = `mode2_${randomUUID()}`;
    res.json({ jobId });

    runJob(jobId, async () => {
      // 1) TTS ด้วย ElevenLabs
      const audioBuffer = await generateTTS(scriptText, voiceId);
      const audioPath = path.join(OUTPUT_DIR, `${jobId}.mp3`);
      fs.writeFileSync(audioPath, audioBuffer);
      const audioUrl = `${PUBLIC_BASE_URL}/renders/${jobId}.mp3`;

      // 2) Remotion render
      const { bundle } = require('@remotion/bundler');
      const { renderMedia, selectComposition } = require('@remotion/renderer');

      const bundleLocation = await bundle({
        entryPoint: path.join(__dirname, 'remotion', 'src', 'index.ts'),
        webpackOverride: (c) => c,
      });

      const inputProps = {
        audioUrl,
        footageUrls,
        scriptText,
        productName: productName || '',
        price: price || '',
        captionStyle: 'review',
      };

      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: 'ReviewClip',
        inputProps,
      });

      const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
      await renderMedia({
        composition: { ...composition, width: 1080, height: 1920, fps: 30 },
        serveUrl: bundleLocation,
        codec: 'h264',
        outputLocation: outputPath,
        inputProps,
      });

      return `${PUBLIC_BASE_URL}/renders/${jobId}.mp4`;
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- MODE 3 — Hybrid AI + ฟุตเทจจริง ----------
app.post('/mode3', async (req, res) => {
  try {
    const { scriptText, voiceId, footageUrls, productName, price, platform, cta } = req.body;
    if (!scriptText || !voiceId || !Array.isArray(footageUrls) || footageUrls.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: scriptText, voiceId, footageUrls' });
    }

    const jobId = `mode3_${randomUUID()}`;
    res.json({ jobId });

    runJob(jobId, async () => {
      const audioBuffer = await generateTTS(scriptText, voiceId);
      const audioPath = path.join(OUTPUT_DIR, `${jobId}.mp3`);
      fs.writeFileSync(audioPath, audioBuffer);
      const audioUrl = `${PUBLIC_BASE_URL}/renders/${jobId}.mp3`;

      const { bundle } = require('@remotion/bundler');
      const { renderMedia, selectComposition } = require('@remotion/renderer');

      const bundleLocation = await bundle({
        entryPoint: path.join(__dirname, 'remotion', 'src', 'index.ts'),
        webpackOverride: (c) => c,
      });

      const inputProps = {
        audioUrl,
        footageUrls,
        scriptText,
        productName: productName || '',
        price: price || '',
        platform: platform || 'tiktok',
        cta: cta || '',
        showPriceOverlay: true,
      };

      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: 'HybridClip',
        inputProps,
      });

      const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
      await renderMedia({
        composition: { ...composition, width: 1080, height: 1920, fps: 30 },
        serveUrl: bundleLocation,
        codec: 'h264',
        outputLocation: outputPath,
        inputProps,
      });

      return `${PUBLIC_BASE_URL}/renders/${jobId}.mp4`;
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- MODE 5 — Viral Story Clip ----------
app.post('/mode5', async (req, res) => {
  try {
    const { keyword, footage, bgm } = req.body;
    if (!keyword || !Array.isArray(footage)) {
      return res.status(400).json({ error: 'Missing keyword or footage' });
    }

    const jobId = `mode5_${randomUUID()}`;
    res.json({ jobId });

    runJob(jobId, async () => {
      const { bundle } = require('@remotion/bundler');
      const { renderMedia, selectComposition } = require('@remotion/renderer');

      const bundleLocation = await bundle({
        entryPoint: path.join(__dirname, 'remotion', 'src', 'index.ts'),
        webpackOverride: (c) => c,
      });

      const inputProps = { keyword, footage, bgm };

      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: 'Mode5Viral',
        inputProps,
      });

      const outputPath = path.join(__dirname, 'public', 'outputs', `${jobId}.mp4`);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      await renderMedia({
        composition: { ...composition, width: 1080, height: 1920, fps: 30 },
        serveUrl: bundleLocation,
        codec: 'h264',
        outputLocation: outputPath,
        inputProps,
      });

      return `${PUBLIC_BASE_URL}/outputs/${jobId}.mp4`;
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- MODE 6 — Split-Screen Story ----------
app.post('/mode6', async (req, res) => {
  try {
    const { footageTop, speakerVideo, ratio, captionStyle, keywordColor, bgmMood } = req.body;
    if (!footageTop || !speakerVideo) {
      return res.status(400).json({ error: 'Missing footageTop or speakerVideo' });
    }

    const jobId = `mode6_${randomUUID()}`;
    res.json({ jobId });

    runJob(jobId, async () => {
      const { bundle } = require('@remotion/bundler');
      const { renderMedia, selectComposition } = require('@remotion/renderer');

      const bundleLocation = await bundle({
        entryPoint: path.join(__dirname, 'remotion', 'src', 'index.ts'),
        webpackOverride: (c) => c,
      });

      const inputProps = {
        footageTop,
        speakerVideo,
        ratio: ratio || '55/45',
        captionStyle: captionStyle || 'balltalk',
        keywordColor: keywordColor || '#FFD700',
        bgmMood: bgmMood || 'dramatic',
      };

      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: 'Mode6Split',
        inputProps,
      });

      const outputPath = path.join(__dirname, 'public', 'outputs', `${jobId}.mp4`);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      await renderMedia({
        composition: { ...composition, width: 1080, height: 1920, fps: 30 },
        serveUrl: bundleLocation,
        codec: 'h264',
        outputLocation: outputPath,
        inputProps,
      });

      return `${PUBLIC_BASE_URL}/outputs/${jobId}.mp4`;
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ClipThai backend listening on :${PORT}`));
