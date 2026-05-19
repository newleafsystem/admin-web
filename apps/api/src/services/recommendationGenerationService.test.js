import assert from 'node:assert/strict';

process.env.NEWLEAF_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';

const { createRecommendationGenerationService } = await import('./recommendationGenerationService.js');

let requestPayload = null;
const service = createRecommendationGenerationService({
  serviceConfig: {
    provider: 'openai',
    apiKey: 'test-api-key',
    model: 'test-recommendation-model',
  },
  fetchImpl: async (_url, options) => {
    requestPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  recommendations: [
                    {
                      sourcePromptId: 'prompt_aapl',
                      symbol: 'AAPL',
                      strategy: 'Bull put spread',
                      direction: 'BULLISH',
                      rewardRisk: 1.8,
                      oddsOfProfit: 61,
                      maxProfit: 180,
                      thesis: 'AAPL may act as a data-supported bullish setup.',
                      riskNotes: 'A move below support or volatility expansion may pressure the spread.',
                      lifecycle: {
                        metricAssumptions: {
                          source: 'AI-estimated from prompt-specific spread assumptions',
                          structure: '5-point put spread with 1.80 credit and 3.20 max loss',
                          probabilityBasis: 'Model-estimated from defined-risk spread moneyness',
                          confidence: 'medium',
                        },
                      },
                    },
                  ],
                }),
              },
            },
          ],
        };
      },
    };
  },
});

const result = await service.generateRecommendations({
  prompts: [{ id: 'prompt_aapl', prompt: 'Generate an AAPL defined-risk idea with model-estimated metrics.' }],
  batch: {
    tradeDate: '2026-05-19',
    title: 'Daily Picks',
    theme: 'Defined-risk ideas',
    dateRange: '2026-05-19',
  },
  existingRecommendations: [],
  maxRecommendations: 50,
});

assert.equal(result.model, 'test-recommendation-model');
assert.equal(result.recommendations[0].rewardRisk, 1.8);
assert.equal(result.recommendations[0].maxProfit, 180);

const systemMessage = requestPayload.messages.find((message) => message.role === 'system')?.content ?? '';
const userMessage = JSON.parse(requestPayload.messages.find((message) => message.role === 'user')?.content ?? '{}');
assert.match(systemMessage, /Every quantitative field must be estimated/);
assert.match(systemMessage, /Do not reuse a static metric set/);
assert.equal(userMessage.constraints.quantitativeMetrics.noHardcodedDefaults, true);
assert.equal(userMessage.constraints.quantitativeMetrics.requireMetricAssumptionsWhenMetricsPresent, true);
assert.ok(userMessage.outputSchema.recommendations[0].lifecycle.metricAssumptions);

console.log('Recommendation generation service tests passed.');
