const express = require("express");
const morgan = require("morgan");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();

// JSON normal
app.use(express.json({ limit: "10mb", type: ["application/json", "application/*+json"] }));
// Fallback por si Make manda text/plain
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
  // Dropbox share link -> force download
  if (url.includes("dropbox.com/")) {
    const u = new URL(url);
    // si ya es dl.dropboxusercontent.com, lo dejamos
    if (u.hostname === "dl.dropboxusercontent.com") return url;

    // forzamos dl=1
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
    maxRedirects: 5,
    headers: {
      // ayuda con algunos hosts/CDNs
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
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-4000)}`));
    });
  });
}

// ---- Routes ----
app.get("/health", (_, res) => res.json({ status: "ok" }));

// Útil para debug (ya lo estabas usando)
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
 *  image_url: string (jpg/png/webp)   <-- NUEVO
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

    if (!background_url || !voiceover_url || !music_url || !headline) {
      return res.status(400).json({ error: "missing fields" });
    }
    if (!image_url) {
      return res.status(400).json({ error: "missing fields (image_url)" });
    }

    const workdir = fs.mkdtempSync(path.join("/tmp/", "render-"));
    const bgFile = path.join(workdir, "bg.mp4");
    const imgFile = path.join(workdir, "img");
    const voicePath = path.join(workdir, "voice.mp3");
    const musicPath = path.join(workdir, "music.mp3");
    const outPath = path.join(workdir, "out.mp4");

    // Descargas
    await downloadToFile(background_url, bgFile);
    await downloadToFile(voiceover_url, voicePath);
    await downloadToFile(music_url, musicPath);

    // Imagen: puede ser jpg/png/webp, guardamos sin extensión fija
    await downloadToFile(image_url, imgFile);

    // Tipografías
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

    /**
     * Layout:
     * - Base video 1080x1920
     * - Imagen grande arriba en "card":
     *   - ancho 980
     *   - alto 720 aprox
     *   - con borde + sombra suave (simulada)
     * - Headline barra arriba
     * - Footer abajo
     *
     * Inputs:
     * 0: bg mp4 (video)
     * 1: image (as video stream via -loop 1)
     * 2: voice mp3
     * 3: music mp3
     */

    // Parámetros “card”
    const cardW = 980;
    const cardH = 720;
    const cardX = Math.floor((1080 - cardW) / 2); // centrado
    const cardY = 260;

    // Barra headline
    const headlineY = 90;

    // Footer
    const footerY = 1780;

    const filter = [
      // 0:v background -> full 9:16
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p[bg];`,

      // 1:v image loop -> card size (cover)
      `[1:v]scale=${cardW}:${cardH}:force_original_aspect_ratio=increase,crop=${cardW}:${cardH},format=rgba[img];`,

      // sombra (un rectángulo negro con alpha) + overlay imagen arriba
      `[bg]drawbox=x=${cardX-6}:y=${cardY-6}:w=${cardW+12}:h=${cardH+12}:color=black@0.35:t=fill[bg2];`,

      // borde blanco fino
      `[bg2]drawbox=x=${cardX-2}:y=${cardY-2}:w=${cardW+4}:h=${cardH+4}:color=white@0.85:t=fill[bg3];`,

      // overlay imagen
      `[bg3][img]overlay=x=${cardX}:y=${cardY}[v1];`,

      // headline bar
      `[v1]drawbox=x=60:y=${headlineY}:w=960:h=110:color=black@0.55:t=fill[v2];`,

      // headline text
      `[v2]drawtext=fontfile=${fontPath}:text='${safeHeadline}':fontcolor=white:fontsize=56:` +
        `x=90:y=${headlineY+28}[v3];`,

      // footer bar
      `[v3]drawbox=x=240:y=${footerY-28}:w=600:h=70:color=black@0.35:t=fill[v4];`,

      // footer text
      `[v4]drawtext=fontfile=${fontPath}:text='${safeFooter}':fontcolor=white:fontsize=34:` +
        `x=(w-text_w)/2:y=${footerY}[v];`,

      // audio mix
      `[2:a]volume=1.0[a1];`,
      `[3:a]volume=0.22[a2];`,
      `[a1][a2]amix=inputs=2:duration=first:dropout_transition=2[a]`,
    ].join("");

    const args = [
      "-y",
      // bg
      "-i", bgFile,
      // imagen loop (para que dure)
      "-loop", "1",
      "-i", imgFile,
      // audio
      "-i", voicePath,
      "-i", musicPath,

      "-filter_complex", filter,
      "-map", "[v]",
      "-map", "[a]",

      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-r", "30",

      "-c:a", "aac",
      "-b:a", "192k",

      // corta cuando termina la voz
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

