import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clients } from './lib/llm-clients.js';
import {
  buildEngineResult,
  finalizeEngineResult,
  classifySentiment,
  computeScore,
  buildHeadline,
} from './lib/analyzer.js';
import * as cache from './lib/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 5;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000;

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const LLMS = ['claude', 'chatgpt', 'gemini', 'perplexity'];

const ipLog = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const arr = (ipLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - arr[0])) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'rate_limited',
      message: `Too many audits. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
    });
  }
  arr.push(now);
  ipLog.set(ip, arr);
  next();
}

function validateAuditInput(body) {
  const businessName = typeof body?.business_name === 'string' ? body.business_name.trim() : '';
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!businessName || businessName.length > 200) return { error: 'business_name required (<=200 chars)' };
  if (!query || query.length > 400) return { error: 'query required (<=400 chars)' };
  return { businessName, query, email };
}

async function runAuditFor(businessName, query, { onProgress, onResult } = {}) {
  const partials = {};

  await Promise.all(
    LLMS.map(async (llm) => {
      onProgress?.(llm, 'running');
      const { raw, error } = await clients[llm](businessName, query);
      const partial = buildEngineResult({ llm, raw, error, businessName });
      partials[llm] = partial;

      let sentiment = null;
      if (partial._needsSentiment) {
        sentiment = await classifySentiment(partial.quote, businessName, query);
      }
      const final = finalizeEngineResult(partial, sentiment);
      partials[llm] = final;
      onResult?.(llm, final);
    })
  );

  const score = computeScore(partials);
  const headline = buildHeadline(score, partials);
  return { results: partials, score, headline };
}

app.post('/api/audit', rateLimit, async (req, res) => {
  const v = validateAuditInput(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const cached = cache.get(v.businessName, v.query);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const result = await runAuditFor(v.businessName, v.query);
    cache.set(v.businessName, v.query, result);
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error('Audit failed:', err);
    res.status(500).json({ error: 'audit_failed', message: err.message });
  }
});

app.get('/api/audit/stream', rateLimit, async (req, res) => {
  const v = validateAuditInput({
    business_name: req.query.business_name,
    query: req.query.query,
    email: req.query.email,
  });
  if (v.error) return res.status(400).json({ error: v.error });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let closed = false;
  req.on('close', () => { closed = true; });

  const cached = cache.get(v.businessName, v.query);
  if (cached) {
    for (const llm of LLMS) {
      if (closed) return;
      send('progress', { llm, status: 'running' });
      send('result', { llm, ...cached.results[llm] });
    }
    send('complete', { score: cached.score, headline: cached.headline, cached: true });
    return res.end();
  }

  try {
    const result = await runAuditFor(v.businessName, v.query, {
      onProgress: (llm, status) => { if (!closed) send('progress', { llm, status }); },
      onResult: (llm, final) => { if (!closed) send('result', { llm, ...final }); },
    });
    if (!closed) {
      cache.set(v.businessName, v.query, result);
      send('complete', { score: result.score, headline: result.headline, cached: false });
    }
  } catch (err) {
    console.error('Stream audit failed:', err);
    if (!closed) send('error', { message: err.message || 'audit_failed' });
  } finally {
    if (!closed) res.end();
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    cache_size: cache.size(),
    keys_present: {
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY),
      perplexity: Boolean(process.env.PERPLEXITY_API_KEY),
    },
  });
});

app.listen(PORT, () => {
  console.log(`Signal audit server listening on :${PORT}`);
});
