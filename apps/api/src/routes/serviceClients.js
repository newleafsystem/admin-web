import crypto from 'node:crypto';
import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { notFound } from '../lib/httpErrors.js';
import {
  optionalNumber,
  optionalString,
  rejectUnknownFields,
  requireObject,
  requireString,
} from '../lib/validation.js';

const DEFAULT_SCOPES = Object.freeze(['text_to_heygen']);

export function createServiceClientsRouter({ repository }) {
  const router = Router();

  router.get(
    '/service-clients',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const clients = await repository.listServiceClients();
      res.json({ clients: clients.map(sanitizeClient) });
    }),
  );

  router.post(
    '/service-clients',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['name', 'contactEmail', 'rateLimitPerMinute']);
      const secret = generateSecret();
      const keyId = `svc_${crypto.randomBytes(12).toString('hex')}`;
      const secretRecord = await repository.putSecret({
        provider: 'newleaf',
        kind: 'service_api_signing_secret',
        value: secret,
        metadata: {
          keyId,
          createdBy: req.user.uid,
        },
      });
      const client = await repository.createServiceClient({
        name: requireString(body, 'name', { maxLength: 120 }),
        contactEmail: optionalString(body, 'contactEmail', { maxLength: 200, defaultValue: null }),
        keyId,
        secretRef: secretRecord.secretRef,
        scopes: DEFAULT_SCOPES,
        rateLimitPerMinute: optionalNumber(body, 'rateLimitPerMinute', { min: 1, max: 600, defaultValue: 60 }),
        requireSignedRequests: true,
        createdBy: req.user.uid,
      });

      res.status(201).json({
        client: sanitizeClient(client),
        credentials: {
          keyId,
          signingSecret: secret,
          warning: 'Store this signing secret now. NewLeaf stores it as a secret reference and will not display it again.',
        },
      });
    }),
  );

  router.post(
    '/service-clients/:clientId/rotate',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const client = await repository.getServiceClient(req.params.clientId);
      if (!client) {
        throw notFound('Service client not found', { clientId: req.params.clientId });
      }

      const secret = generateSecret();
      const secretRecord = await repository.putSecret({
        provider: 'newleaf',
        kind: 'service_api_signing_secret',
        value: secret,
        metadata: {
          clientId: client.id,
          keyId: client.keyId,
          rotatedBy: req.user.uid,
        },
      });
      const updated = await repository.updateServiceClient(client.id, {
        secretRef: secretRecord.secretRef,
        status: 'active',
        revokedAt: null,
        rotatedAt: new Date().toISOString(),
      });

      res.json({
        client: sanitizeClient(updated),
        credentials: {
          keyId: updated.keyId,
          signingSecret: secret,
          warning: 'Store this signing secret now. The previous signing secret is no longer valid.',
        },
      });
    }),
  );

  router.post(
    '/service-clients/:clientId/revoke',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const client = await repository.getServiceClient(req.params.clientId);
      if (!client) {
        throw notFound('Service client not found', { clientId: req.params.clientId });
      }
      const updated = await repository.updateServiceClient(client.id, {
        status: 'revoked',
        revokedAt: new Date().toISOString(),
      });
      res.json({ client: sanitizeClient(updated) });
    }),
  );

  return router;
}

function sanitizeClient(client) {
  return {
    id: client.id,
    name: client.name,
    contactEmail: client.contactEmail,
    status: client.status,
    keyId: client.keyId,
    scopes: client.scopes ?? [],
    rateLimitPerMinute: client.rateLimitPerMinute,
    requireSignedRequests: client.requireSignedRequests !== false,
    createdBy: client.createdBy,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    rotatedAt: client.rotatedAt,
    revokedAt: client.revokedAt,
  };
}

function generateSecret() {
  return `nlsec_${crypto.randomBytes(32).toString('base64url')}`;
}
