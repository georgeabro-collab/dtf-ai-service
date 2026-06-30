// server.js — DTF AI backend service
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "30mb" }));

// --- CORS (must be near the top, before routes) ---
const ORIGIN = "https://synergy-print-solutions.myshopify.com";
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ORIGIN);
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// health check
app.get("/", (req, res) => res.json({ ok: true, service: "dtf-ai" }));

const jobs = new Map();   // jobId -> { status, image }
const cache = new Map();  // hash -> image
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");

app.post("/process", async (req, res) => {
  const { image, action, prompt } = req.body || {};
  if (!image || !action) return res.status(400).json({ error: "missing image or action" });

  const key = hash(action + "|" + (prompt || "") + "|" + image.slice(0, 200));
  if (cache.has(key)) return res.json({ image: cache.get(key) });

  if (action === "removebg") {
    try {
      const out = await removeBg(image);
      cache.set(key, out);
      return res.json({ image: out });
    } catch (e) {
      return res.status(500).json({ error: String(e) });
    }
  }

  // upscale / edit are slower -> async job
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "processing" });
  res.json({ jobId });
  runReplicate(jobId, key, image, action, prompt).catch(() => {
    jobs.set(jobId, { status: "failed" });
  });
});

app.get("/status", (req, res) => {
  const job = jobs.get(req.query.id);
  if (!job) return res.status(404).json({ status: "failed" });
  res.json(job);
});

async function removeBg(dataUrl) {
  const b64 = dataUrl.split(",")[1];
  const r = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": process.env.REMOVEBG_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ image_file_b64: b64, size: "auto", format: "png" }),
  });
  if (!r.ok) throw new Error("remove.bg " + r.status + " " + (await r.text()));
  const buf = Buffer.from(await r.arrayBuffer());
  return "data:image/png;base64," + buf.toString("base64");
}

async function runReplicate(jobId, key, image, action, prompt) {
  const version = action === "upscale" ? process.env.UPSCALE_MODEL : process.env.EDIT_MODEL;
  const input = action === "upscale"
    ? { image, scale: 2 }
    : { image, prompt: prompt || "improve this design" };

  const start = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: { Authorization: "Token " + process.env.REPLICATE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ version, input }),
  });
  let pred = await start.json();
  if (pred.error) { jobs.set(jobId, { status: "failed" }); return; }

  while (pred.status !== "succeeded" && pred.status !== "failed") {
    await new Promise((r) => setTimeout(r, 1500));
    pred = await (await fetch(pred.urls.get, {
      headers: { Authorization: "Token " + process.env.REPLICATE_KEY },
    })).json();
  }

  if (pred.status === "succeeded") {
    const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    cache.set(key, out);
    jobs.set(jobId, { status: "succeeded", image: out });
  } else {
    jobs.set(jobId, { status: "failed" });
  }
}

app.listen(process.env.PORT || 3000, () => console.log("DTF AI service up"));
