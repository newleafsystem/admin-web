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
    marketDrafts = [],
  } = {}) {
    assertSupportedProvider(serviceConfig);
    const model = serviceConfig.model ?? DEFAULT_MODEL;
    const prompt = buildPrompt({
      prompts,
      batch,
      existingRecommendations,
      maxRecommendations,
      marketDrafts,
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

function buildPrompt({
  prompts = [],
  batch = {},
  existingRecommendations = [],
  maxRecommendations,
  marketDrafts = [],
}) {
  return {
    system: [
      'You generate educational, risk-aware options recommendation drafts for the NewLeaf System admin console.',
      'Return only valid JSON. Do not use markdown or prose outside JSON.',
      'Create one recommendation object per prompt row. Do not duplicate existing recommendation symbols unless the prompt explicitly asks for it.',
      'When marketDataDrafts are provided, treat their symbol, price, marketData, strategy, direction, expiry, legs, maxProfit, maxLoss, rewardRisk, oddsOfProfit, breakevens, and Greeks as the source of truth for every field that is present.',
      'Do not estimate the underlying stock price yourself; return null for price unless a marketDataDraft provides it for that prompt row.',
      'Preserve marketDataDraft numeric fields exactly; do not recalculate, round differently, or replace them with AI-estimated values.',
      'Use Alpaca option-chain calculations, R2 gamma context, and supplied market context to write the thesis, risk notes, entry, exit, IV context, and sentiment context.',
      'Every quantitative field must be estimated for that specific recommendation, not copied from examples or defaults.',
      'Do not reuse a static metric set across rows, and do not invent filler values such as 1.5 reward/risk, 65 probability, or 150 max profit unless the prompt-specific assumptions justify them.',
      'When you provide rewardRisk, oddsOfProfit, maxProfit, or option legs, include lifecycle.metricAssumptions describing the model-estimated structure, premium/debit/credit assumptions, max loss or width, and probability basis.',
      'If a numeric metric cannot be estimated from the prompt and your stated assumptions, return null for that field.',
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
      marketDataDrafts: marketDrafts.map((item) => ({
        sourcePromptId: item.sourcePromptId,
        symbol: item.symbol,
        strategy: item.strategy,
        direction: item.direction,
        price: item.price,
        expiry: item.expiry,
        dte: item.dte,
        rewardRisk: item.rewardRisk,
        oddsOfProfit: item.oddsOfProfit,
        maxProfit: item.maxProfit,
        maxLoss: item.maxLoss,
        netCredit: item.netCredit,
        breakevens: item.breakevens,
        greeks: item.greeks,
        legs: item.legs,
        ivContext: item.ivContext,
        sentiment: item.sentiment,
        lifecycle: {
          metricAssumptions: item.lifecycle?.metricAssumptions,
          marketData: item.lifecycle?.marketData,
          gammaContext: item.lifecycle?.gammaContext,
          sentimentContext: item.lifecycle?.sentimentContext,
          calculation: item.lifecycle?.calculation,
          warnings: item.lifecycle?.warnings,
        },
      })),
      outputSchema: {
        recommendations: [
          {
            sourcePromptId: 'Prompt row id that produced this recommendation',
            symbol: 'Ticker symbol, uppercase',
            strategy: 'Defined-risk strategy name',
            direction: 'BULLISH, BEARISH, or NEUTRAL',
            price: 'Use the marketDataDraft price for that prompt row, otherwise null',
            expiry: 'YYYY-MM-DD when useful, otherwise short text or empty string',
            rewardRisk: 'Number when useful, otherwise null',
            oddsOfProfit: '0-100 model-estimated probability when useful, otherwise null',
            maxProfit: 'Number when useful, otherwise null',
            maxLoss: 'Number when useful, otherwise null',
            netCredit: 'Number for credit strategies when useful, otherwise null',
            thesis: '2-4 concise sentences with risk-aware reasoning',
            riskNotes: 'Clear invalidation, loss, liquidity, event, or volatility risk',
            entry: 'Actionable but non-guaranteed entry guidance',
            exit: 'Profit-taking, stop, or invalidation guidance',
            ivContext: 'Optional object with volatility context',
            sentiment: 'Optional object with market sentiment context',
            lifecycle: {
              metricAssumptions: {
                source: 'How the AI estimated any numeric metrics for this specific recommendation',
                structure: 'Spread width, credit/debit, premium, max-loss, or other assumptions used',
                probabilityBasis: 'Why oddsOfProfit is model-estimated for this setup, or null',
                confidence: 'low, medium, or high',
              },
            },
            legs: 'Optional array of option legs with strikes, action, type, quantity, and premium/debit/credit assumptions when useful',
          },
        ],
      },
      constraints: {
        maximumTotalRecommendationsAfterAppend: maxRecommendations,
        recommendationCount: prompts.length,
        requireSymbolStrategyThesis: true,
        quantitativeMetrics: {
          source: marketDrafts.length
            ? 'Use marketDataDrafts first. Otherwise AI-estimated per prompt row.'
            : 'AI-estimated per prompt row',
          noHardcodedDefaults: true,
          requireMetricAssumptionsWhenMetricsPresent: true,
          unsupportedMetricValue: null,
          preserveProvidedMarketDataDrafts: true,
        },
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
