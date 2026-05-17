import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { notFound } from '../lib/httpErrors.js';
import { requireObject } from '../lib/validation.js';

export function createRecommendationBatchesRouter({ recommendationBatchService }) {
  const router = Router();

  router.get(
    '/recommendation-batches',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const batches = await recommendationBatchService.listBatches({
        status: req.query.status,
      });
      res.json({ recommendationBatches: batches });
    }),
  );

  router.post(
    '/recommendation-batches',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      const recommendationBatch = await recommendationBatchService.createBatch(body, {
        actorUid: req.user?.uid ?? null,
      });
      res.status(201).json({ recommendationBatch });
    }),
  );

  router.get(
    '/recommendation-batches/:batchId',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const recommendationBatch = await recommendationBatchService.getBatch(req.params.batchId);
      res.json({ recommendationBatch });
    }),
  );

  router.patch(
    '/recommendation-batches/:batchId',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      const recommendationBatch = await recommendationBatchService.updateBatch(req.params.batchId, body, {
        actorUid: req.user?.uid ?? null,
      });
      res.json({ recommendationBatch });
    }),
  );

  router.post(
    '/recommendation-batches/:batchId/approve',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const recommendationBatch = await recommendationBatchService.approveBatch(req.params.batchId, {
        actorUid: req.user?.uid ?? null,
      });
      res.json({ recommendationBatch });
    }),
  );

  router.post(
    '/recommendation-batches/:batchId/publish',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const recommendationBatch = await recommendationBatchService.publishBatch(req.params.batchId, {
        actorUid: req.user?.uid ?? null,
      });
      res.json({ recommendationBatch });
    }),
  );

  return router;
}

export function createPublicRecommendationBatchesRouter({ recommendationBatchService }) {
  const router = Router();

  router.get(
    '/recommendations/latest',
    asyncHandler(async (req, res) => {
      const recommendationBatch = await recommendationBatchService.getLatestPublishedBatch();
      if (!recommendationBatch) {
        throw notFound('Published recommendation batch not found');
      }
      res
        .set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
        .json({ recommendationBatch: recommendationBatch.publicData });
    }),
  );

  router.get(
    '/recommendations/:batchId',
    asyncHandler(async (req, res) => {
      const recommendationBatch = await recommendationBatchService.getPublishedBatch(req.params.batchId);
      res
        .set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
        .json({ recommendationBatch: recommendationBatch.publicData });
    }),
  );

  return router;
}
