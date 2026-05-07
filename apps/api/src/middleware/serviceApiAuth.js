import crypto from 'node:crypto';
import { config } from '../config.js';
import { forbidden, tooManyRequests, unauthorized } from '../lib/httpErrors.js';

const WINDOW_MS = 60_000;
const rateLimitBuckets = new Map();

export function authenticateServiceApiKey(options = {}) {
  const repository = options.repository ?? null;
  const keyHashes = normalizeConfiguredHashes(options.keyHashes ?? config.serviceApi.keyHashes);
  const fallbackRateLimitPerMinute = Number(options.rateLimitPerMinute ?? config.serviceApi.rateLimitPerMinute);
  const signatureToleranceSec = Number(options.signatureToleranceSec ?? config.serviceApi.signatureToleranceSec);

  return async (req, res, next) => {
    try {
      const signedClient = await authenticateSignedClient({ req, repository, signatureToleranceSec });
      if (signedClient) {
        enforceRateLimit(`client:${signedClient.id}`, signedClient.rateLimitPerMinute ?? fallbackRateLimitPerMinute);
        req.serviceClient = {
          id: signedClient.id,
          name: signedClient.name,
          keyId: signedClient.keyId,
          keyFingerprint: signedClient.id,
          scopes: signedClient.scopes ?? [],
          authMode: 'signed-service-client',
        };
        req.user = {
          uid: `service:${signedClient.id}`,
          email: null,
          roles: ['service'],
          authMode: 'signed-service-client',
        };
        return next();
      }

      const apiKey = readApiKey(req);
      if (!apiKey) {
        throw unauthorized('Missing service API credentials', {
          headers: ['x-newleaf-key-id + x-newleaf-signature', 'x-newleaf-api-key'],
        });
      }
      if (keyHashes.length === 0) {
        throw unauthorized('Service API key hashes are not configured', {
          requiredEnv: ['SERVICE_API_KEY_HASHES'],
        });
      }

      const keyHash = hashValue(apiKey);
      const matchedHash = keyHashes.find((candidate) => safeEqualHash(candidate, keyHash));
      if (!matchedHash) {
        throw unauthorized('Invalid service API key');
      }

      enforceRateLimit(`env:${keyHash}`, fallbackRateLimitPerMinute);
      req.serviceClient = {
        id: null,
        keyId: null,
        keyFingerprint: keyHash.slice(0, 12),
        scopes: ['text_to_heygen'],
        authMode: 'env-api-key',
      };
      req.user = {
        uid: `service:${keyHash.slice(0, 12)}`,
        email: null,
        roles: ['service'],
        authMode: 'env-api-key',
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

async function authenticateSignedClient({ req, repository, signatureToleranceSec }) {
  const keyId = req.get('x-newleaf-key-id')?.trim();
  if (!keyId) {
    return null;
  }
  if (!repository?.findServiceClientByKeyId || !repository?.getSecret) {
    throw unauthorized('Managed service clients are not supported by this repository');
  }

  const client = await repository.findServiceClientByKeyId(keyId);
  if (!client) {
    throw unauthorized('Unknown service client key id');
  }
  if (client.status !== 'active') {
    throw forbidden('Service client is not active', {
      keyId,
      status: client.status,
    });
  }
  if (client.requireSignedRequests === false) {
    return client;
  }

  const timestamp = req.get('x-newleaf-timestamp')?.trim();
  const signature = normalizeSignature(req.get('x-newleaf-signature'));
  if (!timestamp || !signature) {
    throw unauthorized('Signed service requests require timestamp and signature headers', {
      headers: ['x-newleaf-timestamp', 'x-newleaf-signature'],
    });
  }

  assertTimestampFresh(timestamp, signatureToleranceSec);

  const secret = await repository.getSecret(client.secretRef);
  if (!secret?.value) {
    throw unauthorized('Service client signing secret is not available');
  }

  const expected = signRequest({
    method: req.method,
    originalUrl: req.originalUrl,
    timestamp,
    rawBody: req.rawBody,
    secret: secret.value,
  });
  if (!safeEqualHash(signature, expected)) {
    throw unauthorized('Invalid service request signature');
  }

  return client;
}

function readApiKey(req) {
  const direct = req.get('x-newleaf-api-key') ?? req.get('x-api-key');
  if (direct) {
    return direct.trim();
  }

  return readBearerToken(req.get('authorization'));
}

function readBearerToken(authorization) {
  const header = String(authorization ?? '').trim();
  if (header.length <= 'Bearer '.length || header.slice(0, 6).toLowerCase() !== 'bearer') {
    return null;
  }

  const separator = header[6];
  if (separator !== ' ' && separator !== '\t') {
    return null;
  }

  const token = header.slice(7).trim();
  return token || null;
}

export function buildServiceSignaturePayload({ method, originalUrl, timestamp, rawBody }) {
  return [
    String(method ?? '').toUpperCase(),
    String(originalUrl ?? ''),
    String(timestamp ?? ''),
    hashBuffer(rawBody ?? Buffer.alloc(0)),
  ].join('\n');
}

export function signServiceRequest({ method, originalUrl, timestamp, rawBody, secret }) {
  return signRequest({ method, originalUrl, timestamp, rawBody, secret });
}

function signRequest({ method, originalUrl, timestamp, rawBody, secret }) {
  return crypto
    .createHmac('sha256', secret)
    .update(buildServiceSignaturePayload({ method, originalUrl, timestamp, rawBody }))
    .digest('hex');
}

function assertTimestampFresh(timestamp, toleranceSec) {
  const numeric = Number(timestamp);
  const timestampMs = Number.isFinite(numeric)
    ? numeric > 10_000_000_000
      ? numeric
      : numeric * 1000
    : Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw unauthorized('Invalid service request timestamp');
  }

  const toleranceMs = Math.max(0, Number(toleranceSec) || 0) * 1000;
  if (Math.abs(Date.now() - timestampMs) > toleranceMs) {
    throw unauthorized('Service request timestamp is outside the accepted window', {
      toleranceSec,
    });
  }
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashBuffer(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeConfiguredHashes(values) {
  return (values ?? [])
    .map((value) => String(value).trim().replace(/^sha256:/i, '').toLowerCase())
    .filter((value) => /^[0-9a-f]{64}$/.test(value));
}

function normalizeSignature(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().replace(/^sha256=/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function safeEqualHash(left, right) {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function enforceRateLimit(bucketKey, limit) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return;
  }

  const now = Date.now();
  const bucket = rateLimitBuckets.get(bucketKey);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    rateLimitBuckets.set(bucketKey, {
      windowStart: now,
      count: 1,
    });
    return;
  }

  if (bucket.count >= limit) {
    throw tooManyRequests('Service API rate limit exceeded', {
      limit,
      windowSec: WINDOW_MS / 1000,
    });
  }

  bucket.count += 1;
}
