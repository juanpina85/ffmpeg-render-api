// ─────────────────────────────────────────────────────────────
// InstaInfluencer — Runway Proxy Server
// Node.js + Express
//
// Setup:
//   npm install express cors node-fetch
//   RUNWAY_API_KEY=key_xxx node server.js
//
// Endpoints:
//   POST /api/runway/generate   { prompt } → { taskId }
//   GET  /api/runway/status/:id            → { status, url? }
// ─────────────────────────────────────────────────────────────

const express = require("express");
const cors    = require("cors");

const app  = express();
const PORT = 3001;

app.use(cors()); // allow requests from Claude artifact
app.use(express.json());

const RUNWAY_KEY     = process.env.RUNWAY_API_KEY || "";
const RUNWAY_VERSION = "2024-11-06";
const RUNWAY_BASE    = "https://api.dev.runwayml.com/v1";

if (!RUNWAY_KEY) {
  console.error("❌  Falta RUNWAY_API_KEY. Corré: RUNWAY_API_KEY=key_xxx node server.js");
  process.exit(1);
}

// ── POST /api/runway/generate ──────────────────────────────
// Body: { prompt: string }
// Returns: { taskId: string }
app.post("/api/runway/generate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });

  try {
    const r = await fetch(`${RUNWAY_BASE}/text_to_video`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RUNWAY_KEY}`,
        "X-Runway-Version": RUNWAY_VERSION,
      },
      body: JSON.stringify({
        model: "gen4_turbo",
        promptText: prompt,
        ratio: "768:1344",
        duration: 10,
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "Runway error" });
    res.json({ taskId: data.id });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/runway/status/:taskId ─────────────────────────
// Returns: { status: string, url?: string }
app.get("/api/runway/status/:taskId", async (req, res) => {
  const { taskId } = req.params;

  try {
    const r = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, {
      headers: {
        "Authorization": `Bearer ${RUNWAY_KEY}`,
        "X-Runway-Version": RUNWAY_VERSION,
      },
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "Runway error" });

    res.json({
      status: data.status,                    // PENDING | RUNNING | SUCCEEDED | FAILED
      url:    data.output?.[0] || null,
      failure: data.failure || null,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ───────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, runway: !!RUNWAY_KEY }));

app.listen(PORT, () => {
  console.log(`✅  Runway proxy corriendo en http://localhost:${PORT}`);
  console.log(`   POST http://localhost:${PORT}/api/runway/generate`);
  console.log(`   GET  http://localhost:${PORT}/api/runway/status/:taskId`);
});

