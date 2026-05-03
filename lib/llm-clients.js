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

function buildPrompt(businessName, query) {
  return `${query}\n\nList the top options with brief descriptions of each. If you mention "${businessName}" specifically, describe it in detail.`;
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
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const prompt = buildPrompt(businessName, query);

    for (const modelName of ['gemini-2.0-flash-exp', 'gemini-1.5-pro']) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          tools: [{ google_search: {} }],
        });
        const result = await withTimeout(model.generateContent(prompt));
        const raw = result.response.text().trim();
        return { raw, error: null };
      } catch (err) {
        const isModelMissing =
          err?.status === 404 || /not found|not.*available/i.test(err?.message || '');
        if (!isModelMissing) throw err;
      }
    }
    return { raw: '', error: 'No usable Gemini model available' };
  } catch (err) {
    return { raw: '', error: err.message || 'Gemini request failed' };
  }
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
