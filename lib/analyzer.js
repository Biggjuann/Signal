import Anthropic from '@anthropic-ai/sdk';

const SENTIMENT_VALUES = ['enthusiastic', 'positive', 'neutral', 'mediocre', 'negative'];
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'at', 'in', 'on', 'for', 'to', 'with', 'by',
  'inc', 'llc', 'co', 'corp', 'company', 'group', 'restaurant', 'shop', 'store',
]);

function normalize(s) {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function distinctiveTokens(name) {
  return normalize(name)
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t) && t.length > 2);
}

function buildVariants(businessName) {
  const variants = new Set();
  const full = businessName.trim();
  if (full) variants.add(full);

  const tokens = distinctiveTokens(businessName);
  if (tokens.length >= 2) {
    variants.add(tokens.slice(0, 3).join(' '));
    variants.add(tokens.slice(0, 2).join(' '));
  } else if (tokens.length === 1 && tokens[0].length >= 5) {
    variants.add(tokens[0]);
  }
  return [...variants];
}

export function detectPresence(rawText, businessName) {
  if (!rawText || !businessName) return { detected: false, matchedVariant: null };
  const haystack = rawText.toLowerCase();
  const variants = buildVariants(businessName);
  for (const v of variants) {
    if (haystack.includes(v.toLowerCase())) {
      return { detected: true, matchedVariant: v };
    }
  }
  return { detected: false, matchedVariant: null };
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function extractCharacterization(rawText, businessName) {
  const { detected, matchedVariant } = detectPresence(rawText, businessName);
  if (!detected) return '';

  const needle = matchedVariant.toLowerCase();
  const sentences = splitSentences(rawText);
  const hits = sentences.filter((s) => s.toLowerCase().includes(needle));
  if (hits.length === 0) {
    const idx = rawText.toLowerCase().indexOf(needle);
    const start = Math.max(0, idx - 80);
    const end = Math.min(rawText.length, idx + needle.length + 160);
    return rawText.slice(start, end).trim();
  }
  let quote = hits.slice(0, 2).join(' ');
  if (quote.length > 320) quote = quote.slice(0, 317).trimEnd() + '…';
  return quote;
}

export async function classifySentiment(quote, businessName, query) {
  if (!quote || !quote.trim()) return 'neutral';
  if (!process.env.ANTHROPIC_API_KEY) return 'neutral';

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userPrompt = [
      `User query: ${query}`,
      `Business: ${businessName}`,
      `AI engine response snippet:`,
      quote,
      ``,
      `Classify how the engine characterizes ${businessName} as a recommendation for the user query. One word only.`,
    ].join('\n');
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      system: [
        'You classify how an AI engine characterizes a business in response to a user query.',
        'Respond with EXACTLY one word from: enthusiastic, positive, neutral, mediocre, negative.',
        'Use these rules:',
        '- enthusiastic: top-of-list, distinctive praise, signature item highlighted',
        '- positive: recommended favorably with descriptive support',
        '- neutral: mentioned without descriptive weight, listed alongside others',
        '- mediocre: backhanded, lukewarm, listed as also-ran, or mentioned only to disclaim/caveat (e.g. "isn\'t actually located in", "is closed", "may not be open")',
        '- negative: actively warned against or criticized',
        'No punctuation, no explanation.',
      ].join('\n'),
      messages: [{ role: 'user', content: userPrompt }],
    });
    const word = (message.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    return SENTIMENT_VALUES.includes(word) ? word : 'neutral';
  } catch {
    return 'neutral';
  }
}

const CHARACTERIZATION_POINTS = {
  enthusiastic: 7.5,
  positive: 5,
  neutral: 2.5,
  mediocre: 1,
  negative: 0,
};

function statusFor(detected, sentiment) {
  if (!detected) return 'invisible';
  if (sentiment === 'enthusiastic' || sentiment === 'positive') return 'present';
  return 'weak';
}

const SENTIMENT_LABEL = {
  enthusiastic: 'Strong signal',
  positive: 'Present',
  neutral: 'Weak signal',
  mediocre: 'Weak signal',
  negative: 'Negative mention',
};

export function buildEngineResult({ llm, raw, error, businessName, sources }) {
  if (error) {
    return {
      llm,
      detected: false,
      verdict: 'API error — engine could not be queried.',
      quote: error,
      status: 'invisible',
      label: 'Error',
      sentiment: null,
      raw_response: '',
      error,
    };
  }

  let { detected } = detectPresence(raw, businessName);
  let hallucinated = false;

  // If the engine returned its grounded source list, the brand must appear in
  // at least one source title/URL. A brand mentioned in the response body but
  // not in any cited source is training-data padding, not real web visibility.
  if (detected && Array.isArray(sources) && sources.length > 0) {
    const sourcesText = sources.map((s) => `${s.title || ''} ${s.uri || ''}`).join(' ');
    const inSources = detectPresence(sourcesText, businessName).detected;
    if (!inSources) {
      detected = false;
      hallucinated = true;
    }
  }

  const quote = detected ? extractCharacterization(raw, businessName) : '';
  return {
    llm,
    detected,
    quote,
    raw_response: raw,
    error: null,
    _needsSentiment: detected,
    _hallucinated: hallucinated,
    sources_count: Array.isArray(sources) ? sources.length : null,
  };
}

export function finalizeEngineResult(partial, sentiment) {
  const detected = partial.detected;
  const resolvedSentiment = detected ? sentiment || 'neutral' : null;
  const status = statusFor(detected, resolvedSentiment);
  let verdict;
  if (partial._hallucinated) {
    verdict = 'Not surfaced in current web search. Brand appears only in training data, not in cited sources.';
  } else if (!detected) {
    verdict = 'Not surfaced. Competitors ranked in your place.';
  } else if (resolvedSentiment === 'enthusiastic') {
    verdict = 'Cited prominently with strong, distinctive language.';
  } else if (resolvedSentiment === 'positive') {
    verdict = 'Mentioned with positive descriptive context.';
  } else if (resolvedSentiment === 'neutral') {
    verdict = 'Mentioned, but with neutral, undifferentiated language.';
  } else if (resolvedSentiment === 'mediocre') {
    verdict = 'Mentioned with backhanded or lukewarm characterization.';
  } else {
    verdict = 'Mentioned with negative characterization.';
  }
  const label = detected ? SENTIMENT_LABEL[resolvedSentiment] : 'Invisible';
  return {
    llm: partial.llm,
    detected,
    verdict,
    quote: partial.quote || '',
    status,
    label,
    sentiment: resolvedSentiment,
    raw_response: partial.raw_response,
    error: null,
  };
}

export function computeScore(results) {
  let total = 0;
  let detectedCount = 0;
  for (const r of Object.values(results)) {
    if (r.error) continue;
    if (r.detected) {
      total += 15;
      detectedCount += 1;
      total += CHARACTERIZATION_POINTS[r.sentiment] ?? 2.5;
    }
  }
  let consistency = 0;
  if (detectedCount >= 3) consistency = 10;
  else if (detectedCount === 2) consistency = 5;
  total += consistency;
  return Math.max(0, Math.min(100, Math.round(total)));
}

export function buildHeadline(score, results) {
  const detectedCount = Object.values(results).filter((r) => !r.error && r.detected).length;
  const errored = Object.values(results).filter((r) => r.error).length;

  if (score <= 30) {
    return errored > 0
      ? `<em>Critical visibility gap.</em> Brand surfaces on at most ${detectedCount} of ${4 - errored} reachable engines.`
      : '<em>Critical visibility gap.</em> The brand is invisible or mischaracterized across most engines.';
  }
  if (score <= 50) {
    return '<em>Fractured presence.</em> The brand surfaces inconsistently and lacks a coherent description across engines.';
  }
  if (score <= 70) {
    return '<em>Moderate visibility.</em> Present, but undifferentiated — mentions exist without strong descriptive weight.';
  }
  if (score <= 85) {
    return '<em>Strong positioning.</em> Cited consistently and described in distinctive language.';
  }
  return '<em>Category-dominant.</em> The brand owns the answer across every engine tested.';
}
