import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleVideo,
  createSegmentStatusService,
  downloadSegment,
  getPendingRequiredSegments,
  isProjectReadyToStitch,
  VideoAssemblerError,
} from '@newleaf/video-assembler';
import { config } from '../config.js';
import { conflict } from '../lib/httpErrors.js';
import { buildObjectStorageKey, shouldUseObjectStorage, uploadFileToObjectStorage } from '../lib/assetStorage.js';

const DEFAULT_ASSEMBLY_SETTINGS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  audioSampleRate: 48000,
  videoCodec: 'libx264',
  audioCodec: 'aac',
});

export function createVideoAssemblyService(options = {}) {
  const repository = options.repository;
  const heygenService = options.heygenService;
  const serviceConfig = options.config ?? config.videoAssembler;
  const localDataDir = path.resolve(process.cwd(), config.localDataDir);
  const storageRoot = path.resolve(process.cwd(), serviceConfig.storageDir);
  const manifestsDir = path.join(storageRoot, 'manifests');
  const inputDir = path.join(storageRoot, 'input');
  const outputDir = path.join(storageRoot, 'output');
  const tempDir = path.join(storageRoot, 'temp');
  const segmentStatusService = createSegmentStatusService({
    baseDir: process.cwd(),
    manifestsDir,
  });

  return {
    async createAssemblyRequest({ job, script, actorUid, regenerate = false }) {
      assertDependencies();
      const timestamp = Date.now();
      const projectId = `${safePathSegment(job.id)}-${timestamp}`;
      const segments = normalizeSegments({ job, script, projectId });
      const manifestPath = path.join(manifestsDir, `${projectId}.json`);
      const outputPath = path.join(outputDir, `${projectId}-final.mp4`);

      await Promise.all([
        mkdir(manifestsDir, { recursive: true }),
        mkdir(path.join(inputDir, projectId), { recursive: true }),
        mkdir(outputDir, { recursive: true }),
        mkdir(tempDir, { recursive: true }),
      ]);

      const providerJobs = [];
      const manifestSegments = [];

      for (const segment of segments) {
        const callbackId = `${job.id}:${projectId}:${segment.sequence}:${segment.segmentKey}`;
        const requestPayload = heygenService.buildVideoAgentRequest({
          job,
          segment,
          callbackId,
        });
        const providerRequest = await heygenService.requestVideoAgent(requestPayload);
        const localFilePath = path.join(inputDir, projectId, `${padSequence(segment.sequence)}-${slugify(segment.segmentKey)}.mp4`);
        const manifestSegment = {
          sequence: segment.sequence,
          segmentKey: segment.segmentKey,
          title: segment.title,
          required: segment.required,
          heygenVideoId: providerRequest.externalId,
          status: providerRequest.status === 'completed' ? 'completed' : 'processing',
          sourceUrl: null,
          localFilePath,
        };

        manifestSegments.push(manifestSegment);
        providerJobs.push(
          await repository.createProviderJob({
            jobId: job.id,
            provider: 'heygen',
            status: providerRequest.status,
            externalId: providerRequest.externalId,
            callbackId,
            requestPayload: {
              ...requestPayload,
              providerResponse: providerRequest.providerResponse,
              requestMode: providerRequest.mode,
              regenerate,
              actorUid,
              assembly: {
                projectId,
                manifestPath,
                sequence: segment.sequence,
                segmentKey: segment.segmentKey,
                localFilePath,
                outputPath,
              },
            },
          }),
        );
      }

      const manifest = {
        projectId,
        title: job.title,
        output: outputPath,
        settings: {
          ...DEFAULT_ASSEMBLY_SETTINGS,
          ...(job.metadata?.videoAssemblySettings ?? {}),
        },
        segments: manifestSegments.sort((left, right) => Number(left.sequence) - Number(right.sequence)),
      };

      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      const manifestArtifact = await repository.createArtifact({
        jobId: job.id,
        kind: 'video_manifest',
        storageProvider: 'local-disk',
        storageKey: toLocalStorageKey(manifestPath),
        mimeType: 'application/json',
        sizeBytes: Buffer.byteLength(JSON.stringify(manifest)),
        metadata: {
          projectId,
          manifestPath,
          segmentCount: manifestSegments.length,
          createdBy: actorUid,
          source: 'heygen_video_agent',
        },
      });

      const metadata = buildAssemblyMetadata({
        existingMetadata: job.metadata,
        projectId,
        manifestPath,
        outputPath,
        manifestArtifact,
        manifest,
        status: 'processing',
      });

      const updatedJob = await repository.updateJob(job.id, {
        metadata,
      });

      return {
        job: updatedJob,
        manifest,
        manifestArtifact,
        providerJobs,
      };
    },

    async handleSegmentCompleted({ providerJob, event, actorUid = 'heygen:webhook' }) {
      assertDependencies();
      const assembly = getAssemblyPayload(providerJob);
      if (!event.videoUrl) {
        const message = `Completed HeyGen segment ${providerJob.externalId} did not include a video URL.`;
        await markSegmentFailure({ providerJob, errorCode: 'missing_video_url', errorMessage: message, actorUid });
        return { action: 'segment_completion_missing_url', errorMessage: message };
      }

      const mapping = await segmentStatusService.mapHeyGenVideoId(providerJob.externalId, {
        projectId: assembly.projectId,
      });
      const destinationPath = mapping.segment.localFilePath;

      await materializeSegmentVideo(event.videoUrl, destinationPath);
      const segmentUpdate = await segmentStatusService.updateSegmentCompletion(
        assembly.projectId,
        providerJob.externalId,
        event.videoUrl,
      );
      const entry = await segmentStatusService.loadProjectManifest(assembly.projectId);
      const job = await repository.getJob(providerJob.jobId);
      const pendingSegments = getPendingRequiredSegments(entry.manifest);

      if (!isProjectReadyToStitch(entry.manifest)) {
        await repository.updateJob(providerJob.jobId, {
          metadata: buildAssemblyMetadata({
            existingMetadata: job?.metadata,
            projectId: assembly.projectId,
            manifestPath: entry.manifestPath,
            outputPath: entry.manifest.output,
            manifest: entry.manifest,
            status: 'processing',
            lastCompletedSegment: segmentUpdate,
          }),
        });
        return {
          action: 'segment_completed_waiting_for_others',
          segment: segmentUpdate,
          pendingSegments,
        };
      }

      const assemblyResult = await assembleVideo(entry.manifestPath, {
        baseDir: process.cwd(),
        tempDir,
        ffmpegPath: serviceConfig.ffmpegPath ?? undefined,
        ffprobePath: serviceConfig.ffprobePath ?? undefined,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      const outputStat = await stat(assemblyResult.outputPath);
      const filename = path.basename(assemblyResult.outputPath);
      const objectStorage = shouldUseObjectStorage()
        ? await uploadFileToObjectStorage({
            storageKey: buildObjectStorageKey({
              jobId: providerJob.jobId,
              kind: 'video',
              filename,
            }),
            filePath: assemblyResult.outputPath,
            mimeType: 'video/mp4',
          })
        : null;
      const artifact = await repository.createArtifact({
        jobId: providerJob.jobId,
        kind: 'video',
        storageProvider: objectStorage?.storageProvider ?? 'local-disk',
        storageKey: objectStorage?.storageKey ?? toLocalStorageKey(assemblyResult.outputPath),
        mimeType: 'video/mp4',
        sizeBytes: objectStorage?.sizeBytes ?? outputStat.size,
        metadata: {
          provider: 'heygen',
          assemblyProjectId: assembly.projectId,
          manifestPath: entry.manifestPath,
          source: 'video_assembler',
          segmentCount: entry.manifest.segments.length,
          filename,
          ...(objectStorage?.metadata ?? { localPath: assemblyResult.outputPath }),
        },
      });

      await repository.updateJob(providerJob.jobId, {
        status: 'video_ready',
        currentVideoArtifactId: artifact.id,
        metadata: buildAssemblyMetadata({
          existingMetadata: job?.metadata,
          projectId: assembly.projectId,
          manifestPath: entry.manifestPath,
          outputPath: assemblyResult.outputPath,
          manifest: entry.manifest,
          status: 'ready',
          finalArtifactId: artifact.id,
          lastCompletedSegment: segmentUpdate,
        }),
        lastTransition: {
          from: job?.status ?? 'video_requested',
          to: 'video_ready',
          reason: 'video_assembly_complete',
          actorUid,
          at: new Date().toISOString(),
        },
      });

      return {
        action: 'stitched_video_ready',
        segment: segmentUpdate,
        artifact,
        outputPath: assemblyResult.outputPath,
      };
    },

    async handleSegmentFailed({ providerJob, event, actorUid = 'heygen:webhook' }) {
      return markSegmentFailure({
        providerJob,
        errorCode: event.errorCode ?? 'heygen_failed',
        errorMessage: event.errorMessage ?? 'HeyGen segment generation failed',
        actorUid,
      });
    },

    async completeSegmentForLocalTesting({ jobId, heygenVideoId, completedVideoUrl, actorUid = 'local-admin' }) {
      assertDependencies();
      const providerJob = await repository.findProviderJob({
        provider: 'heygen',
        jobId,
        externalId: heygenVideoId,
      });
      if (!providerJob) {
        throw conflict('HeyGen segment provider job not found', { jobId, heygenVideoId });
      }

      await repository.updateProviderJob(providerJob.id, {
        status: 'success',
        lastProviderEventAt: new Date().toISOString(),
      });

      return this.handleSegmentCompleted({
        providerJob,
        event: {
          videoId: heygenVideoId,
          terminalStatus: 'success',
          videoUrl: completedVideoUrl,
        },
        actorUid,
      });
    },

    async completeSegmentUpload({ jobId, heygenVideoId, buffer, filename = 'segment.mp4', mimeType = 'video/mp4', actorUid = 'local-admin' }) {
      assertDependencies();
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw conflict('Segment upload must contain file bytes', { jobId, heygenVideoId, filename, mimeType });
      }

      const providerJob = await repository.findProviderJob({
        provider: 'heygen',
        jobId,
        externalId: heygenVideoId,
      });
      if (!providerJob) {
        throw conflict('HeyGen segment provider job not found', { jobId, heygenVideoId });
      }

      const assembly = getAssemblyPayload(providerJob);
      const mapping = await segmentStatusService.mapHeyGenVideoId(heygenVideoId, {
        projectId: assembly.projectId,
      });

      await mkdir(path.dirname(mapping.segment.localFilePath), { recursive: true });
      await writeFile(mapping.segment.localFilePath, buffer);
      const updatedProviderJob = await repository.updateProviderJob(providerJob.id, {
        status: 'success',
        lastProviderEventAt: new Date().toISOString(),
      });

      return this.handleSegmentCompleted({
        providerJob: updatedProviderJob,
        event: {
          videoId: heygenVideoId,
          terminalStatus: 'success',
          videoUrl: mapping.segment.localFilePath,
        },
        actorUid,
      });
    },
  };

  async function markSegmentFailure({ providerJob, errorCode, errorMessage, actorUid }) {
    const assembly = getAssemblyPayload(providerJob);
    const entry = await segmentStatusService.loadProjectManifest(assembly.projectId);
    const segment = entry.manifest.segments.find((candidate) => candidate.heygenVideoId === providerJob.externalId);
    if (segment) {
      segment.status = 'failed';
      segment.errorCode = errorCode;
      segment.errorMessage = errorMessage;
      await writeFile(entry.manifestPath, `${JSON.stringify(entry.manifest, null, 2)}\n`, 'utf8');
    }

    const job = await repository.getJob(providerJob.jobId);
    await repository.updateJob(providerJob.jobId, {
      status: 'failed',
      metadata: buildAssemblyMetadata({
        existingMetadata: job?.metadata,
        projectId: assembly.projectId,
        manifestPath: entry.manifestPath,
        outputPath: entry.manifest.output,
        manifest: entry.manifest,
        status: 'failed',
        errorCode,
        errorMessage,
      }),
      lastTransition: {
        from: job?.status ?? 'video_requested',
        to: 'failed',
        reason: 'video_assembly_segment_failed',
        actorUid,
        at: new Date().toISOString(),
      },
    });

    return {
      action: 'marked_assembly_failed',
      errorCode,
      errorMessage,
    };
  }

  function assertDependencies() {
    if (!repository) {
      throw new Error('videoAssemblyService requires repository');
    }
    if (!heygenService) {
      throw new Error('videoAssemblyService requires heygenService');
    }
  }

  function toLocalStorageKey(filePath) {
    const relative = path.relative(localDataDir, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw conflict('Video assembly output must stay inside local data storage', {
        filePath,
        localDataDir,
      });
    }
    return relative;
  }
}

function normalizeSegments({ job, script, projectId }) {
  const rawSegments =
    asArray(script?.segments) ??
    asArray(script?.scenes) ??
    asArray(job.metadata?.videoSegments) ??
    asArray(job.metadata?.scenes) ??
    null;

  if (rawSegments?.length) {
    return rawSegments.map((segment, index) => normalizeSegmentObject(segment, index, job));
  }

  const prompt = stringValue(script?.prompt) ?? stringValue(job.metadata?.prompt) ?? job.title;
  return [
    {
      sequence: 10,
      segmentKey: 'main',
      title: job.title,
      prompt,
      required: true,
      projectId,
    },
  ];
}

function normalizeSegmentObject(segment, index, job) {
  const sequence = positiveSequence(segment.sequence, (index + 1) * 10);
  const title = stringValue(segment.title) ?? stringValue(segment.heading) ?? `${job.title} Segment ${index + 1}`;
  const segmentKey = stringValue(segment.segmentKey) ?? stringValue(segment.key) ?? slugify(title) ?? `segment-${sequence}`;
  const prompt =
    stringValue(segment.prompt) ??
    stringValue(segment.script) ??
    stringValue(segment.narration) ??
    stringValue(segment.text) ??
    title;

  return {
    sequence,
    segmentKey,
    title,
    prompt,
    required: segment.required !== false,
    config: segment.config ?? null,
    files: Array.isArray(segment.files) ? segment.files : [],
  };
}

async function materializeSegmentVideo(sourceUrl, destinationPath) {
  await mkdir(path.dirname(destinationPath), { recursive: true });
  if (/^https?:\/\//i.test(sourceUrl)) {
    await downloadSegment(sourceUrl, destinationPath, { allowOverwrite: true });
    return destinationPath;
  }

  let sourcePath;
  if (/^file:\/\//i.test(sourceUrl)) {
    sourcePath = fileURLToPath(sourceUrl);
  } else {
    sourcePath = path.isAbsolute(sourceUrl) ? sourceUrl : path.resolve(process.cwd(), sourceUrl);
  }

  if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
    return destinationPath;
  }

  await copyFile(sourcePath, destinationPath);
  return destinationPath;
}

function buildAssemblyMetadata({
  existingMetadata = {},
  projectId,
  manifestPath,
  outputPath,
  manifest,
  status,
  finalArtifactId = null,
  lastCompletedSegment = null,
  manifestArtifact = null,
  errorCode = null,
  errorMessage = null,
}) {
  const requiredSegments = manifest.segments.filter((segment) => segment.required === true);
  const completedSegments = requiredSegments.filter((segment) => segment.status === 'completed');
  return {
    ...existingMetadata,
    stage: status === 'ready' ? 'Video ready' : status === 'failed' ? 'Video assembly failed' : 'HeyGen segments rendering',
    videoAssembly: {
      ...(existingMetadata.videoAssembly ?? {}),
      projectId,
      manifestPath,
      outputPath,
      manifestArtifactId: manifestArtifact?.id ?? existingMetadata.videoAssembly?.manifestArtifactId ?? null,
      finalArtifactId: finalArtifactId ?? existingMetadata.videoAssembly?.finalArtifactId ?? null,
      status,
      requiredSegments: requiredSegments.length,
      completedSegments: completedSegments.length,
      pendingSegments: getPendingRequiredSegments(manifest),
      lastCompletedSegment,
      errorCode,
      errorMessage,
      updatedAt: new Date().toISOString(),
    },
  };
}

function getAssemblyPayload(providerJob) {
  const assembly = providerJob.requestPayload?.assembly;
  if (!assembly?.projectId) {
    throw new VideoAssemblerError('Provider job is not linked to a video assembly project', 'MISSING_ASSEMBLY_PROJECT');
  }
  return assembly;
}

function asArray(value) {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function positiveSequence(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function padSequence(sequence) {
  return String(sequence).padStart(5, '0');
}

function safePathSegment(value) {
  return String(value).replace(/[^\w.-]+/g, '_');
}

function slugify(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
