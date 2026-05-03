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
  // Audit measures organic brand surfacing — the prompt must NOT mention the
  // business by name, or we bias the test toward false positives.
  return `${query}\n\nList the top recommendations with a brief description of each. Be specific — name actual businesses, not generic categories.`;
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

  for (const model of ['gpt-4o-search-preview', 'gpt-4o']) {
    try {
      const completion = await withTimeout(
        client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
        })
      );
      const raw = completion.choices?.[0]?.message?.content?.trim() || '';
      return { raw, error: null };
    } catch (err) {
      const isModelMissing =
        err?.status === 404 ||
        /model.*not found|does not exist|not.*available/i.test(err?.message || '');
      if (!isModelMissing) {
        return { raw: '', error: err.message || 'ChatGPT request failed' };
      }
    }
  }
  return { raw: '', error: 'No usable OpenAI model available' };
}

export async function queryGemini(businessName, query) {
  if (!process.env.GEMINI_API_KEY) {
    return { raw: '', error: 'Missing GEMINI_API_KEY' };
  }
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const prompt = buildPrompt(businessName, query);

  // Try newer 2.x models with googleSearch grounding first, fall back to 1.5
  // models with the legacy googleSearchRetrieval tool, then to no tools at all.
  // Different API keys / SDK versions support different combinations.
  const attempts = [
    { model: 'gemini-2.0-flash', tools: [{ googleSearch: {} }] },
    { model: 'gemini-2.0-flash-exp', tools: [{ googleSearch: {} }] },
    { model: 'gemini-2.0-flash', tools: undefined },
    { model: 'gemini-1.5-flash', tools: [{ googleSearchRetrieval: {} }] },
    { model: 'gemini-1.5-flash', tools: undefined },
    { model: 'gemini-1.5-pro', tools: undefined },
  ];

  let lastError = null;
  for (const { model: modelName, tools } of attempts) {
    try {
      const cfg = { model: modelName };
      if (tools) cfg.tools = tools;
      const model = genAI.getGenerativeModel(cfg);
      const result = await withTimeout(model.generateContent(prompt));
      const raw = result.response.text().trim();
      if (raw) return { raw, error: null };
    } catch (err) {
      lastError = err;
    }
  }
  return { raw: '', error: lastError?.message || 'No Gemini model + tool combination succeeded' };
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
