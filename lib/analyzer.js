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

  // Always center the snippet on the brand mention. Sentence splitting on
  // markdown-heavy AI responses is unreliable — periods inside URLs, ratings
  // like "3.9", and addresses like "75056" produce huge "sentences" that
  // truncate before the brand is shown.
  const needle = matchedVariant.toLowerCase();
  const idx = rawText.toLowerCase().indexOf(needle);
  if (idx < 0) return '';
  const start = Math.max(0, idx - 100);
  const end = Math.min(rawText.length, idx + needle.length + 220);
  let quote = rawText.slice(start, end).trim();
  if (start > 0) quote = '…' + quote;
  if (end < rawText.length) quote = quote + '…';
  return quote;
}

// Estimate where the brand sits in the list of recommendations. Looks for
// common item-start patterns in AI search responses (numbered lists, markdown
// bold headers like **[Brand](url)**, bullets, and ATX headers). Returns
// { position, total } 1-indexed, or null if a list structure can't be
// reliably inferred.
export function estimateListPosition(rawText, matchedVariant) {
  if (!rawText || !matchedVariant) return null;

  const haystack = rawText.toLowerCase();
  const brandIdx = haystack.indexOf(matchedVariant.toLowerCase());
  if (brandIdx < 0) return null;

  // Each pattern is checked at the start of a line.
  const itemPatterns = [
    /^\s*\d+[\.)]\s+/, // "1. " or "1) "
    /^\s*[\*\-•]\s+/, // bullets
    /^\s*#{1,4}\s+/, // markdown headers
    /^\s*\*\*\[/, // markdown bold-link header (ChatGPT search-preview style)
    /^\s*\*\*[A-Z0-9]/, // markdown bold header without link
  ];

  const itemStarts = [];
  let charPos = 0;
  for (const line of rawText.split('\n')) {
    if (itemPatterns.some((re) => re.test(line))) {
      itemStarts.push(charPos);
    }
    charPos += line.length + 1;
  }

  if (itemStarts.length < 2) return null;

  let brandItem = -1;
  for (let i = 0; i < itemStarts.length; i++) {
    const itemStart = itemStarts[i];
    const itemEnd = i + 1 < itemStarts.length ? itemStarts[i + 1] : rawText.length;
    if (brandIdx >= itemStart && brandIdx < itemEnd) {
      brandItem = i;
      break;
    }
  }
  if (brandItem < 0) return null;

  return { position: brandItem + 1, total: itemStarts.length };
}

export async function classifySentiment(quote, businessName, query, fullResponse) {
  if (!quote || !quote.trim()) return 'neutral';
  if (!process.env.ANTHROPIC_API_KEY) return 'neutral';

  // Pass the full response (truncated) so the classifier can see where the
  // business ranks in the list, not just the snippet around the mention.
  const context = (fullResponse || quote).slice(0, 5000);

  // Deterministic position check overrides Haiku for unambiguous last-place
  // cases. LLMs are unreliable at counting list items; we can do this exactly.
  const { matchedVariant } = detectPresence(context, businessName);
  const pos = estimateListPosition(context, matchedVariant || businessName);
  if (pos && pos.total >= 3 && pos.position === pos.total) {
    return 'mediocre';
  }
  const positionLine = pos
    ? `Position in the list: item ${pos.position} of ${pos.total}.`
    : '';

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userPrompt = [
      `User query: ${query}`,
      `Business to evaluate: ${businessName}`,
      positionLine,
      ``,
      `Full AI engine response:`,
      `---`,
      context,
      `---`,
      ``,
      `Where does ${businessName} appear in this response, and how is it characterized as a recommendation? One word only.`,
    ].filter(Boolean).join('\n');
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      system: [
        'You classify how an AI engine characterizes a business in response to a user query.',
        'Respond with EXACTLY one word from: enthusiastic, positive, neutral, mediocre, negative.',
        '',
        'Both LANGUAGE and POSITION matter. The position of the business within the list of recommendations is the dominant signal — being listed last is materially worse than being listed first, regardless of tone.',
        '',
        '- enthusiastic: opens the response or is the explicit #1 pick, with distinctive praise. Top-of-list AND positive language.',
        '- positive: recommended favorably and appears in the upper third of the list, with descriptive support.',
        '- neutral: appears in the middle of the list with non-distinctive descriptive weight.',
        '- mediocre: appears in the bottom third / listed last, OR mentioned with backhanded/lukewarm framing, OR mentioned only to disclaim ("isn\'t actually located in", "is closed", "may not be open"), OR ranked clearly below most competitors.',
        '- negative: actively warned against or criticized.',
        '',
        'A business listed last among 5+ recommendations is mediocre even if the language about it is neutral or positive — the rank itself is the signal.',
        '',
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

  let { detected, matchedVariant } = detectPresence(raw, businessName);
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
  const position = detected ? estimateListPosition(raw, matchedVariant) : null;
  return {
    llm,
    detected,
    quote,
    position,
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
  const pos = partial.position;
  const positionTag = pos ? ` (${pos.position} of ${pos.total})` : '';

  if (partial._hallucinated) {
    verdict = 'Not surfaced in current web search. Brand appears only in training data, not in cited sources.';
  } else if (!detected) {
    verdict = 'Not surfaced. Competitors ranked in your place.';
  } else if (resolvedSentiment === 'enthusiastic') {
    verdict = `Top recommendation${positionTag}. Cited prominently with distinctive language.`;
  } else if (resolvedSentiment === 'positive') {
    verdict = `Recommended favorably${positionTag}, in the upper portion of results.`;
  } else if (resolvedSentiment === 'neutral') {
    verdict = `Mentioned in the middle of the list${positionTag} without distinctive weight.`;
  } else if (resolvedSentiment === 'mediocre') {
    verdict = pos && pos.position === pos.total && pos.total >= 3
      ? `Listed last (${pos.position} of ${pos.total}). Ranked below every competitor.`
      : `Listed below competitors${positionTag}. Mentioned as an also-ran or with lukewarm framing.`;
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
