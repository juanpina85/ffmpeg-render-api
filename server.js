const express = require("express");
const morgan = require("morgan");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();

// JSON normal + fallback por si Make manda text/plain
app.use(express.json({ limit: "10mb", type: ["application/json", "application/*+json"] }));
app.use(express.text({ limit: "10mb", type: ["text/plain", "text/*", "*/*"] }));
app.use(morgan("tiny"));

const PORT = process.env.PORT || 3000;

// API key opcional
const API_KEY = process.env.API_KEY || "";
function auth(req, res, next) {
  if (!API_KEY) return next();
  const got = req.headers["x-api-key"];
  if (got !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ---------------- HELPERS ----------------
function maybeParseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim().length) {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function normalizeDropbox(url) {
  if (!url || typeof url !== "string") return url;
  url = url.trim();
  if (url.includes("dropbox.com/")) {
    const u = new URL(url);
    u.searchParams.set("dl", "1");
    return u.toString();
  }
  return url;
}

async function downloadToFile(url, outPath) {
  const finalUrl = normalizeDropbox(url);
  const resp = await axios.get(finalUrl, {
    responseType: "stream",
    timeout: 180000,
    maxRedirects: 10,
    headers: {
      "User-Agent": "Mozilla/5.0 (pulso-render/async)",
      Accept: "*/*",
    },
    validateStatus: s => s >= 200 && s < 300,
  });

  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outPath);
    resp.data.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", d => (stderr += d.toString()));
    p.on("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed (code=${code}, signal=${signal}): ${stderr.slice(-4000)}`));
    });
  });
}

// ---------------- JOB QUEUE ----------------
// cola serial (1 render a la vez → Railway safe)
const jobs = new Map();     // jobId → estado
const queue = [];
let running = false;

function enqueue(jobId, fn) {
  queue.push({ jobId, fn });
  drain();
}

async function drain() {
  if (running) return;
  const item = queue.shift();
  if (!item) return;
  running = true;
  try {
    await item.fn();
  } finally {
    running = false;
    drain();
  }
}

function setJob(id, patch) {
  const cur = jobs.get(id) || {};
  jobs.set(id, { ...cur, ...patch, updatedAt: Date.now() });
}

// ---------------- ROUTES ----------------
app.get("/health", (_, res) =>
  res.json({ status: "ok", build: "v4-async-queue" })
);

app.post("/debug", auth, (req, res) => {
  const body = maybeParseJsonBody(req);
  res.json({
    contentType: req.headers["content-type"] || null,
    bodyType: typeof req.body,
    bodyPreview: body || req.body,
  });
});

/**
 * POST /render  (ASYNC)
 * responde inmediato con job_id
 */
app.post("/render", auth, async (req, res) => {
  const body = maybeParseJsonBody(req);
  if (!body) return res.status(400).json({ error: "invalid json body" });

  const {
    background_url,
    image_url,
    voiceover_url,
    music_url,
    headline,
    footer,
    callback_url // opcional (lo usamos después)
  } = body;

  if (!background_url || !image_url || !voiceover_url || !music_url || !headline) {
    return res.status(400).json({ error: "missing fields" });
  }

  const jobId = crypto.randomUUID();
  const base = `${req.protocol}://${req.get("host")}`;

  jobs.set(jobId, {
    status: "queued",
    progress: 0,
    createdAt: Date.now(),
    error: null,
    outPath: null,
    callback_url: callback_url || null
  });

  // RESPUESTA INMEDIATA → Make no timeoutea
  res.json({
    status: "accepted",
    job_id: jobId,
    status_url: `${base}/status/${jobId}`,
    download_url: `${base}/download/${jobId}`
  });

  // RENDER EN BACKGROUND
  enqueue(jobId, async () => {
    setJob(jobId, { status: "processing", progress: 5 });

    const workdir = fs.mkdtempSync(path.join("/tmp/", `render-${jobId}-`));
    const bgFile = path.join(workdir, "bg.mp4");
    const imgFile = path.join(workdir, "img.jpg");
    const voicePath = path.join(workdir, "voice.mp3");
    const musicPath = path.join(workdir, "music.mp3");
    const outPath = path.join(workdir, "out.mp4");

    try {
      setJob(jobId, { progress: 10 });
      await downloadToFile(background_url, bgFile);

      setJob(jobId, { progress: 20 });
      await downloadToFile(image_url, imgFile);

      setJob(jobId, { progress: 35 });
      await downloadToFile(voiceover_url, voicePath);

      setJob(jobId, { progress: 45 });
      await downloadToFile(music_url, musicPath);

      const fontPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
      const safeHeadline = String(headline)
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'")
        .replace(/\n/g, " ");

      const safeFooter = String(footer || "")
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'")
        .replace(/\n/g, " ");

      const cardW = 980;
      const cardH = 720;
      const cardX = Math.floor((1080 - cardW) / 2);
      const cardY = 260;
      const headlineY = 90;
      const footerY = 1780;

      const filter = [
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p[bg];`,
        `[1:v]scale=${cardW}:${cardH}:force_original_aspect_ratio=increase,crop=${cardW}:${cardH},format=rgba[img];`,
        `[bg]drawbox=x=${cardX-6}:y=${cardY-6}:w=${cardW+12}:h=${cardH+12}:color=black@0.35:t=fill[bg2];`,
        `[bg2]drawbox=x=${cardX-2}:y=${cardY-2}:w=${cardW+4}:h=${cardH+4}:color=white@0.85:t=fill[bg3];`,
        `[bg3][img]overlay=x=${cardX}:y=${cardY}[v1];`,
        `[v1]drawbox=x=60:y=${headlineY}:w=960:h=110:color=black@0.55:t=fill[v2];`,
        `[v2]drawtext=fontfile=${fontPath}:text='${safeHeadline}':fontcolor=white:fontsize=56:x=90:y=${headlineY+28}[v3];`,
        `[v3]drawbox=x=240:y=${footerY-28}:w=600:h=70:color=black@0.35:t=fill[v4];`,
        `[v4]drawtext=fontfile=${fontPath}:text='${safeFooter}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=${footerY}[v];`,
        `[2:a]volume=1.0[a1];`,
        `[3:a]volume=0.22[a2];`,
        `[a1][a2]amix=inputs=2:duration=first:dropout_transition=2[a]`,
      ].join("");

      const args = [
        "-y",
        "-threads", "2",
        "-i", bgFile,
        "-loop", "1", "-i", imgFile,
        "-i", voicePath,
        "-i", musicPath,
        "-filter_complex", filter,
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "30",
        "-pix_fmt", "yuv420p",
        "-r", "30",
        "-x264-params", "threads=2:lookahead_threads=1",
        "-c:a", "aac",
        "-b:a", "96k",
        "-ac", "1",
        "-ar", "24000",
        "-movflags", "+faststart",
        "-shortest",
        outPath
      ];

      setJob(jobId, { progress: 65 });
      await runFfmpeg(args);

      setJob(jobId, { status: "done", progress: 100, outPath });

    } catch (e) {
      setJob(jobId, { status: "failed", error: e.message, progress: 100 });
    }
  });
});

// STATUS
app.get("/status/:id", auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json

