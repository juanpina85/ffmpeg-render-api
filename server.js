const express = require("express");
const morgan = require("morgan");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
// Acepta JSON normal
app.use(express.json({ limit: "10mb", type: ["application/json", "application/*+json"] }));
// Acepta body como texto si Make lo manda como text/plain
app.use(express.text({ limit: "10mb", type: ["text/plain", "text/*", "*/*"] }));
app.use(morgan("tiny"));

const PORT = process.env.PORT || 3000;

// API key opcional (recomendado)
const API_KEY = process.env.API_KEY || "";
function auth(req, res, next) {
  if (!API_KEY) return next();
  const got = req.headers["x-api-key"];
  if (got !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

async function downloadToFile(url, outPath) {
  const resp = await axios.get(url, { responseType: "stream", timeout: 180000 });
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
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-2000)}`));
    });
  });
}

app.get("/health", (_, res) => res.json({ status: "ok" }));

// Render: duración = voz (voiceover)
app.post("/render", auth, async (req, res) => {
  try {
    const { background_url, voiceover_url, music_url, headline, footer } = req.body || {};
    if (!background_url || !voiceover_url || !music_url || !headline) {
      return res.status(400).json({ error: "missing fields" });
    }

    const workdir = fs.mkdtempSync(path.join("/tmp/", "render-"));
    const bgFile = path.join(workdir, "bg.mp4");
    const voicePath = path.join(workdir, "voice.mp3");
    const musicPath = path.join(workdir, "music.mp3");
    const outPath = path.join(workdir, "out.mp4");

    await downloadToFile(background_url, bgFile);
    await downloadToFile(voiceover_url, voicePath);
    await downloadToFile(music_url, musicPath);

    const fontPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    const safeHeadline = String(headline).replace(/:/g, "\\:").replace(/'/g, "\\'");
    const safeFooter = String(footer || "").replace(/:/g, "\\:").replace(/'/g, "\\'");

    const filter =
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p,` +
      `drawtext=fontfile=${fontPath}:text='${safeHeadline}':fontcolor=white:fontsize=64:` +
      `x=(w-text_w)/2:y=140:box=1:boxcolor=black@0.45:boxborderw=20,` +
      `drawtext=fontfile=${fontPath}:text='${safeFooter}':fontcolor=white:fontsize=36:` +
      `x=(w-text_w)/2:y=h-140:box=1:boxcolor=black@0.35:boxborderw=18[v];` +
      `[1:a]volume=1.0[a1];` +
      `[2:a]volume=0.25[a2];` +
      `[a1][a2]amix=inputs=2:duration=first:dropout_transition=2[a]`;

    const args = [
      "-y",
      "-i", bgFile,
      "-i", voicePath,
      "-i", musicPath,
      "-filter_complex", filter,
      "-map", "[v]",
      "-map", "[a]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-r", "30",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      outPath,
    ];

    await runFfmpeg(args);

    res.setHeader("Content-Type", "video/mp4");
    fs.createReadStream(outPath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("listening", PORT));
