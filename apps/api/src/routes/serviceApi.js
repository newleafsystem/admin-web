import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { Router } from 'express';
import { config } from '../config.js';
import { authenticateServiceApiKey } from '../middleware/serviceApiAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badRequest, forbidden, notFound } from '../lib/httpErrors.js';
import {
  optionalNumber,
  optionalObject,
  optionalString,
  rejectUnknownFields,
  requireObject,
  requireString,
} from '../lib/validation.js';

const MAX_SCRIPT_LENGTH = 50_000;
const MAX_SCRIPT_BASE64_LENGTH = 80_000;

export function createServiceApiRouter({ repository, jobStateService, videoAssemblyService }) {
  const router = Router();

  router.use(authenticateServiceApiKey({ repository }));

  router.post(
    '/text-to-heygen/jobs',
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, [
        'title',
        'script',
        'scriptBase64',
        'scriptEncoding',
        'targetDurationSec',
        'thumbnailLabel',
        'metadata',
        'idempotencyKey',
        'autoStart',
        'segmentMode',
        'segments',
      ]);
      assertServiceScope(req, 'text_to_heygen');

      const idempotencyKey = optionalString(body, 'idempotencyKey', { maxLength: 160, defaultValue: null });
      const existingJob = idempotencyKey
        ? await findIdempotentJob({
            repository,
            idempotencyKey,
            clientFingerprint: req.serviceClient.keyFingerprint,
          })
        : null;

      if (existingJob) {
        return res.json(await buildServiceJobResponse({
          repository,
          job: existingJob,
          idempotentReplay: true,
        }));
      }

      const title = requireString(body, 'title', { maxLength: 300 });
      const explicitSegments = optionalSegments(body, 'segments');
      const script = readScriptPayload(body);
      if (!script && explicitSegments.length === 0) {
        throw badRequest('script, scriptBase64, or segments is required');
      }
      const segmentMode = optionalString(body, 'segmentMode', {
        maxLength: 40,
        defaultValue: explicitSegments.length > 0 ? 'segments' : 'single',
      });
      if (!['single', 'slides', 'segments'].includes(segmentMode)) {
        throw badRequest('segmentMode is not supported', {
          segmentMode,
          allowed: ['single', 'slides', 'segments'],
        });
      }
      const targetDurationSec = optionalNumber(body, 'targetDurationSec', { min: 1, max: 3600, defaultValue: null });
      const thumbnailLabel = optionalString(body, 'thumbnailLabel', { maxLength: 200, defaultValue: 'Auto placeholder thumbnail' });
      const clientMetadata = optionalObject(body, 'metadata', { defaultValue: {} });
      const autoStart = optionalBoolean(body, 'autoStart', true);
      const videoSegments =
        explicitSegments.length > 0
          ? explicitSegments
          : segmentMode === 'slides'
          ? parseMarkdownSlides(script)
          : null;
      if (segmentMode === 'slides' && !videoSegments?.length) {
        throw badRequest('segmentMode=slides requires markdown slide headings such as "## Slide 1: Intro"');
      }
      if (segmentMode === 'segments' && explicitSegments.length === 0) {
        throw badRequest('segmentMode=segments requires a segments array');
      }
      const canonicalScript = script ?? videoSegments.map((segment) => segment.prompt).join('\n\n');
      const scriptPreview = videoSegments?.length
        ? videoSegments.map((segment) => segment.prompt)
        : splitScriptPreview(canonicalScript);

      const job = await jobStateService.createJob({
        title,
        type: 'video_job',
        status: 'script_ready',
        sourceType: 'text_to_heygen',
        targetDurationSec,
        ownerUid: req.user.uid,
        metadata: {
          owner: req.user.uid,
          sourceArtifact: 'External service script',
          provider: 'HeyGen',
          stage: autoStart ? 'HeyGen generation queued by service API' : 'Script submitted by service API',
          prompt: canonicalScript,
          reviewScriptText: canonicalScript,
          scriptPreview,
          scriptQuality: 'Submitted by service API',
          scenes: scriptPreview.length,
          thumbnailLabel,
          assemblyMode: videoSegments?.length ? `service_api_${segmentMode}` : 'service_api_single',
          ...(videoSegments?.length ? { videoSegments } : {}),
          externalApi: {
            clientFingerprint: req.serviceClient.keyFingerprint,
            idempotencyKey,
            submittedAt: new Date().toISOString(),
          },
          clientMetadata,
        },
      });

      if (!autoStart) {
        return res.status(201).json(await buildServiceJobResponse({ repository, job }));
      }

      try {
        const transitionedJob = await jobStateService.transitionJob(job.id, 'video_requested', {
          actorUid: req.user.uid,
          reason: 'service_api_generate_video',
        });
        const result = await videoAssemblyService.createAssemblyRequest({
          job: transitionedJob,
          script: videoSegments?.length ? { segments: videoSegments } : { prompt: canonicalScript },
          actorUid: req.user.uid,
          regenerate: false,
        });

        return res.status(202).json(await buildServiceJobResponse({
          repository,
          job: result.job,
          providerJobs: result.providerJobs,
          manifest: result.manifest,
          task: {
            type: 'generate_video',
            queued: false,
            segmentCount: result.manifest.segments.length,
          },
        }));
      } catch (error) {
        await markServiceJobFailed({ jobStateService, job, error, actorUid: req.user.uid });
        throw error;
      }
    }),
  );

  router.post(
    '/jobs/:jobId/retry',
    asyncHandler(async (req, res) => {
      assertServiceScope(req, 'text_to_heygen');
      const job = await getOwnedServiceJob({ repository, jobId: req.params.jobId, req });
      if (!['failed', 'script_ready'].includes(job.status)) {
        throw badRequest('Only failed or script_ready service jobs can be retried from this endpoint', {
          jobId: job.id,
          status: job.status,
        });
      }

      const script = job.metadata?.reviewScriptText ?? job.metadata?.prompt ?? '';
      const segments = Array.isArray(job.metadata?.videoSegments) ? job.metadata.videoSegments : null;
      const transitionedJob = await jobStateService.transitionJob(job.id, 'video_requested', {
        actorUid: req.user.uid,
        reason: 'service_api_retry_generate_video',
      });
      const result = await videoAssemblyService.createAssemblyRequest({
        job: transitionedJob,
        script: segments?.length ? { segments } : { prompt: script },
        actorUid: req.user.uid,
        regenerate: true,
      });

      res.status(202).json(await buildServiceJobResponse({
        repository,
        job: result.job,
        providerJobs: result.providerJobs,
        manifest: result.manifest,
        task: {
          type: 'retry_generate_video',
          queued: false,
          segmentCount: result.manifest.segments.length,
        },
      }));
    }),
  );

  router.get(
    '/jobs/:jobId',
    asyncHandler(async (req, res) => {
      const job = await getOwnedServiceJob({ repository, jobId: req.params.jobId, req });
      res.json(await buildServiceJobResponse({ repository, job }));
    }),
  );

  router.get(
    '/jobs/:jobId/artifacts/:artifactId/content',
    asyncHandler(async (req, res) => {
      await getOwnedServiceJob({ repository, jobId: req.params.jobId, req });
      const artifact = await repository.getArtifact(req.params.artifactId);
      if (!artifact || artifact.jobId !== req.params.jobId) {
        throw notFound('Artifact not found', {
          jobId: req.params.jobId,
          artifactId: req.params.artifactId,
        });
      }

      if (artifact.storageProvider === 'provider-url' && /^https?:\/\//i.test(artifact.storageKey)) {
        return res.redirect(302, artifact.storageKey);
      }

      if (artifact.storageProvider !== 'local-disk') {
        throw badRequest('Artifact is not streamable from local API storage', {
          artifactId: artifact.id,
          storageProvider: artifact.storageProvider,
        });
      }

      return streamLocalArtifact({ artifact, req, res });
    }),
  );

  return router;
}

async function findIdempotentJob({ repository, idempotencyKey, clientFingerprint }) {
  const jobs = await repository.listJobs();
  return jobs.find((job) => {
    const externalApi = job.metadata?.externalApi ?? {};
    return externalApi.idempotencyKey === idempotencyKey && externalApi.clientFingerprint === clientFingerprint;
  });
}

async function getOwnedServiceJob({ repository, jobId, req }) {
  const job = await repository.getJob(jobId);
  if (!job) {
    throw notFound('Job not found', { jobId });
  }
  if (job.metadata?.externalApi?.clientFingerprint !== req.serviceClient.keyFingerprint) {
    throw forbidden('Service API key cannot access this job', { jobId });
  }
  return job;
}

async function buildServiceJobResponse({
  repository,
  job,
  providerJobs = null,
  manifest = null,
  task = null,
  idempotentReplay = false,
}) {
  const [artifacts, loadedProviderJobs] = await Promise.all([
    repository.listArtifactsForJob(job.id),
    providerJobs ? Promise.resolve(providerJobs) : repository.listProviderJobs({ jobId: job.id }),
  ]);

  return {
    job: sanitizeJob(job),
    providerJobs: loadedProviderJobs.map(sanitizeProviderJob),
    artifacts: artifacts.map((artifact) => sanitizeArtifact({ job, artifact })),
    manifest: manifest ? sanitizeManifest(manifest) : await sanitizeManifestFromJob(job),
    task,
    idempotentReplay,
  };
}

function sanitizeJob(job) {
  return {
    id: job.id,
    title: job.title,
    type: job.type,
    sourceType: job.sourceType,
    status: job.status,
    targetDurationSec: job.targetDurationSec,
    stage: job.metadata?.stage ?? null,
    assembly: sanitizeAssembly(job.metadata?.videoAssembly),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    currentVideoArtifactId: job.currentVideoArtifactId,
  };
}

function sanitizeAssembly(assembly) {
  if (!assembly) {
    return null;
  }
  return {
    projectId: assembly.projectId,
    status: assembly.status,
    requiredSegments: assembly.requiredSegments,
    completedSegments: assembly.completedSegments,
    pendingSegments: assembly.pendingSegments,
    lastCompletedSegment: assembly.lastCompletedSegment,
    errorCode: assembly.errorCode,
    errorMessage: assembly.errorMessage,
    updatedAt: assembly.updatedAt,
  };
}

function sanitizeProviderJob(providerJob) {
  return {
    id: providerJob.id,
    provider: providerJob.provider,
    status: providerJob.status,
    externalId: providerJob.externalId,
    callbackId: providerJob.callbackId,
    lastPolledAt: providerJob.lastPolledAt,
    lastProviderEventAt: providerJob.lastProviderEventAt,
    errorCode: providerJob.errorCode,
    errorMessage: providerJob.errorMessage,
  };
}

function sanitizeArtifact({ job, artifact }) {
  const contentUrl = `${config.publicBaseUrl}/api/v1/service/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(artifact.id)}/content`;
  return {
    id: artifact.id,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    contentUrl,
  };
}

function sanitizeManifest(manifest) {
  return {
    projectId: manifest.projectId,
    title: manifest.title,
    settings: manifest.settings,
    segments: (manifest.segments ?? []).map((segment) => ({
      sequence: segment.sequence,
      segmentKey: segment.segmentKey,
      title: segment.title,
      required: segment.required,
      heygenVideoId: segment.heygenVideoId,
      status: segment.status,
      sourceUrl: segment.sourceUrl ?? null,
    })),
  };
}

async function sanitizeManifestFromJob(job) {
  const manifest = await loadManifestFromJob(job);
  return manifest ? sanitizeManifest(manifest) : null;
}

async function loadManifestFromJob(job) {
  const manifestPath = job.metadata?.videoAssembly?.manifestPath;
  if (!manifestPath) {
    return null;
  }
  const resolved = path.resolve(manifestPath);
  if (!isPathInside(process.cwd(), resolved)) {
    return null;
  }
  try {
    return JSON.parse(await fsp.readFile(resolved, 'utf8'));
  } catch {
    return null;
  }
}

async function markServiceJobFailed({ jobStateService, job, error, actorUid }) {
  try {
    await jobStateService.transitionJob(job.id, 'failed', {
      actorUid,
      reason: 'service_api_generate_video_failed',
      updates: {
        metadata: {
          ...(job.metadata ?? {}),
          stage: 'HeyGen request failed',
          serviceApiError: {
            message: error.message,
            at: new Date().toISOString(),
          },
        },
      },
    });
  } catch {
    // Keep the original provider error as the response error.
  }
}

async function streamLocalArtifact({ artifact, req, res }) {
  const rootDir = path.resolve(process.cwd(), config.localDataDir);
  const filePath = path.resolve(rootDir, artifact.storageKey);
  if (!isPathInside(rootDir, filePath)) {
    throw badRequest('Invalid artifact path');
  }

  const fileStat = await fsp.stat(filePath);
  const fileSize = fileStat.size;
  const range = req.headers.range;
  const contentType = artifact.mimeType || 'video/mp4';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize || end >= fileSize) {
      res.status(416).set({
        'Content-Range': `bytes */${fileSize}`,
      });
      return res.end();
    }

    const fileStream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    return fileStream.pipe(res);
  }

  res.writeHead(200, {
    'Content-Length': fileSize,
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  return fs.createReadStream(filePath).pipe(res);
}

function splitScriptPreview(script) {
  return script
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readScriptPayload(body) {
  const script = optionalString(body, 'script', { minLength: 1, maxLength: MAX_SCRIPT_LENGTH, defaultValue: null });
  const scriptBase64 = optionalString(body, 'scriptBase64', {
    minLength: 1,
    maxLength: MAX_SCRIPT_BASE64_LENGTH,
    defaultValue: null,
  });
  const scriptEncoding = optionalString(body, 'scriptEncoding', {
    maxLength: 20,
    defaultValue: scriptBase64 ? 'base64' : 'plain',
  });

  if (script && scriptBase64) {
    throw badRequest('Use either script or scriptBase64, not both');
  }

  if (scriptBase64) {
    return validateDecodedScript(decodeBase64Script(scriptBase64), 'scriptBase64');
  }

  if (!script) {
    return null;
  }

  if (scriptEncoding === 'plain') {
    return validateDecodedScript(script, 'script');
  }
  if (scriptEncoding === 'base64') {
    return validateDecodedScript(decodeBase64Script(script), 'script');
  }

  throw badRequest('scriptEncoding is not supported', {
    scriptEncoding,
    allowed: ['plain', 'base64'],
  });
}

function decodeBase64Script(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw badRequest('Base64 script payload is invalid');
  }

  try {
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64');
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    throw badRequest('Base64 script payload must decode to valid UTF-8 text');
  }
}

function validateDecodedScript(value, field) {
  const script = String(value ?? '').trim();
  if (script.length < 10 || script.length > MAX_SCRIPT_LENGTH) {
    throw badRequest(`${field} must decode to between 10 and ${MAX_SCRIPT_LENGTH} characters`);
  }
  return script;
}

function parseMarkdownSlides(script) {
  const blocks = String(script ?? '')
    .split(/(?=^##\s+Slide\s+\d+[:\s-])/gim)
    .map((block) => block.trim())
    .filter((block) => /^##\s+Slide\s+\d+/i.test(block));

  if (blocks.length === 0) {
    return null;
  }

  return blocks.map((block, index) => {
    const lines = block.split('\n');
    const heading = lines.shift() ?? `Slide ${index + 1}`;
    const title = heading.replace(/^##\s+Slide\s+\d+[:\s-]*/i, '').trim() || `Slide ${index + 1}`;
    const prompt = lines
      .filter((line) => !/^\*Duration:/i.test(line.trim()))
      .join('\n')
      .replace(/^---$/gm, '')
      .trim();
    return {
      sequence: (index + 1) * 10,
      segmentKey: slugify(title) || `slide_${index + 1}`,
      title,
      prompt: prompt || title,
      required: true,
    };
  });
}

function optionalSegments(value, field) {
  if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === null || value[field] === undefined) {
    return [];
  }
  if (!Array.isArray(value[field])) {
    throw badRequest(`${field} must be an array`);
  }
  if (value[field].length === 0 || value[field].length > 50) {
    throw badRequest(`${field} must contain between 1 and 50 items`);
  }

  const sequences = new Set();
  const segmentKeys = new Set();
  return value[field].map((segment, index) => {
    const object = requireObject(segment, `${field}[${index}]`);
    rejectUnknownFields(object, ['sequence', 'segmentKey', 'title', 'prompt', 'required'], `${field}[${index}]`);
    const sequence = optionalNumber(object, 'sequence', { min: 1, max: 10000, defaultValue: (index + 1) * 10 });
    const title = requireString(object, 'title', { maxLength: 200 });
    const segmentKey = optionalString(object, 'segmentKey', {
      maxLength: 120,
      defaultValue: slugify(title) || `segment_${sequence}`,
    });
    const prompt = requireString(object, 'prompt', { minLength: 3, maxLength: MAX_SCRIPT_LENGTH });
    if (sequences.has(sequence)) {
      throw badRequest('Duplicate segment sequence', { sequence });
    }
    if (segmentKeys.has(segmentKey)) {
      throw badRequest('Duplicate segment key', { segmentKey });
    }
    sequences.add(sequence);
    segmentKeys.add(segmentKey);
    return {
      sequence,
      segmentKey,
      title,
      prompt,
      required: optionalBoolean(object, 'required', true),
    };
  });
}

function assertServiceScope(req, scope) {
  const scopes = req.serviceClient?.scopes ?? [];
  if (!scopes.includes(scope)) {
    throw forbidden('Service client is not allowed to use this scope', {
      scope,
    });
  }
}

function optionalBoolean(value, field, defaultValue) {
  if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === null || value[field] === undefined) {
    return defaultValue;
  }
  if (typeof value[field] !== 'boolean') {
    throw badRequest(`${field} must be a boolean`);
  }
  return value[field];
}

function slugify(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function isPathInside(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
