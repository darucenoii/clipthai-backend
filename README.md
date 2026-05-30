# ClipThai Backend

Express + Remotion + Whisper + Claude. Deployed on Railway.

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET  | `/health` | — | `{ status: "ok" }` |
| POST | `/mode1`  | `{ videoUrl, language? }` | `{ jobId, status }` |
| POST | `/mode5`  | `{ keyword, footage, bgm }` | `{ jobId, status }` |
| POST | `/mode6`  | `{ footageTop, speakerVideo }` | `{ jobId, status }` |
| GET  | `/status/:jobId` | — | `{ status, outputUrl?, error?, progress? }` |

`status` ∈ `queued | processing | done | error`.

## Env

```
PORT=3000
PUBLIC_BASE_URL=https://clipthai-backend-production.up.railway.app
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

## Local

```bash
npm install
cp .env.example .env  # fill in keys
npm start
```

Needs `ffmpeg` and Chromium installed. See `Dockerfile`.

## Push to GitHub

```bash
git init
git remote add origin https://github.com/darucenoii/clipthai-backend.git
git add .
git commit -m "init: mode1/5/6 endpoints"
git branch -M main
git push -u origin main
```

Railway will auto-deploy from the `main` branch.
