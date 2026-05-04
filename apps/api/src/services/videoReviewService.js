import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { badRequest, conflict, HttpError } from '../lib/httpErrors.js';

const SUPPORTED_PROVIDERS = ['openai'];
const TRANSCRIBABLE_MIME_TYPES = new Set([
  'audio/flac',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/mpga',
  'audio/m4a',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/mpeg',
  'video/webm',
]);

export function createVideoReviewService(options = {}) {
  const serviceConfig = options.config ?? config.ai;

  return {
    async generateYouTubeTags({ job, artifacts = [], metadata = {} }) {
      const provider = String(serviceConfig.provider ?? 'openai').toLowerCase();
      if (!serviceConfig.apiKey) {
        throw conflict('GPT tag generation is not configured', {
          requiredEnv: ['AI_API_KEY or OPENAI_API_KEY'],
          optionalEnv: ['AI_MODEL'],
          supportedProviders: SUPPORTED_PROVIDERS,
        });
      }
      if (!SUPPORTED_PROVIDERS.includes(provider)) {
        throw badRequest('Unsupported AI provider for YouTube tag generation', {
          provider,
          supportedProviders: SUPPORTED_PROVIDERS,
        });
      }

      const transcriptSources = await collectTranscriptSources({ job, artifacts });
      const prompt = buildYouTubeTagPrompt({
        job,
        metadata,
        transcriptSources,
      });
      const model = serviceConfig.model ?? defaultModel();
      const rawText = await callOpenAI({
        apiKey: serviceConfig.apiKey,
        baseUrl: serviceConfig.baseUrl,
        model,
        prompt,
      });

      return {
        tags: parseYouTubeTags(rawText),
        provider,
        model,
        generatedAt: new Date().toISOString(),
      };
    },

    async generateSummary({ job, artifacts = [], providerJobs = [] }) {
      const provider = String(serviceConfig.provider ?? 'openai').toLowerCase();
      if (!serviceConfig.apiKey) {
        throw conflict('GPT video review is not configured', {
          requiredEnv: ['AI_API_KEY or OPENAI_API_KEY'],
          optionalEnv: ['AI_MODEL', 'AI_TRANSCRIPTION_MODEL', 'AI_MAX_TRANSCRIPTION_BYTES'],
          supportedProviders: SUPPORTED_PROVIDERS,
        });
      }
      if (!SUPPORTED_PROVIDERS.includes(provider)) {
        throw badRequest('Unsupported AI review provider for video summaries', {
          provider,
          supportedProviders: SUPPORTED_PROVIDERS,
        });
      }

      const reviewInput = await buildReviewInput({
        job,
        artifacts,
        providerJobs,
        serviceConfig,
      });
      const prompt = buildReviewPrompt(reviewInput);
      const model = serviceConfig.model ?? defaultModel();
      const rawText = await callOpenAI({
        apiKey: serviceConfig.apiKey,
        baseUrl: serviceConfig.baseUrl,
        model,
        prompt,
      });

      return {
        ...parseSummary(rawText),
        provider,
        model,
        generatedAt: new Date().toISOString(),
        sourceCoverage: reviewInput.coverage,
        evidence: reviewInput.evidence,
        transcription: reviewInput.transcription
          ? {
              status: reviewInput.transcription.status,
              source: reviewInput.transcription.source,
              model: reviewInput.transcription.model,
              textLength: reviewInput.transcription.text?.length ?? 0,
              skippedReason: reviewInput.transcription.skippedReason ?? null,
            }
          : null,
      };
    },
  };
}

function buildYouTubeTagPrompt({ job, metadata, transcriptSources }) {
  return {
    system:
      'You generate YouTube metadata tags for an admin publishing workflow. Return only valid JSON. Tags must be search-friendly, non-duplicative, and must not include leading hash symbols.',
    user: JSON.stringify(
      {
        expectedJsonShape: {
          tags: ['8 to 15 YouTube search tags, no hashtags'],
        },
        constraints: [
          'Do not invent tickers, people, products, or claims not supported by the input.',
          'Prefer concise tags under 30 characters when possible.',
          'Do not include # prefixes.',
          'Do not include empty or duplicate tags.',
        ],
        publishingInput: {
          title: metadata.title ?? job.title,
          description: metadata.description ?? job.metadata?.description ?? '',
          hashtags: metadata.hashtags ?? [],
          sourceType: job.sourceType,
          prompt: job.metadata?.prompt ?? null,
          scriptPreview: job.metadata?.scriptPreview ?? null,
          reviewSummary: job.metadata?.reviewSummary ?? null,
          transcriptOrScriptExcerpts: transcriptSources.slice(0, 4).map((source) => ({
            source: source.source,
            kind: source.kind,
            text: trimForPrompt(source.text, 2500),
          })),
        },
      },
      null,
      2,
    ),
  };
}

async function buildReviewInput({ job, artifacts, providerJobs, serviceConfig }) {
  const metadata = job.metadata ?? {};
  const compactArtifacts = artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    storageProvider: artifact.storageProvider,
    mimeType: artifact.mimeType,
    filename: artifact.metadata?.filename ?? null,
    sizeBytes: artifact.sizeBytes ?? null,
    storageKey: artifact.storageProvider === 'provider-url' ? artifact.storageKey : undefined,
  }));
  const compactProviderJobs = providerJobs.map((providerJob) => ({
    provider: providerJob.provider,
    status: providerJob.status,
    externalId: providerJob.externalId,
    errorCode: providerJob.errorCode,
    errorMessage: providerJob.errorMessage,
  }));

  const transcriptSources = await collectTranscriptSources({ job, artifacts });
  const localVideoArtifact = artifacts.find(
    (artifact) => artifact.kind === 'video' && artifact.storageProvider === 'local-disk',
  );
  let transcription = null;

  if (localVideoArtifact && !hasStrongTranscript(transcriptSources)) {
    transcription = await transcribeLocalMediaArtifact(localVideoArtifact, serviceConfig);
    if (transcription.text) {
      transcriptSources.unshift({
        source: 'openai_transcription',
        kind: 'audio_transcript',
        text: transcription.text,
      });
    }
  }

  const evidence = buildEvidence({ job, artifacts, transcriptSources, transcription });
  return {
    job: {
      id: job.id,
      title: job.title,
      type: job.type,
      sourceType: job.sourceType,
      status: job.status,
      targetDurationSec: job.targetDurationSec,
    },
    metadata: {
      prompt: metadata.prompt ?? null,
      scriptPreview: metadata.scriptPreview ?? null,
      youtubeUrl: metadata.youtubeUrl ?? null,
      videoUrl: metadata.videoUrl ?? null,
      sourceArtifact: metadata.sourceArtifact ?? null,
      thumbnailLabel: metadata.thumbnailLabel ?? null,
      disclaimer: metadata.disclaimer ?? null,
    },
    transcripts: transcriptSources.map((source) => ({
      source: source.source,
      kind: source.kind,
      text: trimForPrompt(source.text, 12000),
    })),
    artifacts: compactArtifacts,
    providerJobs: compactProviderJobs,
    evidence,
    transcription,
    coverage: coverageFor({ transcriptSources, transcription, job }),
  };
}

function buildReviewPrompt(reviewInput) {
  return {
    system:
      'You are a strict video review analyst for an admin publishing console. Review only the evidence provided. Do not claim you watched visual frames unless the evidence explicitly contains visual analysis. If the evidence is only metadata, say that clearly in risks and recommend wait or revise when intent cannot be verified. Return only valid JSON.',
    user: JSON.stringify(
      {
        expectedJsonShape: {
          summary: 'short factual summary of the video or available evidence',
          intent: 'intended message or audience outcome',
          deliveryAssessment: 'whether the available transcript/script/metadata appears aligned with the intent',
          risks: ['specific review risks or missing evidence'],
          recommendedDecision: 'approve | revise | wait',
          suggestedTags: ['short tags'],
          titleSuggestion: 'optional title',
          descriptionSuggestion: 'optional post description',
          sourceCoverage: 'audio_transcript | supplied_transcript | script | metadata_only',
          evidence: ['short names of evidence used'],
        },
        reviewInput,
      },
      null,
      2,
    ),
  };
}

async function collectTranscriptSources({ job, artifacts }) {
  const metadata = job.metadata ?? {};
  const sources = [];

  addTextSource(sources, 'metadata.transcript', 'supplied_transcript', metadata.transcript);
  addTextSource(sources, 'metadata.captions', 'supplied_transcript', metadata.captions);
  addTextSource(sources, 'metadata.description', 'metadata', metadata.description);

  if (Array.isArray(metadata.scriptPreview) && metadata.scriptPreview.length > 0) {
    addTextSource(sources, 'metadata.scriptPreview', 'script', metadata.scriptPreview.join('\n'));
  }
  addTextSource(sources, 'metadata.prompt', 'script', metadata.prompt);

  for (const artifact of artifacts) {
    if (!['captions', 'extracted_text', 'script'].includes(artifact.kind)) {
      continue;
    }
    const text = await readTextArtifact(artifact);
    addTextSource(sources, `artifact.${artifact.kind}.${artifact.id}`, artifact.kind, text);
  }

  return sources;
}

async function readTextArtifact(artifact) {
  if (artifact.storageProvider !== 'local-disk') {
    return artifact.metadata?.text ?? null;
  }

  const filePath = artifact.metadata?.localPath ? path.resolve(artifact.metadata.localPath) : null;
  if (!filePath) {
    return null;
  }

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || stat.size > 1024 * 1024) {
    return null;
  }

  const text = await fsp.readFile(filePath, 'utf8').catch(() => null);
  return text;
}

async function transcribeLocalMediaArtifact(artifact, serviceConfig) {
  const mimeType = normalizeMimeType(artifact.mimeType);
  const filePath = artifact.metadata?.localPath ? path.resolve(artifact.metadata.localPath) : null;
  const model = serviceConfig.transcriptionModel ?? 'gpt-4o-mini-transcribe';

  if (!filePath) {
    return {
      status: 'skipped',
      source: artifact.id,
      model,
      text: '',
      skippedReason: 'local_path_missing',
    };
  }
  if (!TRANSCRIBABLE_MIME_TYPES.has(mimeType)) {
    return {
      status: 'skipped',
      source: artifact.id,
      model,
      text: '',
      skippedReason: 'unsupported_mime_type',
    };
  }

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) {
    return {
      status: 'skipped',
      source: artifact.id,
      model,
      text: '',
      skippedReason: 'file_missing',
    };
  }
  const maxTranscriptionBytes = serviceConfig.maxTranscriptionBytes ?? 25 * 1024 * 1024;
  if (stat.size > maxTranscriptionBytes) {
    return {
      status: 'skipped',
      source: artifact.id,
      model,
      text: '',
      skippedReason: 'file_too_large',
    };
  }

  const bytes = await fsp.readFile(filePath);
  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'json');
  form.append(
    'file',
    new Blob([bytes], { type: mimeType }),
    artifact.metadata?.filename ?? path.basename(filePath),
  );

  const response = await fetch(serviceConfig.transcriptionBaseUrl ?? 'https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceConfig.apiKey}`,
    },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  assertProviderOk(response, body, 'OpenAI transcription');

  return {
    status: 'transcribed',
    source: artifact.id,
    model,
    text: String(body.text ?? '').trim(),
  };
}

async function callOpenAI({ apiKey, baseUrl, model, prompt }) {
  const response = await fetch(baseUrl ?? 'https://api.openai.com/v1/chat/completions', {
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
  assertProviderOk(response, body, 'OpenAI review');
  return body.choices?.[0]?.message?.content ?? '';
}

function parseSummary(rawText) {
  const trimmed = String(rawText ?? '').trim();
  const jsonText = extractJson(trimmed);
  if (!jsonText) {
    return fallbackSummary(trimmed);
  }

  try {
    const parsed = JSON.parse(jsonText);
    return {
      summary: asString(parsed.summary),
      intent: asString(parsed.intent),
      deliveryAssessment: asString(parsed.deliveryAssessment),
      risks: asStringArray(parsed.risks),
      recommendedDecision: normalizeDecision(parsed.recommendedDecision),
      suggestedTags: asStringArray(parsed.suggestedTags),
      titleSuggestion: asString(parsed.titleSuggestion),
      descriptionSuggestion: asString(parsed.descriptionSuggestion),
      sourceCoverage: asString(parsed.sourceCoverage),
      evidence: asStringArray(parsed.evidence),
      rawText: trimmed,
    };
  } catch {
    return fallbackSummary(trimmed);
  }
}

function parseYouTubeTags(rawText) {
  const trimmed = String(rawText ?? '').trim();
  const jsonText = extractJson(trimmed);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      return normalizeYouTubeTags(parsed.tags);
    } catch {
      return normalizeYouTubeTags(trimmed.split(/[,\n]/));
    }
  }
  return normalizeYouTubeTags(trimmed.split(/[,\n]/));
}

function normalizeYouTubeTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for (const item of value) {
    const tag = String(item ?? '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, ' ')
      .slice(0, 60);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 15) break;
  }
  return tags;
}

function fallbackSummary(text) {
  return {
    summary: text || 'The provider returned an empty summary.',
    intent: '',
    deliveryAssessment: '',
    risks: [],
    recommendedDecision: 'revise',
    suggestedTags: [],
    titleSuggestion: '',
    descriptionSuggestion: '',
    sourceCoverage: '',
    evidence: [],
    rawText: text,
  };
}

function buildEvidence({ job, artifacts, transcriptSources, transcription }) {
  const evidence = [];
  if (transcription?.status === 'transcribed') {
    evidence.push('local video audio transcript');
  }
  if (transcriptSources.some((source) => source.kind === 'supplied_transcript' || source.kind === 'captions')) {
    evidence.push('supplied transcript or captions');
  }
  if (transcriptSources.some((source) => source.kind === 'script')) {
    evidence.push('script or prompt');
  }
  if (job.metadata?.youtubeUrl) {
    evidence.push('YouTube URL metadata');
  }
  if (artifacts.some((artifact) => artifact.kind === 'video')) {
    evidence.push('video artifact metadata');
  }
  if (evidence.length === 0) {
    evidence.push('job metadata only');
  }
  return Array.from(new Set(evidence));
}

function coverageFor({ transcriptSources, transcription, job }) {
  if (transcription?.status === 'transcribed') return 'audio_transcript';
  if (transcriptSources.some((source) => source.kind === 'supplied_transcript' || source.kind === 'captions')) {
    return 'supplied_transcript';
  }
  if (job.sourceType === 'text_to_heygen' && transcriptSources.some((source) => source.kind === 'script')) {
    return 'script';
  }
  return 'metadata_only';
}

function hasStrongTranscript(transcriptSources) {
  return transcriptSources.some(
    (source) =>
      ['supplied_transcript', 'captions', 'extracted_text'].includes(source.kind) &&
      String(source.text ?? '').trim().length > 120,
  );
}

function addTextSource(sources, source, kind, value) {
  const text = Array.isArray(value) ? value.join('\n') : String(value ?? '').trim();
  if (!text) {
    return;
  }
  sources.push({ source, kind, text });
}

function trimForPrompt(text, maxLength) {
  const value = String(text ?? '').trim();
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n[truncated ${value.length - maxLength} chars]`;
}

function normalizeMimeType(value) {
  return String(value ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
}

function extractJson(text) {
  if (!text) return null;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
}

function normalizeDecision(value) {
  const normalized = String(value ?? '').toLowerCase();
  return ['approve', 'revise', 'wait'].includes(normalized) ? normalized : 'revise';
}

function defaultModel() {
  return 'gpt-4o-mini';
}

function assertProviderOk(response, body, provider) {
  if (response.ok) return;

  const providerError = body.error ?? body;
  const providerMessage =
    providerError?.message ??
    providerError?.error_description ??
    providerError?.detail ??
    `${provider} request failed`;
  const providerCode = providerError?.code ?? providerError?.type ?? null;
  const details = {
    status: response.status,
    error: providerError,
  };

  if (response.status === 429) {
    const quotaMessage = providerCode === 'insufficient_quota' || /quota/i.test(providerMessage)
      ? `${provider} quota is exhausted. Check the API key billing plan or use a key with available quota.`
      : `${provider} rate limit was reached. Try again later or use a key with more capacity.`;
    throw conflict(quotaMessage, details);
  }

  if ([400, 401, 403, 404].includes(response.status)) {
    throw conflict(`${provider} request failed: ${providerMessage}`, details);
  }

  throw new HttpError(502, `${provider} request failed: ${providerMessage}`, details);
}
