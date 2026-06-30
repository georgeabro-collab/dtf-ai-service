// server.js — DTF AI backend (all tools via Replicate)
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "30mb" }));

// --- CORS ---
const ORIGIN = "https://synergy-print-solutions.myshopify.com";
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ORIGIN);
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => res.json({ ok: true, service: "dtf-ai" }));

const KEY = process.env.REPLICATE_KEY;
const BG_MODEL = process.env.BG_MODEL || "851-labs/background-remover";
const UPSCALE_MODEL = process.env.UPSCALE_MODEL || "nightmareai/real-esrgan";
const EDIT_MODEL = process.env.EDIT_MODEL || "black-forest-labs/flux-kontext-pro";

const jobs = new Map();
const cache = new Map();
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function latestVersion(modelRef) {
  const r = await fetch(`https://api.replicate.com/v1/models/${modelRef}`, {
    headers: { Authorization: "Bearer " + KEY },
  });
  if (!r.ok) throw new Error("model lookup " + r.status + " " + (await r.text()));
  const j = await r.json();
  return j.latest_version && j.latest_version.id;
}

async function runModel(modelRef, input) {
  const version = await latestVersion(modelRef);
  const start = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ version, input }),
  });
  if (!start.ok) throw new Error("create " + start.status + " " + (await start.text()));
  let pred = await start.json();
  while (pred.status !== "succeeded" && pred.status !== "failed" && pred.status !== "canceled") {
    await new Promise((r) => setTimeout(r, 1500));
    pred = await (await fetch(pred.urls.get, {
      headers: { Authorization: "Bearer " + KEY },
    })).json();
  }
  if (pred.status !== "succeeded") throw new Error("prediction " + pred.status + ": " + JSON.stringify(pred.error));
  return Array.isArray(pred.output) ? pred.output[0] : pred.output;
}

app.post("/process", async (req, res) => {
  const { image, action, prompt } = req.body || {};
  if (!image || !action) return res.status(400).json({ error: "missing image or action" });
  if (!KEY) return res.status(500).json({ error: "REPLICATE_KEY not set" });

  const key = hash(action + "|" + (prompt || "") + "|" + image.slice(0, 200));
  if (cache.has(key)) return res.json({ image: cache.get(key) });

  if (action === "removebg") {
    try {
      const out = await runModel(BG_MODEL, { image });
      cache.set(key, out);
      return res.json({ image: out });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "processing" });
  res.json({ jobId });

  (async () => {
    try {
      let out;
      if (action === "upscale") out = await runModel(UPSCALE_MODEL, { image, scale: 4 });
      else if (action === "edit") out = await runModel(EDIT_MODEL, { input_image: image, prompt: prompt || "improve this design" });
      else throw new Error("unknown action " + action);
      cache.set(key, out);
      jobs.set(jobId, { status: "succeeded", image: out });
    } catch (e) {
      jobs.set(jobId, { status: "failed", error: String(e.message || e) });
    }
  })();
});

app.get("/status", (req, res) => {
  const job = jobs.get(req.query.id);
  if (!job) return res.status(404).json({ status: "failed" });
  res.json(job);
});

app.listen(process.env.PORT || 3000, () => console.log("DTF AI service up"));
