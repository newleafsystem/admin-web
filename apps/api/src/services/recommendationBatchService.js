import { badRequest, conflict, notFound } from '../lib/httpErrors.js';

export const RECOMMENDATION_BATCH_STATUSES = Object.freeze(['draft', 'approved', 'published', 'archived']);
export const RECOMMENDATION_DIRECTIONS = Object.freeze(['BULLISH', 'BEARISH', 'NEUTRAL']);
export const MAX_RECOMMENDATIONS_PER_BATCH = 50;
const MAX_GENERATION_PROMPTS = 25;
const MAX_GENERATION_PROMPT_CHARS = 4000;

export function createRecommendationBatchService({
  repository,
  jobStateService,
  recommendationGenerationService,
  clock = () => new Date().toISOString(),
} = {}) {
  if (!repository) {
    throw new Error('recommendationBatchService requires repository');
  }

  async function listBatches(filters = {}) {
    const batches = await repository.listRecommendationBatches({
      status: cleanBatchStatus(filters.status, { optional: true }),
    });
    return batches.map(normalizeBatchRecord);
  }

  async function getBatch(batchId) {
    const batch = await requireBatch(batchId);
    return normalizeBatchRecord(batch);
  }

  async function createBatch(input, { actorUid = null } = {}) {
    const timestamp = clock();
    const normalized = normalizeBatchInput(input, { timestamp });
    const batch = await repository.createRecommendationBatch({
      ...normalized,
      status: 'draft',
      channels: initialChannels(timestamp),
      createdBy: actorUid,
      metadata: {
        ...(normalized.metadata ?? {}),
        source: 'admin-curated',
      },
    });
    return normalizeBatchRecord(batch);
  }

  async function updateBatch(batchId, input, { actorUid = null } = {}) {
    const existing = await requireBatch(batchId);
    if (existing.status === 'published') {
      throw conflict('Published recommendation batches cannot be edited. Create a new batch or republish channels.', {
        batchId,
      });
    }

    const normalized = normalizeBatchInput(
      {
        ...existing,
        ...input,
        recommendations: Object.prototype.hasOwnProperty.call(input, 'recommendations')
          ? input.recommendations
          : existing.recommendations,
      },
      { timestamp: existing.createdAt ?? clock(), partial: true },
    );
    const updated = await repository.updateRecommendationBatch(batchId, {
      ...normalized,
      status: existing.status === 'approved' ? 'draft' : existing.status,
      approvedAt: null,
      approvedBy: null,
      updatedBy: actorUid,
    });
    return normalizeBatchRecord(updated);
  }

  async function generateRecommendations(input, { actorUid = null } = {}) {
    if (!recommendationGenerationService?.generateRecommendations) {
      throw conflict('AI recommendation generation is not configured.');
    }

    const timestamp = clock();
    const request = normalizeGenerationInput(input);
    const existing = request.batchId
      ? await requireBatch(request.batchId)
      : await findOpenBatchForTradeDate(request.tradeDate);

    if (existing?.status === 'published') {
      throw conflict('Published recommendation batches cannot be edited. Create a new batch or republish channels.', {
        batchId: existing.id,
      });
    }
    if (existing?.status === 'archived') {
      throw conflict('Archived recommendation batches cannot be edited', {
        batchId: existing.id,
      });
    }

    const batchContext = batchContextForGeneration(existing, request, timestamp);
    const existingRecommendations = normalizeRecommendations(batchContext.recommendations ?? [], { allowEmpty: true });
    const remainingSlots = MAX_RECOMMENDATIONS_PER_BATCH - existingRecommendations.length;
    if (remainingSlots <= 0) {
      throw conflict(`This batch already has ${MAX_RECOMMENDATIONS_PER_BATCH} recommendations.`, {
        maxItems: MAX_RECOMMENDATIONS_PER_BATCH,
      });
    }

    const generated = await recommendationGenerationService.generateRecommendations({
      prompts: request.prompts,
      batch: batchContext,
      existingRecommendations,
      maxRecommendations: MAX_RECOMMENDATIONS_PER_BATCH,
    });
    const generatedRecommendations = normalizeGeneratedRecommendations(
      generated.recommendations.slice(0, remainingSlots),
      {
        existingRecommendations,
        prompts: request.prompts,
        timestamp,
      },
    );
    if (generatedRecommendations.length === 0) {
      throw conflict('AI recommendation generation did not produce any usable recommendations.');
    }

    const recommendations = [...existingRecommendations, ...generatedRecommendations];
    const generationSummary = {
      at: timestamp,
      by: actorUid,
      provider: generated.provider,
      model: generated.model,
      promptCount: request.prompts.length,
      generatedCount: generatedRecommendations.length,
      appendedToBatchId: existing?.id ?? null,
    };
    const normalized = normalizeBatchInput(
      {
        ...batchContext,
        recommendations,
        metadata: mergeGenerationMetadata(batchContext.metadata, generationSummary),
      },
      { timestamp: batchContext.createdAt ?? timestamp },
    );

    const saved = existing
      ? await repository.updateRecommendationBatch(existing.id, {
          ...normalized,
          status: 'draft',
          approvedAt: null,
          approvedBy: null,
          publicData: null,
          updatedBy: actorUid,
        })
      : await repository.createRecommendationBatch({
          ...normalized,
          status: 'draft',
          channels: initialChannels(timestamp),
          createdBy: actorUid,
        });

    return normalizeBatchRecord(saved);
  }

  async function approveBatch(batchId, { actorUid = null } = {}) {
    const existing = await requireBatch(batchId);
    if (existing.status === 'published') {
      return normalizeBatchRecord(existing);
    }
    if (existing.status === 'archived') {
      throw conflict('Archived recommendation batches cannot be approved', { batchId });
    }
    assertRecommendationCount(existing.recommendations);
    const timestamp = clock();
    const approved = await repository.updateRecommendationBatch(batchId, {
      status: 'approved',
      approvedAt: timestamp,
      approvedBy: actorUid,
      channels: mergeChannels(existing.channels, {
        review: { status: 'approved', updatedAt: timestamp, actorUid },
      }),
    });
    return normalizeBatchRecord(approved);
  }

  async function publishBatch(batchId, { actorUid = null } = {}) {
    const existing = await requireBatch(batchId);
    if (existing.status === 'archived') {
      throw conflict('Archived recommendation batches cannot be published', { batchId });
    }
    if (existing.status === 'draft') {
      throw conflict('Approve the recommendation batch before publishing it', { batchId });
    }

    const timestamp = clock();
    const publicData = buildPublicRecommendationBatch(existing, timestamp);
    const scriptJob = await ensureScriptJob(existing, publicData, { actorUid, timestamp });
    const channels = mergeChannels(existing.channels, {
      liveSite: {
        status: 'published',
        updatedAt: timestamp,
        actorUid,
        artifact: 'api-public-recommendation-batch',
      },
      email: {
        status: existing.channels?.email?.status === 'sent' ? 'sent' : 'queued',
        updatedAt: timestamp,
        actorUid,
      },
      pdf: {
        status: existing.channels?.pdf?.status === 'ready' ? 'ready' : 'queued',
        updatedAt: timestamp,
        actorUid,
      },
      script: {
        status: 'ready',
        updatedAt: timestamp,
        actorUid,
        jobId: scriptJob.id,
      },
      video: {
        status: scriptJob.status ?? 'script_ready',
        updatedAt: timestamp,
        actorUid,
        jobId: scriptJob.id,
      },
    });

    const published = await repository.updateRecommendationBatch(batchId, {
      status: 'published',
      publicData,
      scriptJobId: scriptJob.id,
      channels,
      publishedAt: existing.publishedAt ?? timestamp,
      publishedBy: existing.publishedBy ?? actorUid,
    });
    return normalizeBatchRecord(published);
  }

  async function getLatestPublishedBatch() {
    const batch = await repository.getLatestPublishedRecommendationBatch();
    return batch ? normalizeBatchRecord(batch) : null;
  }

  async function getPublishedBatch(batchId) {
    const batch = await requireBatch(batchId);
    if (batch.status !== 'published') {
      throw notFound('Published recommendation batch not found', { batchId });
    }
    return normalizeBatchRecord(batch);
  }

  async function findOpenBatchForTradeDate(tradeDate) {
    return findOpenBatchForTradeDateFromRepository(repository, tradeDate);
  }

  async function requireBatch(batchId) {
    const normalizedId = cleanString(batchId, { maxLength: 160 });
    if (!normalizedId) {
      throw badRequest('Recommendation batch id is required');
    }
    const batch = await repository.getRecommendationBatch(normalizedId);
    if (!batch) {
      throw notFound('Recommendation batch not found', { batchId: normalizedId });
    }
    return batch;
  }

  async function ensureScriptJob(batch, publicData, { actorUid, timestamp }) {
    if (batch.scriptJobId) {
      const existingJob = await repository.getJob(batch.scriptJobId);
      if (existingJob) {
        return existingJob;
      }
    }
    const script = buildHeyGenScript(publicData);
    const scenes = buildHeyGenScenes(publicData);
    const createJob = jobStateService?.createJob
      ? (input) => jobStateService.createJob(input)
      : (input) => repository.createJob(input);

    return createJob({
      title: `Daily Picks - ${publicData.tradeDate}`,
      type: 'recommendation_video',
      status: 'script_ready',
      sourceType: 'text_to_heygen',
      ownerUid: actorUid,
      targetDurationSec: 180,
      metadata: {
        owner: actorUid ?? 'admin',
        topic: 'Daily picks recommendations',
        sourceArtifact: 'Recommendation batch',
        sourceType: 'text_to_heygen',
        stage: 'Recommendation script ready',
        intakeMode: 'text_to_heygen',
        intakeModeLabel: 'Text to HeyGen',
        recommendationBatchId: batch.id,
        recommendationTradeDate: publicData.tradeDate,
        prompt: script,
        reviewScriptText: script,
        scriptPreview: scenes.map((scene) => scene.narration),
        scriptQuality: 'Generated from approved recommendation batch',
        scenes,
        recommendations: publicData.recommendations.map((item) => ({
          id: item.id,
          symbol: item.symbol,
          strategy: item.strategy,
          direction: item.direction,
          thesis: item.thesis,
          riskNotes: item.riskNotes,
        })),
        createdFromRecommendationAt: timestamp,
      },
    });
  }

  return {
    listBatches,
    getBatch,
    createBatch,
    updateBatch,
    generateRecommendations,
    approveBatch,
    publishBatch,
    getLatestPublishedBatch,
    getPublishedBatch,
  };
}

function normalizeGenerationInput(input = {}) {
  const batchId = cleanString(input.batchId, { maxLength: 160 });
  const tradeDate = cleanDate(input.tradeDate);
  if (!batchId && !tradeDate) {
    throw badRequest('tradeDate is required when batchId is not provided');
  }

  return {
    batchId,
    tradeDate,
    title: cleanString(input.title, { maxLength: 160 }),
    theme: cleanString(input.theme, { maxLength: 240 }),
    dateRange: cleanString(input.dateRange, { maxLength: 160 }),
    prompts: normalizeGenerationPrompts(input.prompts),
  };
}

function normalizeGenerationPrompts(prompts) {
  if (!Array.isArray(prompts)) {
    throw badRequest('prompts must be an array');
  }
  const normalized = prompts
    .map((item, index) => {
      const prompt = typeof item === 'string'
        ? cleanString(item, { maxLength: MAX_GENERATION_PROMPT_CHARS })
        : cleanString(item?.prompt, { maxLength: MAX_GENERATION_PROMPT_CHARS });
      if (!prompt) {
        return null;
      }
      return {
        id: cleanString(item?.id, { maxLength: 80 }) ?? `prompt_${index + 1}`,
        prompt,
      };
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    throw badRequest('At least one prompt is required');
  }
  if (normalized.length > MAX_GENERATION_PROMPTS) {
    throw badRequest(`prompts cannot contain more than ${MAX_GENERATION_PROMPTS} items`, {
      maxItems: MAX_GENERATION_PROMPTS,
    });
  }
  return normalized;
}

function normalizeBatchInput(input = {}, { timestamp, partial = false } = {}) {
  const tradeDate = cleanDate(input.tradeDate);
  if (!partial && !tradeDate) {
    throw badRequest('tradeDate is required');
  }
  const recommendations = normalizeRecommendations(input.recommendations ?? [], { allowEmpty: partial });
  return {
    tradeDate,
    weekId: cleanString(input.weekId, { maxLength: 80 }) ?? weekIdForDate(tradeDate),
    title: cleanString(input.title, { maxLength: 160 }) ?? `Daily Picks - ${tradeDate}`,
    theme: cleanString(input.theme, { maxLength: 240 }) ?? '',
    dateRange: cleanString(input.dateRange, { maxLength: 160 }) ?? tradeDate,
    recommendations,
    metadata: normalizePlainObject(input.metadata),
    createdAt: input.createdAt ?? timestamp,
  };
}

async function findOpenBatchForTradeDateFromRepository(repository, tradeDate) {
  const batches = await repository.listRecommendationBatches({});
  return batches.find((batch) => batch.tradeDate === tradeDate && ['draft', 'approved'].includes(batch.status)) ?? null;
}

function batchContextForGeneration(existing, request, timestamp) {
  const tradeDate = request.tradeDate ?? existing?.tradeDate;
  return {
    id: existing?.id ?? null,
    tradeDate,
    weekId: existing?.weekId ?? weekIdForDate(tradeDate),
    title: request.title ?? existing?.title ?? `Daily Picks - ${tradeDate}`,
    theme: request.theme ?? existing?.theme ?? '',
    dateRange: request.dateRange ?? existing?.dateRange ?? tradeDate,
    recommendations: existing?.recommendations ?? [],
    metadata: existing?.metadata ?? {},
    createdAt: existing?.createdAt ?? timestamp,
  };
}

function normalizeGeneratedRecommendations(rawRecommendations, { existingRecommendations, prompts, timestamp }) {
  const usedIds = new Set(existingRecommendations.map((item) => item.id).filter(Boolean));
  const maxSortOrder = existingRecommendations.reduce(
    (maxValue, item) => Math.max(maxValue, Number(item.sortOrder) || 0),
    0,
  );

  return rawRecommendations.map((item, index) => {
    const sortOrder = maxSortOrder + ((index + 1) * 10);
    const symbol = cleanSymbol(item.symbol);
    const id = uniqueRecommendationId({
      requestedId: item.id,
      symbol,
      sortOrder,
      usedIds,
    });
    const sourcePromptId =
      cleanString(item.sourcePromptId ?? item.promptId, { maxLength: 80 }) ?? prompts[index]?.id ?? null;
    return normalizeRecommendation(
      {
        ...item,
        id,
        tileId: cleanString(item.tileId, { maxLength: 120 }) ?? id,
        symbol,
        sortOrder,
        lifecycle: {
          ...normalizePlainObject(item.lifecycle),
          generation: {
            source: 'ai',
            generatedAt: timestamp,
            sourcePromptId,
          },
        },
      },
      index,
    );
  });
}

function uniqueRecommendationId({ requestedId, symbol, sortOrder, usedIds }) {
  const requested = cleanString(requestedId, { maxLength: 120 });
  const fallback = `pick_${sortOrder}_${String(symbol ?? 'ai').toLowerCase()}`;
  const base = sanitizeRecommendationId(requested ?? fallback) || `pick_${sortOrder}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function sanitizeRecommendationId(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function mergeGenerationMetadata(metadata, generationSummary) {
  const normalizedMetadata = normalizePlainObject(metadata);
  const generationHistory = Array.isArray(normalizedMetadata.generationHistory)
    ? normalizedMetadata.generationHistory.slice(-9)
    : [];
  return {
    ...normalizedMetadata,
    source: normalizedMetadata.source ?? 'admin-ai-assisted',
    lastGeneration: generationSummary,
    generationHistory: [...generationHistory, generationSummary],
  };
}

function normalizeBatchRecord(batch = {}) {
  return {
    ...batch,
    recommendations: normalizeRecommendations(batch.recommendations ?? [], { allowEmpty: true }),
    channels: normalizeChannels(batch.channels),
    publicData: batch.publicData ? buildPublicRecommendationBatch(batch, batch.publishedAt ?? batch.updatedAt) : null,
  };
}

function normalizeRecommendations(rawRecommendations, { allowEmpty = false } = {}) {
  if (!Array.isArray(rawRecommendations)) {
    throw badRequest('recommendations must be an array');
  }
  if (!allowEmpty) {
    assertRecommendationCount(rawRecommendations);
  }
  if (rawRecommendations.length > MAX_RECOMMENDATIONS_PER_BATCH) {
    throw badRequest(`recommendations cannot contain more than ${MAX_RECOMMENDATIONS_PER_BATCH} items`, {
      maxItems: MAX_RECOMMENDATIONS_PER_BATCH,
    });
  }

  return rawRecommendations.map((item, index) => normalizeRecommendation(item, index));
}

function normalizeRecommendation(item = {}, index = 0) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw badRequest(`recommendations[${index}] must be an object`);
  }
  const symbol = cleanSymbol(item.symbol);
  const strategy = cleanString(item.strategy, { maxLength: 120 });
  const thesis = cleanString(item.thesis, { maxLength: 1400 });
  if (!symbol || !strategy || !thesis) {
    throw badRequest(`recommendations[${index}] requires symbol, strategy, and thesis`);
  }
  const sortOrder = cleanNumber(item.sortOrder, (index + 1) * 10, 1, 1000);
  const id = cleanString(item.id, { maxLength: 120 }) ?? `pick_${sortOrder}_${symbol.toLowerCase()}`;
  const direction = cleanBatchDirection(item.direction);
  const maxProfit = cleanNumber(item.maxProfit, null, 0, 100000000);
  const rewardRisk = cleanNumber(item.rewardRisk, null, 0, 1000);
  const oddsOfProfit = cleanNumber(item.oddsOfProfit ?? item.probabilityOfProfit, null, 0, 100);

  return {
    id,
    tileId: cleanString(item.tileId, { maxLength: 120 }) ?? id,
    symbol,
    strategy,
    direction,
    price: cleanNumber(item.price ?? item.underlyingPrice, null, 0, 10000000),
    expiry: cleanString(item.expiry, { maxLength: 40 }) ?? '',
    rewardRisk,
    oddsOfProfit,
    maxProfit,
    thesis,
    riskNotes: cleanString(item.riskNotes ?? item.risk, { maxLength: 1400 }) ?? '',
    entry: cleanString(item.entry, { maxLength: 900 }) ?? '',
    exit: cleanString(item.exit, { maxLength: 900 }) ?? '',
    ivContext: normalizePlainObject(item.ivContext),
    sentiment: normalizePlainObject(item.sentiment),
    lifecycle: normalizePlainObject(item.lifecycle),
    legs: Array.isArray(item.legs) ? item.legs.map(normalizePlainObject) : [],
    sortOrder,
  };
}

function assertRecommendationCount(recommendations) {
  if (!Array.isArray(recommendations) || recommendations.length === 0) {
    throw badRequest('At least one recommendation is required');
  }
  if (recommendations.length > MAX_RECOMMENDATIONS_PER_BATCH) {
    throw badRequest(`Only ${MAX_RECOMMENDATIONS_PER_BATCH} recommendations can be published per batch`, {
      maxItems: MAX_RECOMMENDATIONS_PER_BATCH,
    });
  }
}

function buildPublicRecommendationBatch(batch, publishedAt) {
  const recommendations = normalizeRecommendations(batch.recommendations ?? [], { allowEmpty: true })
    .sort((left, right) => left.sortOrder - right.sortOrder);
  return {
    id: batch.id,
    recommendationBatchId: batch.id,
    tradeDate: batch.tradeDate,
    weekId: batch.weekId ?? weekIdForDate(batch.tradeDate),
    title: batch.title,
    theme: batch.theme ?? '',
    dateRange: batch.dateRange ?? batch.tradeDate,
    status: 'published',
    publishedAt: batch.publishedAt ?? publishedAt ?? null,
    source: batch.metadata?.source ?? 'admin-curated',
    recommendations,
    picks: recommendations,
  };
}

function buildHeyGenScript(publicData) {
  const lines = [
    `NewLeaf daily picks for ${publicData.tradeDate}.`,
    publicData.theme ? `Market theme: ${publicData.theme}.` : '',
    'These ideas are educational, model-estimated, and not guaranteed. Use defined risk and your own suitability checks.',
    ...publicData.recommendations.map((item, index) => {
      const metrics = [
        item.direction ? `${item.direction.toLowerCase()} setup` : '',
        item.oddsOfProfit != null ? `${item.oddsOfProfit}% model probability` : '',
        item.rewardRisk != null ? `${item.rewardRisk} reward to risk` : '',
        item.expiry ? `expiry ${item.expiry}` : '',
      ].filter(Boolean).join(', ');
      return [
        `Pick ${index + 1}: ${item.symbol}, ${item.strategy}.`,
        metrics ? `Key metrics: ${metrics}.` : '',
        `Thesis: ${item.thesis}`,
        item.riskNotes ? `Risk note: ${item.riskNotes}` : '',
      ].filter(Boolean).join(' ');
    }),
    'Review the full card before acting, size positions carefully, and treat every trade as a risk-managed plan.',
  ].filter(Boolean);
  return lines.join('\n\n');
}

function buildHeyGenScenes(publicData) {
  return [
    {
      id: 'intro',
      title: publicData.title,
      narration: `Today on NewLeaf: ${publicData.theme || 'five curated options ideas with defined risk.'}`,
    },
    ...publicData.recommendations.map((item, index) => ({
      id: item.id,
      title: `${index + 1}. ${item.symbol} ${item.strategy}`,
      narration: `${item.symbol}: ${item.thesis}${item.riskNotes ? ` Risk note: ${item.riskNotes}` : ''}`,
    })),
    {
      id: 'close',
      title: 'Risk reminder',
      narration: 'These recommendations are educational and not guaranteed. Review the full thesis, risks, and position size before acting.',
    },
  ];
}

function initialChannels(timestamp) {
  return {
    liveSite: { status: 'not_requested', updatedAt: timestamp },
    email: { status: 'not_requested', updatedAt: timestamp },
    pdf: { status: 'not_requested', updatedAt: timestamp },
    script: { status: 'not_requested', updatedAt: timestamp },
    video: { status: 'not_requested', updatedAt: timestamp },
  };
}

function normalizeChannels(channels = {}) {
  return {
    ...initialChannels(null),
    ...normalizePlainObject(channels),
  };
}

function mergeChannels(current, patch) {
  return {
    ...normalizeChannels(current),
    ...Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [
        key,
        {
          ...(current?.[key] ?? {}),
          ...value,
        },
      ]),
    ),
  };
}

function cleanBatchStatus(status, { optional = false } = {}) {
  const value = cleanString(status, { maxLength: 40 });
  if (!value) {
    return optional ? undefined : 'draft';
  }
  if (!RECOMMENDATION_BATCH_STATUSES.includes(value)) {
    throw badRequest('Recommendation batch status is not supported', {
      status: value,
      allowedValues: RECOMMENDATION_BATCH_STATUSES,
    });
  }
  return value;
}

function cleanBatchDirection(direction) {
  const value = cleanString(direction, { maxLength: 40 })?.toUpperCase() ?? 'NEUTRAL';
  if (!RECOMMENDATION_DIRECTIONS.includes(value)) {
    throw badRequest('Recommendation direction is not supported', {
      direction: value,
      allowedValues: RECOMMENDATION_DIRECTIONS,
    });
  }
  return value;
}

function cleanSymbol(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!symbol) return null;
  if (!/^[A-Z0-9^][A-Z0-9.\-^=]{0,23}$/.test(symbol)) {
    throw badRequest('Recommendation symbol is not valid', { symbol });
  }
  return symbol;
}

function cleanDate(value) {
  const date = cleanString(value, { maxLength: 20 });
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw badRequest('tradeDate must use YYYY-MM-DD format');
  }
  return date;
}

function weekIdForDate(value) {
  return value ? value.slice(0, 10) : null;
}

function cleanString(value, { maxLength = 500 } = {}) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function cleanNumber(value, defaultValue = null, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  if (value === null || value === undefined || value === '') return defaultValue;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw badRequest('Expected a numeric recommendation value');
  }
  if (numberValue < min || numberValue > max) {
    throw badRequest('Recommendation numeric value is out of range', { min, max });
  }
  return numberValue;
}

function normalizePlainObject(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}
