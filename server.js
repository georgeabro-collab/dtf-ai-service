const express = require('express');
const app = express();
app.use(express.json({ limit: '50mb' }));

// --- CORS (allow your storefront to call this) ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const REPLICATE_KEY = process.env.REPLICATE_KEY;
const BG_MODEL = process.env.BG_MODEL || '851-labs/background-remover';
const UPSCALE_MODEL = process.env.UPSCALE_MODEL || 'nightmareai/real-esrgan';
const EDIT_MODEL = process.env.EDIT_MODEL || 'black-forest-labs/flux-kontext-pro';

app.get('/', (req, res) => res.json({ ok: true, service: 'dtf-ai' }));

// Resolve "owner/name" -> latest version id
async function latestVersion(modelRef) {
  const r = await fetch(`https://api.replicate.com/v1/models/${modelRef}`, {
    headers: { Authorization: `Bearer ${REPLICATE_KEY}` }
  });
  if (!r.ok) throw new Error(`model lookup ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.latest_version && j.latest_version.id;
}

// Run a prediction and poll until done
async function runModel(modelRef, input) {
  const version = await latestVersion(modelRef);
  const create = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REPLICATE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ version, input })
  });
  if (!create.ok) throw new Error(`create ${create.status} ${await create.text()}`);
  let pred = await create.json();

  while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
    await new Promise(r => setTimeout(r, 1500));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { Authorization: `Bearer ${REPLICATE_KEY}` }
    });
    pred = await poll.json();
  }
  if (pred.status !== 'succeeded') {
    throw new Error(`prediction ${pred.status}: ${JSON.stringify(pred.error)}`);
  }
  // output is usually a URL string or array of URLs
  return Array.isArray(pred.output) ? pred.output[0] : pred.output;
}

app.post('/process', async (req, res) => {
  try {
    const { action, image, prompt } = req.body;
    if (!REPLICATE_KEY) throw new Error('REPLICATE_KEY not set');
    if (!image) throw new Error('no image provided');

    let output;
    if (action === 'removebg') {
      output = await runModel(BG_MODEL, { image });
    } else if (action === 'upscale') {
      output = await runModel(UPSCALE_MODEL, { image, scale: 4 });
    } else if (action === 'edit') {
      output = await runModel(EDIT_MODEL, { input_image: image, prompt: prompt || 'enhance' });
    } else {
      throw new Error('unknown action: ' + action);
    }
    res.json({ url: output });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('listening on ' + PORT));
