import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/httpErrors.js';
import {
  buildObjectStorageKey,
  isObjectStorageProvider,
  materializeObjectStorageArtifact,
  shouldUseObjectStorage,
  uploadBufferToObjectStorage,
  uploadFileToObjectStorage,
} from '../lib/assetStorage.js';

const THUMBNAIL_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const DEFAULT_THUMBNAIL_WIDTH = 1280;
const DEFAULT_THUMBNAIL_HEIGHT = 720;

export function createVideoThumbnailService(options = {}) {
  const repository = options.repository;
  const serviceConfig = options.config ?? config.videoAssembler;
  const localDataDir = path.resolve(process.cwd(), config.localDataDir);

  return {
    async uploadThumbnail({ jobId, buffer, filename = 'thumbnail.jpg', mimeType = 'image/jpeg', actorUid = null }) {
      assertDependencies();
      const job = await getJobOrThrow(repository, jobId);
      assertImagePayload({ buffer, mimeType });

      const safeFilename = sanitizeFilename(filename);
      const storageKey = path.join('uploads', safePathSegment(jobId), 'thumbnail', `${Date.now()}-${safeFilename}`);
      const filePath = path.resolve(localDataDir, storageKey);
      assertInsideLocalStorage(filePath, localDataDir);

      const objectStorage = shouldUseObjectStorage()
        ? await uploadBufferToObjectStorage({
            storageKey: buildObjectStorageKey({ jobId, kind: 'thumbnail', filename: safeFilename }),
            buffer,
            mimeType: normalizeImageMimeType(mimeType),
          })
        : null;

      if (!objectStorage) {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, buffer);
      }

      const artifact = await repository.createArtifact({
        jobId,
        kind: 'thumbnail',
        storageProvider: objectStorage?.storageProvider ?? 'local-disk',
        storageKey: objectStorage?.storageKey ?? storageKey,
        mimeType: normalizeImageMimeType(mimeType),
        sizeBytes: objectStorage?.sizeBytes ?? buffer.length,
        metadata: {
          filename: safeFilename,
          source: 'admin_upload',
          uploadedBy: actorUid,
          ...(objectStorage?.metadata ?? { localPath: filePath }),
        },
      });

      const updatedJob = await markThumbnailSelected({
        repository,
        job,
        artifact,
        source: 'admin_upload',
        actorUid,
      });

      return { job: updatedJob, artifact };
    },

    async generateThumbnail({ jobId, atSeconds = 2, actorUid = null }) {
      assertDependencies();
      const job = await getJobOrThrow(repository, jobId);
      const artifacts = await repository.listArtifactsForJob(jobId);
      const videoArtifact = selectVideoArtifact(job, artifacts);
      if (!videoArtifact) {
        throw conflict('No local video is available to generate a thumbnail', { jobId });
      }

      const inputPath = isObjectStorageProvider(videoArtifact.storageProvider)
        ? (await materializeObjectStorageArtifact(videoArtifact, {
            localDataDir,
            purpose: 'thumbnail-source',
          })).filePath
        : resolveLocalArtifactPath(videoArtifact, localDataDir);
      const outputStorageKey = path.join('generated', safePathSegment(jobId), 'thumbnails', `${Date.now()}-thumbnail.jpg`);
      const outputPath = path.resolve(localDataDir, outputStorageKey);
      assertInsideLocalStorage(outputPath, localDataDir);

      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await runFfmpegThumbnail({
        ffmpegPath: serviceConfig.ffmpegPath ?? 'ffmpeg',
        inputPath,
        outputPath,
        atSeconds,
      });

      const stat = await fsp.stat(outputPath);
      const objectStorage = shouldUseObjectStorage()
        ? await uploadFileToObjectStorage({
            storageKey: buildObjectStorageKey({
              jobId,
              kind: 'thumbnail',
              filename: path.basename(outputPath),
            }),
            filePath: outputPath,
            mimeType: 'image/jpeg',
          })
        : null;
      const artifact = await repository.createArtifact({
        jobId,
        kind: 'thumbnail',
        storageProvider: objectStorage?.storageProvider ?? 'local-disk',
        storageKey: objectStorage?.storageKey ?? outputStorageKey,
        mimeType: 'image/jpeg',
        sizeBytes: objectStorage?.sizeBytes ?? stat.size,
        metadata: {
          filename: path.basename(outputPath),
          source: 'ffmpeg_snapshot',
          generatedFromArtifactId: videoArtifact.id,
          atSeconds: normalizeTimestamp(atSeconds),
          generatedBy: actorUid,
          ...(objectStorage?.metadata ?? { localPath: outputPath }),
        },
      });

      const updatedJob = await markThumbnailSelected({
        repository,
        job,
        artifact,
        source: 'ffmpeg_snapshot',
        actorUid,
      });

      return { job: updatedJob, artifact };
    },
  };
}

function assertDependencies() {
  // This is intentionally small: the route owns auth and payload shape, this service owns storage and FFmpeg.
}

async function getJobOrThrow(repository, jobId) {
  if (!repository) {
    throw new Error('videoThumbnailService requires repository');
  }
  const job = await repository.getJob(jobId);
  if (!job) {
    throw notFound('Job not found', { jobId });
  }
  return job;
}

function assertImagePayload({ buffer, mimeType }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw badRequest('Thumbnail upload body must contain image bytes');
  }
  if (!THUMBNAIL_MIME_TYPES.has(normalizeImageMimeType(mimeType))) {
    throw badRequest('Unsupported thumbnail image type', {
      mimeType,
      allowed: Array.from(THUMBNAIL_MIME_TYPES),
    });
  }
}

function selectVideoArtifact(job, artifacts) {
  const current = artifacts.find((artifact) => artifact.id === job.currentVideoArtifactId && artifact.kind === 'video');
  if (current && (current.storageProvider === 'local-disk' || isObjectStorageProvider(current.storageProvider))) {
    return current;
  }

  return [...artifacts]
    .filter((artifact) => artifact.kind === 'video' && (artifact.storageProvider === 'local-disk' || isObjectStorageProvider(artifact.storageProvider)))
    .sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? 0) - Date.parse(left.updatedAt ?? left.createdAt ?? 0))[0];
}

function resolveLocalArtifactPath(artifact, localDataDir) {
  const candidatePath = artifact.metadata?.localPath
    ? path.resolve(artifact.metadata.localPath)
    : path.resolve(localDataDir, artifact.storageKey);
  assertInsideLocalStorage(candidatePath, localDataDir);
  return candidatePath;
}

async function markThumbnailSelected({ repository, job, artifact, source, actorUid }) {
  return repository.updateJob(job.id, {
    metadata: {
      ...(job.metadata ?? {}),
      thumbnailArtifactId: artifact.id,
      thumbnailUrl: `/api/v1/assets/${encodeURIComponent(artifact.id)}/content`,
      thumbnailSource: source,
      thumbnailUpdatedAt: new Date().toISOString(),
      thumbnailUpdatedBy: actorUid,
    },
  });
}

async function runFfmpegThumbnail({ ffmpegPath, inputPath, outputPath, atSeconds }) {
  const filter = [
    `scale=${DEFAULT_THUMBNAIL_WIDTH}:${DEFAULT_THUMBNAIL_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${DEFAULT_THUMBNAIL_WIDTH}:${DEFAULT_THUMBNAIL_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
  ].join(',');

  const args = [
    '-y',
    '-ss',
    String(normalizeTimestamp(atSeconds)),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    filter,
    '-q:v',
    '2',
    outputPath,
  ];

  await runCommand(ffmpegPath, args, { commandName: 'FFmpeg' });
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      reject(commandSpawnError(error, command, options));
      return;
    }
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(commandSpawnError(error, command, options));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(conflict(`${options.commandName ?? command} failed while generating thumbnail`, {
        exitCode: code,
        detail: lastLines(stderr),
      }));
    });
  });
}

function commandSpawnError(error, command, options = {}) {
  if (error?.code === 'ENOENT') {
    return conflict(`${options.commandName ?? command} is not installed or not available in PATH`);
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return conflict(`${options.commandName ?? command} could not be executed: ${error.message}`);
  }
  return error;
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 2;
  }
  return Math.min(3600, numeric);
}

function normalizeImageMimeType(value) {
  const normalized = String(value ?? '').split(';')[0].trim().toLowerCase();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function sanitizeFilename(value) {
  const filename = path.basename(value).replace(/[^\w.\- ]+/g, '_').trim();
  return filename || 'thumbnail.jpg';
}

function safePathSegment(value) {
  return String(value).replace(/[^\w.-]+/g, '_');
}

function assertInsideLocalStorage(filePath, localDataDir) {
  const relative = path.relative(localDataDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw badRequest('Thumbnail path is outside local storage');
  }
}

function lastLines(value, count = 10) {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count)
    .join('\n');
}
