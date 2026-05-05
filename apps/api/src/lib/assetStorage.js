import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Storage } from '@google-cloud/storage';
import { config } from '../config.js';
import { badRequest, conflict } from './httpErrors.js';

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

export async function uploadBufferToObjectStorage({ storageKey, buffer, mimeType }) {
  const file = objectStorageBucket().file(assertSafeObjectKey(storageKey));
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType: mimeType || 'application/octet-stream',
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
  const file = objectStorageBucket().file(assertSafeObjectKey(artifact.storageKey));
  const metadata = await getObjectStorageMetadata(artifact);
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
      'X-Content-Type-Options': 'nosniff',
    });
    return file.createReadStream({ start, end }).pipe(response);
  }

  response.writeHead(200, {
    'Content-Length': fileSize,
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  return file.createReadStream().pipe(response);
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

function assertPathInside(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw conflict('Resolved object cache path is outside local storage');
  }
}
