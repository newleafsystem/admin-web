import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router, raw } from 'express';
import { config } from '../config.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badRequest, notFound } from '../lib/httpErrors.js';
import {
  buildObjectStorageKey,
  isObjectStorageProvider,
  sanitizeFilename,
  shouldUseObjectStorage,
  streamObjectStorageArtifact,
  uploadBufferToObjectStorage,
} from '../lib/assetStorage.js';
import {
  optionalNumber,
  optionalObject,
  optionalString,
  rejectUnknownFields,
  requireObject,
  requireString,
} from '../lib/validation.js';

const ARTIFACT_KINDS = new Set([
  'source_pdf',
  'extracted_text',
  'script',
  'video',
  'video_manifest',
  'thumbnail',
  'captions',
  'request_payload',
  'recommendation_archive',
  'recommendation_video_script',
  'recommendation_pdf',
  'recommendation_social_copy',
]);

export function createAssetsRouter({ repository }) {
  const router = Router();

  router.post(
    '/local-upload',
    requireRole('admin', 'editor'),
    raw({ type: '*/*', limit: '500mb' }),
    asyncHandler(async (req, res) => {
      const uploadBuffer = readUploadBuffer(req.body);

      const jobId = requireString(req.query, 'jobId', { maxLength: 200 });
      const job = await repository.getJob(jobId);
      if (!job) throw notFound('Job not found', { jobId });

      const kind = requireString(req.query, 'kind', { maxLength: 80 });
      if (!ARTIFACT_KINDS.has(kind)) {
        throw badRequest('Unsupported artifact kind', { kind, allowed: Array.from(ARTIFACT_KINDS) });
      }

      const filename = sanitizeFilename(requireString(req.query, 'filename', { maxLength: 300 }));
      const mimeType = optionalString(req.query, 'mimeType', {
        maxLength: 200,
        defaultValue: req.get('content-type') ?? 'application/octet-stream',
      });

      if (shouldUseObjectStorage()) {
        const storageKey = buildObjectStorageKey({ jobId, kind, filename });
        const stored = await uploadBufferToObjectStorage({
          storageKey,
          buffer: uploadBuffer,
          mimeType,
        });
        const artifact = await repository.createArtifact({
          jobId,
          kind,
          storageProvider: stored.storageProvider,
          storageKey: stored.storageKey,
          mimeType,
          sizeBytes: stored.sizeBytes,
          metadata: {
            filename,
            uploadedVia: 'admin-console',
            ...stored.metadata,
          },
        });

        if (kind === 'video') {
          await repository.updateJob(jobId, { currentVideoArtifactId: artifact.id });
        }

        return res.status(201).json({ artifact });
      }

      const rootDir = path.resolve(process.cwd(), config.localDataDir);
      const storageKey = path.join('uploads', safePathSegment(jobId), safePathSegment(kind), `${Date.now()}-${filename}`);
      const filePath = path.resolve(rootDir, storageKey);
      if (!isPathInside(rootDir, filePath)) {
        throw badRequest('Invalid upload path');
      }

      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, uploadBuffer);

      const artifact = await repository.createArtifact({
        jobId,
        kind,
        storageProvider: 'local-disk',
        storageKey,
        mimeType,
        sizeBytes: uploadBuffer.length,
        metadata: {
          filename,
          localPath: filePath,
          uploadedVia: 'admin-console',
        },
      });

      if (kind === 'video') {
        await repository.updateJob(jobId, { currentVideoArtifactId: artifact.id });
      }

      res.status(201).json({ artifact });
    }),
  );

  router.post(
    '/upload-url',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['jobId', 'kind', 'filename', 'mimeType', 'sizeBytes', 'checksum', 'metadata']);
      const jobId = requireString(body, 'jobId', { maxLength: 200 });
      const job = await repository.getJob(jobId);
      if (!job) throw notFound('Job not found', { jobId });

      const kind = requireString(body, 'kind', { maxLength: 80 });
      if (!ARTIFACT_KINDS.has(kind)) {
        throw badRequest('Unsupported artifact kind', { kind, allowed: Array.from(ARTIFACT_KINDS) });
      }

      const filename = requireString(body, 'filename', { maxLength: 300 });
      const mimeType = requireString(body, 'mimeType', { maxLength: 200 });
      const artifact = await repository.createArtifact({
        jobId,
        kind,
        storageProvider: 'dev-memory',
        storageKey: `jobs/${jobId}/${kind}/${Date.now()}-${filename}`,
        mimeType,
        sizeBytes: optionalNumber(body, 'sizeBytes', { min: 0, defaultValue: null }),
        checksum: optionalString(body, 'checksum', { maxLength: 200, defaultValue: null }),
        metadata: optionalObject(body, 'metadata', { defaultValue: {} }),
      });

      res.status(201).json({
        artifact,
        upload: {
          method: 'PUT',
          url: `dev://uploads/${artifact.id}`,
          expiresInSec: 900,
          TODO: 'Replace with signed Firebase Storage / GCS upload URL generation.',
        },
      });
    }),
  );

  router.get(
    '/:artifactId/content',
    requireRole('admin', 'editor', 'reviewer', 'publisher', 'viewer'),
    asyncHandler(async (req, res) => {
      const artifact = await repository.getArtifact(req.params.artifactId);
      if (!artifact) throw notFound('Artifact not found', { artifactId: req.params.artifactId });

      if (artifact.storageProvider === 'provider-url' && /^https?:\/\//i.test(artifact.storageKey)) {
        return res.redirect(302, artifact.storageKey);
      }

      if (isObjectStorageProvider(artifact.storageProvider)) {
        return streamObjectStorageArtifact({
          artifact,
          range: req.headers.range ?? null,
          response: res,
        });
      }

      if (artifact.storageProvider !== 'local-disk') {
        throw badRequest('Artifact is not streamable from local API storage', {
          artifactId: artifact.id,
          storageProvider: artifact.storageProvider,
        });
      }

      const rootDir = path.resolve(process.cwd(), config.localDataDir);
      const filePath = path.resolve(rootDir, artifact.storageKey);
      if (!isPathInside(rootDir, filePath)) {
        throw badRequest('Invalid artifact path');
      }

      const stat = await fsp.stat(filePath);
      const fileSize = stat.size;
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

        const chunkSize = end - start + 1;
        const fileStream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
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
    }),
  );

  router.get(
    '/:artifactId/download-url',
    requireRole('admin', 'editor', 'reviewer', 'publisher', 'viewer'),
    asyncHandler(async (req, res) => {
      const artifact = await repository.getArtifact(req.params.artifactId);
      if (!artifact) throw notFound('Artifact not found', { artifactId: req.params.artifactId });

      res.json({
        artifact,
        download: {
          method: 'GET',
          url: `dev://downloads/${artifact.id}`,
          expiresInSec: 900,
          TODO: 'Replace with short-lived signed download URLs from the selected storage provider.',
        },
      });
    }),
  );

  return router;
}

function readUploadBuffer(value) {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw badRequest('Upload body must contain file bytes');
  }
  return Buffer.from(value);
}

function safePathSegment(value) {
  return String(value).replace(/[^\w.-]+/g, '_');
}

function isPathInside(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
