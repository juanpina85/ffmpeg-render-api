const express = require("express");
const morgan = require("morgan");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();

// Make a veces manda body como text/plain
app.use(express.json({ limit: "10mb", type: ["application/json", "application/*+json"] }));
app.use(express.text({ limit: "10mb", type: ["text/plain", "text/*"] }));

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

async function downloadToFile(url, outPath) {
  const resp = await axios.get(url, {
    responseType: "stream",
    timeout: 180000,
    maxRedirects: 10,
    headers: {
      "User-Agent": "ffmpeg-render-api/1.0",
      Accept: "*/*",
    },
    validateStatus: (s) => s >= 200 && s < 400,
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

    p.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    p.on("close", (code, signal) => {
      if (code === 0) return resolve();

      reject(
        new Error(
          `ffmpeg failed (code=${code}, signal=${signal}): ${stderr.slice(-2000)}`
        )
      );
    });
  });
}

app.get("/health", (_, res) => res.json({ status: "ok" }));

// Debug endpoint
app.post("/debug", auth, (req, res) => {
  res.json({
    contentType: req.headers["content-type"] || null,
    bodyType: typeof req.body,
    bodyPreview:
      typeof req.body === "string" ? req.body.slice(0, 500) : req.body,
  });
});

// Render video
app.post("/render", auth, async (req, res) => {
  try {
    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({ error: "body is not valid JSON string" });
      }
    }

    const { background_url, voiceover_url, music_url, headline, footer } =
      body || {};

    if (!background_url || !voiceover_url || !music_url || !headline) {
      return res.status(400).json({
        error: "missing fields",
        got: {
          background_url: !!background_url,
          voiceover_url: !!voiceover_url,
          music_url: !!music_url,
          headline: !!headline,
        },
      });
    }

    const workdir = fs.mkdtempSync(path.join("/tmp/", "render-"));

    const bgFile = path.join(workdir, "bg.mp4");
    const voicePath = path.join(workdir, "voice.mp3");
    const musicPath = path.join(workdir, "music.mp3");
    const outPath = path.join(workdir, "out.mp4");

    // Download files
    await downloadToFile(background_url, bgFile);
    await downloadToFile(voiceover_url, voicePath);
    await downloadToFile(music_url, musicPath);

    const fontPath =
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

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

      // limitar uso CPU
      "-threads",
      "2",

      "-i",
      bgFile,

      "-i",
      voicePath,

      "-i",
      musicPath,

      "-filter_complex",
      filter,

      "-map",
      "[v]",

      "-map",
      "[a]",

      "-c:v",
      "libx264",

      "-preset",
      "ultrafast",

      "-crf",
      "28",

      "-pix_fmt",
      "yuv420p",

      "-r",
      "30",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      "-movflags",
      "+faststart",

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
