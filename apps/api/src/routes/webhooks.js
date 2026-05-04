import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badRequest } from '../lib/httpErrors.js';

const SOCIAL_PLATFORMS = ['youtube', 'x', 'linkedin', 'instagram', 'facebook', 'tiktok'];

export function createHeyGenWebhookRouter({ repository, heygenService, jobStateService }) {
  const router = Router();

  router.options('/', (req, res) => {
    res.set('allow', 'OPTIONS, POST').status(204).send();
  });

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
      const verification = heygenService.verifyWebhookSignature({
        rawBody,
        headers: req.headers,
      });
      const event = heygenService.parseWebhookEvent(rawBody);
      const recorded = await repository.recordWebhookEvent({
        idempotencyKey: event.idempotencyKey,
        provider: 'heygen',
        eventType: event.eventType,
        payload: event.payload,
        verification,
      });

      if (recorded.duplicate) {
        return res.status(200).json({
          received: true,
          duplicate: true,
          requestId: req.requestId,
        });
      }

      const result = await jobStateService.applyHeyGenWebhook(event, {
        actorUid: 'heygen:webhook',
      });
      return res.status(202).json({
        received: true,
        duplicate: false,
        action: result.action,
        requestId: req.requestId,
        verificationMode: verification.mode,
      });
    }),
  );

  return router;
}

export function createSocialWebhookRouter({ repository }) {
  const router = Router();

  router.post(
    '/:platform',
    asyncHandler(async (req, res) => {
      const platform = req.params.platform;
      if (!SOCIAL_PLATFORMS.includes(platform)) {
        throw badRequest('Unsupported social webhook platform', { platform, supported: SOCIAL_PLATFORMS });
      }

      const eventType = req.get('x-event-type') ?? req.body?.eventType ?? req.body?.type ?? 'unknown';
      const idempotencyKey = [
        'social',
        platform,
        eventType,
        req.get('x-webhook-id') ?? req.body?.id ?? JSON.stringify(req.body ?? {}),
      ].join(':');

      const recorded = await repository.recordWebhookEvent({
        idempotencyKey,
        provider: platform,
        eventType,
        payload: req.body ?? {},
        verification: {
          ok: true,
          mode: 'placeholder',
          TODO: 'Verify each social platform webhook signature before accepting production traffic.',
        },
      });

      res.status(recorded.duplicate ? 200 : 202).json({
        received: true,
        duplicate: recorded.duplicate,
        requestId: req.requestId,
      });
    }),
  );

  return router;
}
