import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Storage } from '@google-cloud/storage';
import { config } from '../config.js';
import { badGateway, badRequest, conflict } from './httpErrors.js';

let storageClient = null;

export function isObjectStorageProvider(provider) {
  return String(provider ?? '').toLowerCase() === 'gcs';
}

export function shouldUseObjectStorage() {
  return Boolean(config.storage.bucket);
}

export function buildObjectStorageKey({ jobId, kind, filename, timestamp = Date.now() }) {
  return [
    'uploads',
    safeObjectSegment(jobId),
    safeObjectSegment(kind),
    `${timestamp}-${sanitizeFilename(filename)}`,
  ].join('/');
}

export function buildObjectStorageJobPrefix(jobId) {
  return `uploads/${safeObjectSegment(jobId)}/`;
}

export async function uploadBufferToObjectStorage({
  storageKey,
  buffer,
  mimeType,
  cacheControl = null,
  contentDisposition = null,
}) {
  const file = objectStorageBucket().file(assertSafeObjectKey(storageKey));
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType: mimeType || 'application/octet-stream',
      ...(cacheControl ? { cacheControl } : {}),
      ...(contentDisposition ? { contentDisposition } : {}),
    },
  });
  const [metadata] = await file.getMetadata();
  return {
    storageProvider: 'gcs',
    storageKey,
    sizeBytes: Number(metadata.size ?? buffer.length),
    metadata: {
      bucket: objectStorageBucketName(),
      objectGeneration: metadata.generation ?? null,
    },
  };
}

export async function downloadObjectStorageArtifactBuffer(artifact) {
  if (!isObjectStorageProvider(artifact?.storageProvider)) {
    throw conflict('Artifact is not stored in object storage', {
      artifactId: artifact?.id ?? null,
      storageProvider: artifact?.storageProvider ?? null,
    });
  }
  const file = objectStorageBucket().file(assertSafeObjectKey(artifact.storageKey));
  const [buffer] = await file.download();
  return buffer;
}

export async function uploadFileToObjectStorage({ storageKey, filePath, mimeType }) {
  const file = objectStorageBucket().file(assertSafeObjectKey(storageKey));
  await pipeline(fs.createReadStream(filePath), file.createWriteStream({
    resumable: false,
    metadata: {
      contentType: mimeType || 'application/octet-stream',
    },
  }));
  const [metadata] = await file.getMetadata();
  return {
    storageProvider: 'gcs',
    storageKey,
    sizeBytes: Number(metadata.size ?? 0),
    metadata: {
      bucket: objectStorageBucketName(),
      objectGeneration: metadata.generation ?? null,
    },
  };
}

export async function getObjectStorageMetadata(artifact) {
  const file = objectStorageBucket().file(assertSafeObjectKey(artifact.storageKey));
  const [metadata] = await file.getMetadata();
  return {
    sizeBytes: Number(metadata.size ?? artifact.sizeBytes ?? 0),
    contentType: metadata.contentType ?? artifact.mimeType ?? 'application/octet-stream',
  };
}

export async function streamObjectStorageArtifact({ artifact, range = null, response }) {
  return streamObjectStorageKey({
    storageKey: artifact.storageKey,
    range,
    response,
    fallbackContentType: artifact.mimeType,
  });
}

export async function streamObjectStorageKey({
  storageKey,
  range = null,
  response,
  fallbackContentType = 'application/octet-stream',
  headOnly = false,
  cacheControl = null,
  contentDisposition = null,
}) {
  const file = objectStorageBucket().file(assertSafeObjectKey(storageKey));
  const [rawMetadata] = await file.getMetadata();
  const metadata = {
    sizeBytes: Number(rawMetadata.size ?? 0),
    contentType: rawMetadata.contentType ?? fallbackContentType,
    cacheControl: cacheControl ?? rawMetadata.cacheControl ?? null,
    contentDisposition: contentDisposition ?? rawMetadata.contentDisposition ?? null,
  };
  const fileSize = metadata.sizeBytes;
  const contentType = metadata.contentType;

  if (range) {
    const { start, end } = parseRangeHeader(range, fileSize);
    const chunkSize = end - start + 1;
    response.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      ...(metadata.cacheControl ? { 'Cache-Control': metadata.cacheControl } : {}),
      ...(metadata.contentDisposition ? { 'Content-Disposition': metadata.contentDisposition } : {}),
      'X-Content-Type-Options': 'nosniff',
    });
    if (headOnly) return response.end();
    return file.createReadStream({ start, end }).pipe(response);
  }

  response.writeHead(200, {
    'Content-Length': fileSize,
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    ...(metadata.cacheControl ? { 'Cache-Control': metadata.cacheControl } : {}),
    ...(metadata.contentDisposition ? { 'Content-Disposition': metadata.contentDisposition } : {}),
    'X-Content-Type-Options': 'nosniff',
  });
  if (headOnly) return response.end();
  return file.createReadStream().pipe(response);
}

export async function tryStreamObjectStorageKey({
  storageKey,
  range = null,
  response,
  fallbackContentType = 'application/octet-stream',
  headOnly = false,
  cacheControl = null,
  contentDisposition = null,
}) {
  if (!shouldUseObjectStorage()) {
    return false;
  }
  try {
    await streamObjectStorageKey({
      storageKey,
      range,
      response,
      fallbackContentType,
      headOnly,
      cacheControl,
      contentDisposition,
    });
    return true;
  } catch (error) {
    if (isObjectNotFoundError(error)) {
      return false;
    }
    throw badGateway('Unable to stream public object storage asset', {
      storageKey,
      status: error.code ?? error.status ?? null,
    });
  }
}

export async function materializeObjectStorageArtifact(artifact, { localDataDir, purpose = 'publisher' } = {}) {
  if (!isObjectStorageProvider(artifact.storageProvider)) {
    throw conflict('Artifact is not stored in object storage', {
      artifactId: artifact.id,
      storageProvider: artifact.storageProvider,
    });
  }

  const rootDir = path.resolve(process.cwd(), localDataDir ?? config.localDataDir);
  const filename = sanitizeFilename(artifact.metadata?.filename ?? path.basename(artifact.storageKey) ?? `${artifact.id}.bin`);
  const filePath = path.resolve(rootDir, 'object-cache', safeObjectSegment(purpose), safeObjectSegment(artifact.id), filename);
  assertPathInside(rootDir, filePath);

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const file = objectStorageBucket().file(assertSafeObjectKey(artifact.storageKey));
  await pipeline(file.createReadStream(), fs.createWriteStream(filePath));
  const stat = await fsp.stat(filePath);

  return {
    artifact,
    filePath,
    filename,
    mimeType: artifact.mimeType || 'application/octet-stream',
    sizeBytes: stat.size,
  };
}

export async function deleteObjectStorageArtifact(artifact, { ignoreNotFound = true } = {}) {
  if (!isObjectStorageProvider(artifact?.storageProvider)) {
    return {
      deleted: false,
      skipped: true,
      reason: 'not_object_storage',
      artifactId: artifact?.id ?? null,
      storageProvider: artifact?.storageProvider ?? null,
    };
  }

  const storageKeys = [
    artifact.storageKey,
    ...normalizeAdditionalStorageKeys(artifact.metadata?.additionalStorageKeys),
  ].map(assertSafeObjectKey);
  const bucket = objectStorageBucket();
  const deletedKeys = [];
  const skippedKeys = [];

  for (const storageKey of storageKeys) {
    const file = bucket.file(storageKey);
    try {
      await file.delete({ ignoreNotFound });
      deletedKeys.push(storageKey);
    } catch (error) {
      if (ignoreNotFound && isObjectNotFoundError(error)) {
        skippedKeys.push(storageKey);
        continue;
      }
      throw badGateway('Unable to delete artifact from object storage', {
        artifactId: artifact.id,
        storageProvider: artifact.storageProvider,
        storageKey,
        status: error.code ?? error.status ?? null,
      });
    }
  }

  return {
    deleted: deletedKeys.length > 0,
    skipped: deletedKeys.length === 0,
    artifactId: artifact.id,
    storageProvider: artifact.storageProvider,
    storageKey: storageKeys[0],
    storageKeys,
    deletedKeys,
    skippedKeys,
    reason: deletedKeys.length > 0 ? null : 'object_not_found',
    bucket: objectStorageBucketName(),
  };
}

export async function deleteObjectStoragePrefix(prefix, { ignoreNotFound = true } = {}) {
  const storagePrefix = assertSafeObjectPrefix(prefix);
  try {
    await objectStorageBucket().deleteFiles({ prefix: storagePrefix, force: true });
  } catch (error) {
    if (ignoreNotFound && isObjectNotFoundError(error)) {
      return {
        deleted: false,
        skipped: true,
        reason: 'prefix_not_found',
        prefix: storagePrefix,
      };
    }
    throw badGateway('Unable to delete object storage prefix', {
      prefix: storagePrefix,
      status: error.code ?? error.status ?? null,
    });
  }

  return {
    deleted: true,
    skipped: false,
    prefix: storagePrefix,
    bucket: objectStorageBucketName(),
  };
}

export function sanitizeFilename(value) {
  const filename = path.basename(String(value ?? '')).replace(/[^\w.\- ]+/g, '_').trim();
  return filename || 'upload.bin';
}

export function assertSafeObjectKey(value) {
  const key = String(value ?? '');
  if (
    !key ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.split('/').includes('..')
  ) {
    throw badRequest('Invalid object storage key');
  }
  return key;
}

function assertSafeObjectPrefix(value) {
  const prefix = assertSafeObjectKey(value);
  if (!prefix.endsWith('/')) {
    throw badRequest('Invalid object storage prefix');
  }
  return prefix;
}

function objectStorageBucket() {
  if (!storageClient) {
    storageClient = new Storage();
  }
  return storageClient.bucket(objectStorageBucketName());
}

function objectStorageBucketName() {
  const bucketName = config.storage.bucket;
  if (!bucketName) {
    throw conflict('Object storage bucket is not configured', {
      env: 'GCS_BUCKET',
    });
  }
  return bucketName;
}

function parseRangeHeader(range, fileSize) {
  const parts = String(range).replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
    const error = badRequest('Invalid range request');
    error.status = 416;
    throw error;
  }
  return { start, end };
}

function safeObjectSegment(value) {
  return String(value ?? 'item').replace(/[^\w.-]+/g, '_') || 'item';
}

function normalizeAdditionalStorageKeys(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function assertPathInside(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw conflict('Resolved object cache path is outside local storage');
  }
}

function isObjectNotFoundError(error) {
  return Number(error?.code ?? error?.status) === 404;
}
