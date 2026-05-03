import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const TIMEOUT_MS = 45_000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function buildPrompt(_businessName, query) {
  // The audit measures organic brand surfacing. The prompt must (a) NOT mention
  // the business by name, and (b) NOT instruct the model to list brand names —
  // both biases push toward false positives. Mimic how a real user phrases it.
  return query;
}

export async function queryClaude(businessName, query) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { raw: '', error: 'Missing ANTHROPIC_API_KEY' };
  }
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await withTimeout(
      client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 1024,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: buildPrompt(businessName, query) }],
      })
    );
    const raw = (message.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { raw, error: null };
  } catch (err) {
    return { raw: '', error: err.message || 'Claude request failed' };
  }
}

export async function queryChatGPT(businessName, query) {
  if (!process.env.OPENAI_API_KEY) {
    return { raw: '', error: 'Missing OPENAI_API_KEY' };
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const prompt = buildPrompt(businessName, query);

  // Web search is REQUIRED. Plain gpt-4o without search answers from training
  // data and hallucinates brand mentions, which made earlier audits show
  // businesses as "present" on engines where consumer ChatGPT does not surface
  // them. Try search-enabled models only; do not fall back to non-search models.
  const searchModels = ['gpt-4o-search-preview', 'gpt-4o-mini-search-preview'];
  let lastError = null;

  for (const model of searchModels) {
    try {
      const completion = await withTimeout(
        client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
        })
      );
      const raw = completion.choices?.[0]?.message?.content?.trim() || '';
      if (raw) return { raw, error: null };
    } catch (err) {
      lastError = err;
      const isModelMissing =
        err?.status === 404 ||
        /model.*not found|does not exist|not.*available/i.test(err?.message || '');
      if (!isModelMissing) {
        return { raw: '', error: err.message || 'ChatGPT request failed' };
      }
    }
  }
  return {
    raw: '',
    error: `ChatGPT search models unavailable on this key${lastError ? ': ' + lastError.message : ''}. The audit requires a search-enabled model — enable gpt-4o-search-preview access in the OpenAI dashboard.`,
  };
}

async function listGeminiModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await withTimeout(fetch(url), 10_000);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ListModels ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const names = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => (m.name || '').replace(/^models\//, ''))
    .filter(Boolean);

  const score = (n) => {
    let s = 0;
    if (/2\.5/.test(n)) s += 100;
    else if (/2\.0/.test(n)) s += 50;
    else if (/1\.5/.test(n)) s += 25;
    if (/flash/.test(n)) s += 10;
    if (/-latest$/.test(n)) s += 3;
    if (/exp/.test(n)) s -= 4;
    if (/-8b/.test(n)) s -= 2;
    if (/-\d{3}$/.test(n)) s -= 1;
    return s;
  };
  return names.sort((a, b) => score(b) - score(a));
}

export async function queryGemini(businessName, query) {
  if (!process.env.GEMINI_API_KEY) {
    return { raw: '', error: 'Missing GEMINI_API_KEY' };
  }
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const prompt = buildPrompt(businessName, query);

  let candidates;
  try {
    candidates = await listGeminiModels(process.env.GEMINI_API_KEY);
  } catch (err) {
    return { raw: '', error: `Gemini ListModels failed: ${err.message}` };
  }
  if (!candidates.length) {
    return { raw: '', error: 'Gemini API key has no models that support generateContent' };
  }

  // Grounding is REQUIRED. We test what real users see — i.e. the live web
  // search the consumer app does. An ungrounded response answers from training
  // data and produces hallucinated brand mentions that don't match reality.
  // Try both tool naming conventions; never fall back to no-tools.
  const toolVariants = [
    [{ googleSearch: {} }],
    [{ googleSearchRetrieval: {} }],
  ];

  let lastError = null;
  for (const modelName of candidates.slice(0, 3)) {
    for (const tools of toolVariants) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName, tools });
        const result = await withTimeout(model.generateContent(prompt));
        const raw = result.response.text().trim();
        if (raw) return { raw, error: null };
      } catch (err) {
        lastError = err;
      }
    }
  }
  return {
    raw: '',
    error: `Gemini grounding failed across ${candidates.slice(0, 3).join(', ')}: ${lastError?.message || 'unknown'}. The audit requires Google Search grounding — enable it on the API key.`,
  };
}

export async function queryPerplexity(businessName, query) {
  if (!process.env.PERPLEXITY_API_KEY) {
    return { raw: '', error: 'Missing PERPLEXITY_API_KEY' };
  }
  try {
    const client = new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY,
      baseURL: 'https://api.perplexity.ai',
    });
    const completion = await withTimeout(
      client.chat.completions.create({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: buildPrompt(businessName, query) }],
      })
    );
    const raw = completion.choices?.[0]?.message?.content?.trim() || '';
    return { raw, error: null };
  } catch (err) {
    return { raw: '', error: err.message || 'Perplexity request failed' };
  }
}

export const clients = {
  claude: queryClaude,
  chatgpt: queryChatGPT,
  gemini: queryGemini,
  perplexity: queryPerplexity,
};
