import { config } from '../config.js';
import { badGateway, conflict } from '../lib/httpErrors.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

export function createRecommendationGenerationService({
  serviceConfig = config.ai,
  fetchImpl = fetch,
} = {}) {
  async function generateRecommendations({
    prompts,
    batch,
    existingRecommendations = [],
    maxRecommendations = 50,
  } = {}) {
    assertSupportedProvider(serviceConfig);
    const model = serviceConfig.model ?? DEFAULT_MODEL;
    const prompt = buildPrompt({
      prompts,
      batch,
      existingRecommendations,
      maxRecommendations,
    });
    const rawText = await callOpenAI({
      apiKey: serviceConfig.apiKey,
      baseUrl: serviceConfig.baseUrl,
      model,
      prompt,
      fetchImpl,
    });
    const recommendations = parseRecommendations(rawText);

    return {
      provider: serviceConfig.provider ?? 'openai',
      model,
      recommendations,
      rawText,
    };
  }

  return {
    generateRecommendations,
  };
}

function assertSupportedProvider(serviceConfig = {}) {
  const provider = serviceConfig.provider ?? (serviceConfig.apiKey ? 'openai' : null);
  if (!provider || !serviceConfig.apiKey) {
    throw conflict('AI recommendation generation requires AI_API_KEY or OPENAI_API_KEY.', {
      requiredEnv: ['AI_API_KEY', 'OPENAI_API_KEY'],
    });
  }

  if (!['openai', 'openai-compatible'].includes(provider)) {
    throw conflict('AI recommendation generation currently supports OpenAI-compatible chat completions only.', {
      provider,
      supportedProviders: ['openai', 'openai-compatible'],
    });
  }
}

function buildPrompt({ prompts = [], batch = {}, existingRecommendations = [], maxRecommendations }) {
  return {
    system: [
      'You generate educational, risk-aware options recommendation drafts for the NewLeaf System admin console.',
      'Return only valid JSON. Do not use markdown or prose outside JSON.',
      'Create one recommendation object per prompt row. Do not duplicate existing recommendation symbols unless the prompt explicitly asks for it.',
      'Use conservative language: model-estimated, may act as, data-supported, defined risk, not guaranteed.',
      'Never say a trade is safe, guaranteed, risk-free, certain, or cannot lose money.',
      'Prefer defined-risk options strategies and include clear invalidation or risk notes.',
    ].join(' '),
    user: JSON.stringify({
      task: 'Generate recommendation drafts for admin review. These will not be published until an admin edits, approves, and publishes them.',
      batch: {
        tradeDate: batch.tradeDate,
        title: batch.title,
        theme: batch.theme,
        dateRange: batch.dateRange,
      },
      existingRecommendations: existingRecommendations.map((item) => ({
        symbol: item.symbol,
        strategy: item.strategy,
        direction: item.direction,
        expiry: item.expiry,
      })),
      prompts: prompts.map((item, index) => ({
        id: item.id,
        row: index + 1,
        prompt: item.prompt,
      })),
      outputSchema: {
        recommendations: [
          {
            sourcePromptId: 'Prompt row id that produced this recommendation',
            symbol: 'Ticker symbol, uppercase',
            strategy: 'Defined-risk strategy name',
            direction: 'BULLISH, BEARISH, or NEUTRAL',
            price: 'Number when useful, otherwise null',
            expiry: 'YYYY-MM-DD when useful, otherwise short text or empty string',
            rewardRisk: 'Number when useful, otherwise null',
            oddsOfProfit: '0-100 model-estimated probability when useful, otherwise null',
            maxProfit: 'Number when useful, otherwise null',
            thesis: '2-4 concise sentences with risk-aware reasoning',
            riskNotes: 'Clear invalidation, loss, liquidity, event, or volatility risk',
            entry: 'Actionable but non-guaranteed entry guidance',
            exit: 'Profit-taking, stop, or invalidation guidance',
            ivContext: 'Optional object with volatility context',
            sentiment: 'Optional object with market sentiment context',
            lifecycle: 'Optional object with draft status context',
            legs: 'Optional array of option legs when the prompt provides enough detail',
          },
        ],
      },
      constraints: {
        maximumTotalRecommendationsAfterAppend: maxRecommendations,
        recommendationCount: prompts.length,
        requireSymbolStrategyThesis: true,
        publicCompliance: 'Educational only. No guaranteed-profit claims.',
      },
    }),
  };
}

async function callOpenAI({ apiKey, baseUrl, model, prompt, fetchImpl }) {
  const response = await fetchImpl(baseUrl ?? OPENAI_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }),
  });
  const body = await response.json().catch(() => ({}));
  assertProviderOk(response, body);
  return body.choices?.[0]?.message?.content ?? '';
}

function parseRecommendations(rawText) {
  const jsonText = extractJson(String(rawText ?? '').trim());
  if (!jsonText) {
    throw badGateway('AI recommendation generation returned invalid JSON.');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw badGateway('AI recommendation generation returned malformed JSON.', {
      parseError: error.message,
    });
  }

  const recommendations = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.recommendations)
      ? parsed.recommendations
      : Array.isArray(parsed.picks)
        ? parsed.picks
        : [];

  if (recommendations.length === 0) {
    throw badGateway('AI recommendation generation returned no recommendations.');
  }

  return recommendations;
}

function extractJson(text) {
  if (!text) return null;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

function assertProviderOk(response, body) {
  if (response.ok) return;

  const providerError = body.error ?? body;
  const providerMessage =
    providerError?.message ??
    providerError?.error_description ??
    providerError?.detail ??
    'AI recommendation generation request failed';
  const details = {
    status: response.status,
    error: providerError,
  };

  if (response.status === 429) {
    throw conflict('AI recommendation generation rate limit or quota was reached.', details);
  }

  if ([400, 401, 403, 404].includes(response.status)) {
    throw conflict(`AI recommendation generation request failed: ${providerMessage}`, details);
  }

  throw badGateway(`AI recommendation generation request failed: ${providerMessage}`, details);
}
