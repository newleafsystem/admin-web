import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Storage } from '@google-cloud/storage';

export function createStorageClientFromEnv(env = process.env) {
  const bucketName = env.GCS_BUCKET;
  if (!bucketName) {
    throw new Error('Missing media storage bucket: set GCS_BUCKET');
  }

  return {
    provider: 'gcs',
    bucketName,
    bucket: new Storage().bucket(bucketName),
  };
}

export async function downloadObject({ storage, key, destinationPath }) {
  if (!isSafeObjectKey(key)) {
    throw new Error(`Unsafe media object key: ${key}`);
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  await pipeline(storage.bucket.file(key).createReadStream(), createWriteStream(destinationPath));
  return destinationPath;
}

export async function uploadObject({ storage, key, sourcePath, contentType = 'video/mp4' }) {
  if (!isSafeObjectKey(key)) {
    throw new Error(`Unsafe media object key: ${key}`);
  }
  await storage.bucket.upload(sourcePath, {
    destination: key,
    metadata: {
      contentType,
    },
  });
  return key;
}

function isSafeObjectKey(value) {
  const key = String(value ?? '');
  return key.length > 0
    && key.length <= 1024
    && !key.startsWith('/')
    && !key.includes('\\')
    && !key.split('/').includes('..');
}
