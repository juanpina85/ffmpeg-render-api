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
  if (url.includes("dropbox.com/")) {
    const u = new URL(url);

