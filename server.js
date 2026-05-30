// ClipThai Backend - Express server
// Endpoints:
//   POST /mode1         { videoUrl, language }                   -> { jobId, status }
//   POST /mode5         { keyword, footage, bgm }                -> { jobId, status }
//   POST /mode6         { footageTop, speakerVideo }             -> { jobId, status }
//   GET  /status/:jobId                                          -> { status, outputUrl, error? }
//   GET  /health                                                 -> { status: "ok" }
//
// Storage: in-memory job map (swap for Redis/Postgres in prod).
// Output: writes MP4 to ./public/outputs/<jobId>.mp4 and serves it under /outputs/*

import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { mkdir, writeFile, rm } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const OUTPUT_DIR = path.join(__dirname, "public", "outputs");
const WORK_DIR = path.join(__dirname, ".work");

await mkdir(OUTPUT_DIR, { recursive: true });
await mkdir(WORK_DIR, { recursive: true });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Job store ----------
/** @type {Map<string, {status: 'queued'|'processing'|'done'|'error', outputUrl?: string, error?: string, progress?: number}>} */
const jobs = new Map();

function createJob() {
  const jobId = randomUUID();
  jobs.set(jobId, { status: "queued" });
  return jobId;
}

function setJob(jobId, patch) {
  const cur = jobs.get(jobId) || {};
  jobs.set(jobId, { ...cur, ...patch });
}

// ---------- Helpers ----------
async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return dest;
}

async function ffmpeg(args) {
  return execFileP("ffmpeg", ["-y", ...args], { maxBuffer: 1024 * 1024 * 64 });
}

let cachedBundle = null;
async function getRemotionBundle() {
  if (cachedBundle) return cachedBundle;
  cachedBundle = await bundle({
    entryPoint: path.join(__dirname, "remotion", "src", "index.ts"),
    webpackOverride: (c) => c,
  });
  return cachedBundle;
}

async function renderRemotion({ compositionId, inputProps, outPath, durationInFrames }) {
  const serveUrl = await getRemotionBundle();
  const composition = await selectComposition({
    serveUrl,
    id: compositionId,
    inputProps,
  });
  await renderMedia({
    composition: {
      ...composition,
      durationInFrames: durationInFrames ?? composition.durationInFrames,
    },
    serveUrl,
    codec: "h264",
    outputLocation: outPath,
    inputProps,
    concurrency: 1,
    chromiumOptions: { headless: true },
  });
}

function publicUrlFor(jobId) {
  return `${PUBLIC_BASE_URL}/outputs/${jobId}.mp4`;
}

// =====================================================
// MODE 1 - Whisper + Claude clip cutting
// =====================================================
async function runMode1(jobId, { videoUrl, language = "th" }) {
  setJob(jobId, { status: "processing", progress: 5 });
  const work = path.join(WORK_DIR, jobId);
  await mkdir(work, { recursive: true });

  // 1. download source
  const srcPath = path.join(work, "src.mp4");
  await downloadTo(videoUrl, srcPath);
  setJob(jobId, { progress: 15 });

  // 2. extract audio for Whisper
  const audioPath = path.join(work, "audio.mp3");
  await ffmpeg(["-i", srcPath, "-vn", "-acodec", "libmp3lame", "-q:a", "4", audioPath]);
  setJob(jobId, { progress: 30 });

  // 3. Whisper transcription with word timestamps
  const fs = await import("fs");
  const transcript = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    language,
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });
  setJob(jobId, { progress: 55 });

  // 4. Ask Claude to pick the best clip (start/end seconds + reason)
  const segmentsText = (transcript.segments || [])
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n");

  const claudeResp = await anthropic.messages.create({
    model: "claude-3-5-sonnet-latest",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content:
          `You are an expert short-form video editor. From the transcript segments below ` +
          `(format: [start-end] text), pick the SINGLE most viral 20-45 second clip. ` +
          `Reply ONLY with strict JSON: {"start": number, "end": number, "title": string}.\n\n` +
          segmentsText,
      },
    ],
  });
  const txt = claudeResp.content?.[0]?.type === "text" ? claudeResp.content[0].text : "{}";
  const match = txt.match(/\{[\s\S]*\}/);
  const pick = match ? JSON.parse(match[0]) : { start: 0, end: 30, title: "clip" };
  setJob(jobId, { progress: 75 });

  // 5. cut the clip
  const outPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  const dur = Math.max(5, Math.min(60, (pick.end ?? 30) - (pick.start ?? 0)));
  await ffmpeg([
    "-ss", String(pick.start ?? 0),
    "-i", srcPath,
    "-t", String(dur),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k",
    outPath,
  ]);

  await rm(work, { recursive: true, force: true });
  setJob(jobId, { status: "done", progress: 100, outputUrl: publicUrlFor(jobId), title: pick.title });
}

// =====================================================
// MODE 5 - Viral Story Clip (Remotion)
// =====================================================
async function runMode5(jobId, { keyword, footage, bgm }) {
  setJob(jobId, { status: "processing", progress: 10 });
  const outPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  await renderRemotion({
    compositionId: "mode5-viral",
    inputProps: { keyword, footage, bgm },
    outPath,
  });
  setJob(jobId, { status: "done", progress: 100, outputUrl: publicUrlFor(jobId) });
}

// =====================================================
// MODE 6 - Split-Screen (Remotion)
// =====================================================
async function runMode6(jobId, { footageTop, speakerVideo }) {
  setJob(jobId, { status: "processing", progress: 10 });
  const outPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  await renderRemotion({
    compositionId: "mode6-split",
    inputProps: { footageTop, speakerVideo },
    outPath,
  });
  setJob(jobId, { status: "done", progress: 100, outputUrl: publicUrlFor(jobId) });
}

// ---------- HTTP ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/outputs", express.static(OUTPUT_DIR));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/mode1", (req, res) => {
  const { videoUrl, language } = req.body || {};
  if (!videoUrl) return res.status(400).json({ error: "videoUrl required" });
  const jobId = createJob();
  res.json({ jobId, status: "queued" });
  runMode1(jobId, { videoUrl, language }).catch((e) => {
    console.error("mode1", e);
    setJob(jobId, { status: "error", error: String(e?.message || e) });
  });
});

app.post("/mode5", (req, res) => {
  const { keyword, footage, bgm } = req.body || {};
  if (!keyword) return res.status(400).json({ error: "keyword required" });
  const jobId = createJob();
  res.json({ jobId, status: "queued" });
  runMode5(jobId, { keyword, footage, bgm }).catch((e) => {
    console.error("mode5", e);
    setJob(jobId, { status: "error", error: String(e?.message || e) });
  });
});

app.post("/mode6", (req, res) => {
  const { footageTop, speakerVideo } = req.body || {};
  if (!footageTop || !speakerVideo)
    return res.status(400).json({ error: "footageTop & speakerVideo required" });
  const jobId = createJob();
  res.json({ jobId, status: "queued" });
  runMode6(jobId, { footageTop, speakerVideo }).catch((e) => {
    console.error("mode6", e);
    setJob(jobId, { status: "error", error: String(e?.message || e) });
  });
});

app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "not_found" });
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`ClipThai backend listening on :${PORT}`);
});
