const express = require("express");
const morgan = require("morgan");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

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

// ---- Helpers ----
function maybeParseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim().length) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeDropbox(url) {
  if (!url || typeof url !== "string") return url;

  // trim por si Make manda un espacio al inicio
  url = url.trim();

  // Dropbox share link -> forzar descarga
  if (url.includes("dropbox.com/")) {
    const u = new URL(url);
    // fuerza dl=1
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
      "User-Agent": "Mozilla/5.0 (compatible; pulso-render/1.0)",
      Accept: "*/*",
    },
    validateStatus: (s) => s >= 200 && s < 300,
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
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed (code=${code}, signal=${signal}): ${stderr.slice(-4000)}`));
    });
  });
}


// ---- Routes ----
app.get("/health", (_, res) => res.json({ status: "ok" }));

// Debug para ver qué llega desde Make
app.post("/debug", auth, (req, res) => {
  const body = maybeParseJsonBody(req);
  res.json({
    contentType: req.headers["content-type"] || null,
    bodyType: typeof req.body,
    bodyPreview: body || req.body,
  });
});

/**
 * POST /render
 * body:
 * {
 *  background_url: string (mp4)
 *  image_url: string (jpg/png/webp)
 *  voiceover_url: string (mp3)
 *  music_url: string (mp3)
 *  headline: string
 *  footer: string
 * }
 */
app.post("/render", auth, async (req, res) => {
  try {
    const body = maybeParseJsonBody(req);
    if (!body) return res.status(400).json({ error: "invalid json body" });

    const {
      background_url,
      image_url,
      voiceover_url,
      music_url,
      headline,
      footer,
    } = body;

    if (!background_url || !voiceover_url || !music_url || !headline || !image_url) {
      return res.status(400).json({ error: "missing fields" });
    }

    const workdir = fs.mkdtempSync(path.join("/tmp/", "render-"));
    const bgFile = path.join(workdir, "bg.mp4");

    // IMPORTANTE: guardamos con extensión para que ffmpeg detecte formato sin problemas
    const imgFile = path.join(workdir, "img.jpg");

    const voicePath = path.join(workdir, "voice.mp3");
    const musicPath = path.join(workdir, "music.mp3");
    const outPath = path.join(workdir, "out.mp4");

    // Descargas
    await downloadToFile(background_url, bgFile);
    await downloadToFile(image_url, imgFile);
    await downloadToFile(voiceover_url, voicePath);
    await downloadToFile(music_url, musicPath);

    const fontPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

    // Escape básico para drawtext
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

    // Layout card
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

    // ⚙️ FFmpeg args optimizados para Railway (evita threads=60 y SIGKILL)
    const args = [
      "-y",

      // Limita uso de CPU
      "-threads", "2",

      // inputs
      "-i", bgFile,
      "-loop", "1", "-i", imgFile,
      "-i", voicePath,
      "-i", musicPath,

      "-filter_complex", filter,
      "-map", "[v]",
      "-map", "[a]",

      // video más liviano
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "30",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-x264-params", "threads=2",

      // audio más liviano
      "-c:a", "aac",
      "-b:a", "96k",
      "-ac", "1",
      "-ar", "24000",

      "-movflags", "+faststart",
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

