import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router, raw } from 'express';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badRequest, notFound } from '../lib/httpErrors.js';
import {
  optionalString,
  rejectUnknownFields,
  requireObject,
  requireString,
} from '../lib/validation.js';

export function createVideoProjectsRouter({ videoStudioService }) {
  const router = Router();

  router.post(
    '/video-projects',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['projectId', 'title']);
      const result = await videoStudioService.createProject({
        projectId: optionalString(body, 'projectId', { maxLength: 120, defaultValue: null }),
        title: requireString(body, 'title', { maxLength: 300 }),
        actorUid: req.user.uid,
      });
      res.status(201).json(result);
    }),
  );

  router.get(
    '/video-projects/:projectId/timeline',
    requireRole('admin', 'editor', 'reviewer', 'viewer'),
    asyncHandler(async (req, res) => {
      res.json(await videoStudioService.readProject(req.params.projectId));
    }),
  );

  router.delete(
    '/video-projects/:projectId',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const result = await videoStudioService.deleteProject(req.params.projectId, {
        actorUid: req.user.uid,
      });
      res.json(result);
    }),
  );

  router.put(
    '/video-projects/:projectId/timeline',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const timeline = requireObject(req.body);
      const result = await videoStudioService.updateTimeline(req.params.projectId, timeline);
      res.json(result);
    }),
  );

  router.post(
    '/video-projects/:projectId/assets',
    requireRole('admin', 'editor'),
    raw({ type: '*/*', limit: '500mb' }),
    asyncHandler(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw badRequest('Upload body must contain file bytes');
      }
      const result = await videoStudioService.uploadAsset(req.params.projectId, {
        type: requireString(req.query, 'type', { maxLength: 80 }),
        filename: requireString(req.query, 'filename', { maxLength: 300 }),
        mimeType: optionalString(req.query, 'mimeType', {
          maxLength: 200,
          defaultValue: req.get('content-type') ?? 'application/octet-stream',
        }),
        buffer: req.body,
        actorUid: req.user.uid,
      });
      res.status(201).json(result);
    }),
  );

  router.delete(
    '/video-projects/:projectId/assets/:trackId',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const result = await videoStudioService.deleteAsset(req.params.projectId, {
        trackId: req.params.trackId,
        actorUid: req.user.uid,
      });
      res.json(result);
    }),
  );

  router.get(
    '/video-projects/:projectId/assets/*',
    requireRole('admin', 'editor', 'reviewer', 'viewer'),
    asyncHandler(async (req, res) => {
      const assetPath = req.params[0];
      const { filePath } = videoStudioService.createAssetReadStream(req.params.projectId, assetPath);
      await streamFile({ req, res, filePath, contentType: contentTypeForPath(filePath) });
    }),
  );

  router.post(
    '/video-projects/:projectId/render',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const result = await videoStudioService.renderProject(req.params.projectId, {
        actorUid: req.user.uid,
      });
      res.status(202).json(result);
    }),
  );

  router.get(
    '/video-projects/:projectId/status',
    requireRole('admin', 'editor', 'reviewer', 'viewer'),
    asyncHandler(async (req, res) => {
      res.json(await videoStudioService.readProject(req.params.projectId));
    }),
  );

  router.get(
    '/video-projects/:projectId/output',
    requireRole('admin', 'editor', 'reviewer', 'viewer'),
    asyncHandler(async (req, res) => {
      const project = await videoStudioService.readProject(req.params.projectId);
      const outputPath = videoStudioService.getOutputPath(req.params.projectId, project.timeline.output);
      if (!(await exists(outputPath))) {
        throw notFound('Rendered output not found', { projectId: req.params.projectId });
      }
      await streamFile({
        req,
        res,
        filePath: outputPath,
        contentType: 'video/mp4',
      });
    }),
  );

  return router;
}

async function streamFile({ req, res, filePath, contentType }) {
  const stat = await fsp.stat(filePath);
  const range = req.get('range');
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      throw badRequest('Invalid range header');
    }
    const start = match[1] === '' ? 0 : Number(match[1]);
    const end = match[2] === '' ? stat.size - 1 : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= stat.size) {
      res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
      return;
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.mp3', '.mpeg'].includes(ext)) return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  return 'video/mp4';
}
