import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { notFound } from '../lib/httpErrors.js';
import {
  optionalObject,
  optionalString,
  optionalStringArray,
  pickDefined,
  rejectUnknownFields,
  requireAllowed,
  requireObject,
  requireString,
} from '../lib/validation.js';

const SMART_COLLECTION_TYPES = Object.freeze([
  'content_jobs',
  'video_assets',
  'published_videos',
  'audit_events',
]);

const SMART_COLLECTION_STATUSES = Object.freeze(['active', 'archived']);
const SMART_COLLECTION_VISIBILITIES = Object.freeze(['private', 'team']);

export function createSmartCollectionsRouter({ repository }) {
  const router = Router();

  router.get(
    '/smart-collections',
    requireRole('admin', 'editor', 'reviewer', 'publisher', 'viewer'),
    asyncHandler(async (req, res) => {
      const filters = {
        status: validateOptionalAllowed(req.query, 'status', SMART_COLLECTION_STATUSES),
        type: validateOptionalAllowed(req.query, 'type', SMART_COLLECTION_TYPES),
        ownerUid: optionalString(req.query, 'ownerUid', { maxLength: 128 }),
      };
      const collections = await repository.listSmartCollections(filters);
      res.json({ smartCollections: collections });
    }),
  );

  router.post(
    '/smart-collections',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, [
        'name',
        'description',
        'type',
        'status',
        'visibility',
        'ownerUid',
        'criteria',
        'sort',
        'columns',
        'metadata',
      ]);

      const smartCollection = await repository.createSmartCollection({
        name: requireString(body, 'name', { maxLength: 120 }),
        description: optionalString(body, 'description', { maxLength: 500, defaultValue: null }),
        type: validateOptionalAllowed(body, 'type', SMART_COLLECTION_TYPES, 'content_jobs'),
        status: validateOptionalAllowed(body, 'status', SMART_COLLECTION_STATUSES, 'active'),
        visibility: validateOptionalAllowed(body, 'visibility', SMART_COLLECTION_VISIBILITIES, 'team'),
        ownerUid: optionalString(body, 'ownerUid', { maxLength: 128, defaultValue: req.user.uid }),
        criteria: optionalObject(body, 'criteria', { defaultValue: {} }),
        sort: optionalObject(body, 'sort', { defaultValue: {} }),
        columns: optionalStringArray(body, 'columns', { maxItems: 30, defaultValue: [] }),
        metadata: optionalObject(body, 'metadata', { defaultValue: {} }),
        createdBy: req.user.uid,
      });

      res.status(201).json({ smartCollection });
    }),
  );

  router.get(
    '/smart-collections/:collectionId',
    requireRole('admin', 'editor', 'reviewer', 'publisher', 'viewer'),
    asyncHandler(async (req, res) => {
      const smartCollection = await repository.getSmartCollection(req.params.collectionId);
      if (!smartCollection) {
        throw notFound('Smart collection not found', { collectionId: req.params.collectionId });
      }
      res.json({ smartCollection });
    }),
  );

  router.patch(
    '/smart-collections/:collectionId',
    requireRole('admin', 'editor'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, [
        'name',
        'description',
        'type',
        'status',
        'visibility',
        'ownerUid',
        'criteria',
        'sort',
        'columns',
        'metadata',
      ]);

      const patch = pickDefined({
        name: optionalString(body, 'name', { maxLength: 120 }),
        description: optionalString(body, 'description', { maxLength: 500 }),
        type: validateOptionalAllowed(body, 'type', SMART_COLLECTION_TYPES),
        status: validateOptionalAllowed(body, 'status', SMART_COLLECTION_STATUSES),
        visibility: validateOptionalAllowed(body, 'visibility', SMART_COLLECTION_VISIBILITIES),
        ownerUid: optionalString(body, 'ownerUid', { maxLength: 128 }),
        criteria: optionalObject(body, 'criteria'),
        sort: optionalObject(body, 'sort'),
        columns: optionalStringArrayIfPresent(body, 'columns', { maxItems: 30 }),
        metadata: optionalObject(body, 'metadata'),
      });

      const smartCollection = await repository.updateSmartCollection(req.params.collectionId, patch);
      if (!smartCollection) {
        throw notFound('Smart collection not found', { collectionId: req.params.collectionId });
      }
      res.json({ smartCollection });
    }),
  );

  router.delete(
    '/smart-collections/:collectionId',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const smartCollection = await repository.deleteSmartCollection(req.params.collectionId);
      if (!smartCollection) {
        throw notFound('Smart collection not found', { collectionId: req.params.collectionId });
      }
      res.json({ deleted: smartCollection });
    }),
  );

  return router;
}

function validateOptionalAllowed(source, field, allowedValues, defaultValue = undefined) {
  const value = optionalString(source, field, { maxLength: 80, defaultValue });
  return value === undefined ? undefined : requireAllowed(value, field, allowedValues);
}

function optionalStringArrayIfPresent(source, field, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(source, field)) {
    return undefined;
  }
  return optionalStringArray(source, field, options);
}
