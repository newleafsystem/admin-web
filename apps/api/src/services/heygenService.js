import crypto from 'node:crypto';
import { config, isProduction } from '../config.js';
import { badRequest, conflict, unauthorized } from '../lib/httpErrors.js';

export function createHeyGenService(options = {}) {
  const serviceConfig = options.config ?? config.heygen;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    buildVideoRequest({ job, script, callbackId }) {
      return {
        provider: 'heygen',
        callbackId,
        title: job.title,
        script,
        // TODO: Replace placeholders with HeyGen v3 avatar, voice, scene, and callback payload fields.
        // TODO: Store request payload snapshots as immutable artifacts before calling the provider.
      };
    },

    buildVideoAgentRequest({ job, segment, callbackId }) {
      return {
        provider: 'heygen',
        endpoint: 'video_agent',
        callbackId,
        title: segment.title ?? job.title,
        prompt: segment.prompt,
        config: segment.config ?? job.metadata?.heygenConfig ?? null,
        files: segment.files ?? [],
        callbackUrl: serviceConfig.callbackUrl,
      };
    },

    async requestVideoAgent(requestPayload) {
      if (!serviceConfig.apiKey) {
        return {
          provider: 'heygen',
          externalId: `dev_${requestPayload.callbackId.replace(/[^\w.-]+/g, '_')}`,
          status: 'processing',
          mode: 'stub',
          providerResponse: {
            skipped: true,
            reason: 'HEYGEN_API_KEY is not configured. Use the dev completion endpoint or HeyGen webhook payload to complete this segment.',
          },
        };
      }

      const response = await fetchImpl(`${serviceConfig.apiBaseUrl}/v1/video_agent/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': serviceConfig.apiKey,
        },
        body: JSON.stringify(compactObject({
          prompt: requestPayload.prompt,
          config: isPlainObject(requestPayload.config) ? requestPayload.config : undefined,
          files: requestPayload.files?.length ? requestPayload.files : undefined,
          callback_id: requestPayload.callbackId,
          callback_url: requestPayload.callbackUrl,
        })),
      });
      const body = await readProviderJson(response);
      if (!response.ok) {
        throw conflict('Unable to request HeyGen video segment', {
          status: response.status,
          provider: providerErrorSummary(body),
        });
      }

      const externalId = extractVideoId(body);
      if (!externalId) {
        throw conflict('HeyGen video segment response did not include a video id', {
          provider: providerErrorSummary(body),
        });
      }

      return {
        provider: 'heygen',
        externalId,
        status: 'processing',
        mode: 'video_agent',
        providerResponse: sanitizeProviderResponse(body),
      };
    },

    verifyWebhookSignature({ rawBody, headers }) {
      const secret = serviceConfig.webhookSecret;
      if (!secret) {
        if (isProduction()) {
          throw unauthorized('HeyGen webhook secret is not configured');
        }
        return {
          ok: true,
          mode: 'skipped-dev',
          warning: 'HEYGEN_WEBHOOK_SECRET is not configured; signature verification is skipped outside production.',
        };
      }

      const headerName = serviceConfig.signatureHeader.toLowerCase();
      const provided = normalizeSignature(headers[headerName]);
      if (!provided) {
        throw unauthorized('Missing HeyGen webhook signature');
      }

      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      if (!safeEqualHex(provided, expected)) {
        throw unauthorized('Invalid HeyGen webhook signature');
      }

      return {
        ok: true,
        mode: 'hmac-sha256',
      };
    },

    parseWebhookEvent(rawBody) {
      let payload;
      try {
        const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw badRequest('HeyGen webhook body must be valid JSON');
      }

      const data = payload.event_data ?? payload.eventData ?? payload.data ?? payload;
      const eventType =
        payload.event_type ??
        payload.eventType ??
        payload.event ??
        payload.type ??
        (data.status ? `video.${data.status}` : null);
      if (!eventType) {
        throw badRequest('HeyGen webhook event type or status is required');
      }

      const videoId = data.video_id ?? data.videoId ?? data.id ?? payload.video_id ?? null;
      const callbackId = data.callback_id ?? data.callbackId ?? payload.callback_id ?? payload.callbackId ?? null;
      const terminalStatus = inferTerminalStatus(eventType, data.status);
      const idempotencyKey = [
        'heygen',
        eventType,
        videoId ?? 'no-video-id',
        callbackId ?? payload.id ?? crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      ].join(':');

      return {
        provider: 'heygen',
        eventType,
        videoId,
        callbackId,
        terminalStatus,
        videoUrl: extractVideoUrl(data) ?? extractVideoUrl(payload),
        errorCode: data.error_code ?? data.errorCode ?? null,
        errorMessage: data.error_message ?? data.errorMessage ?? data.message ?? data.msg ?? null,
        idempotencyKey,
        payload,
      };
    },

    async pollProviderJob(providerJob) {
      if (!serviceConfig.apiKey) {
        return {
          provider: 'heygen',
          providerJobId: providerJob.id,
          status: providerJob.status,
          skipped: true,
          nextPollAfterSec: 300,
          TODO: 'Configure HEYGEN_API_KEY and call HeyGen status endpoints with exponential backoff.',
        };
      }

      const externalId = providerJob.externalId;
      if (!externalId) {
        throw badRequest('Provider job is missing HeyGen video id', { providerJobId: providerJob.id });
      }

      const url = new URL(`${serviceConfig.apiBaseUrl}/v1/video_status.get`);
      url.searchParams.set('video_id', externalId);
      const response = await fetchImpl(url, {
        headers: {
          'x-api-key': serviceConfig.apiKey,
        },
      });
      const body = await readProviderJson(response);
      if (!response.ok) {
        throw conflict('Unable to poll HeyGen video status', {
          status: response.status,
          provider: providerErrorSummary(body),
        });
      }

      const data = body.data ?? body;
      const status = String(data.status ?? body.status ?? providerJob.status ?? '').toLowerCase();
      const terminalStatus = status === 'completed' ? 'success' : status === 'failed' ? 'failed' : status;

      return {
        provider: 'heygen',
        providerJobId: providerJob.id,
        status,
        terminalStatus,
        videoId: externalId,
        videoUrl: extractVideoUrl(data) ?? extractVideoUrl(body),
        errorCode: data.error_code ?? data.errorCode ?? null,
        errorMessage: data.error_message ?? data.errorMessage ?? data.message ?? null,
        nextPollAfterSec: 120,
        providerResponse: sanitizeProviderResponse(body),
      };
    },
  };
}

async function readProviderJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function extractVideoId(body = {}) {
  return (
    body.video_id ??
    body.videoId ??
    body.id ??
    body.data?.video_id ??
    body.data?.videoId ??
    body.data?.id ??
    body.result?.video_id ??
    body.result?.videoId ??
    null
  );
}

function extractVideoUrl(body = {}) {
  return (
    body.video_url ??
    body.videoUrl ??
    body.url ??
    body.data?.video_url ??
    body.data?.videoUrl ??
    body.data?.url ??
    body.result?.video_url ??
    body.result?.videoUrl ??
    body.result?.url ??
    null
  );
}

function sanitizeProviderResponse(body = {}) {
  return redactSecrets(structuredClone(body));
}

function providerErrorSummary(body = {}) {
  return {
    code: body.code ?? body.error_code ?? body.errorCode ?? body.error?.code ?? body.data?.error_code ?? null,
    message:
      body.message ??
      body.error_message ??
      body.errorMessage ??
      body.error?.message ??
      body.data?.error ??
      body.data?.message ??
      null,
  };
}

function compactObject(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const redacted = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (/api[_-]?key|token|secret|authorization/i.test(key)) {
      redacted[key] = '[redacted]';
    } else {
      redacted[key] = redactSecrets(nestedValue);
    }
  }
  return redacted;
}

function normalizeSignature(value) {
  if (Array.isArray(value)) {
    return normalizeSignature(value[0]);
  }
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim().replace(/^sha256=/i, '');
}

function safeEqualHex(left, right) {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function inferTerminalStatus(eventType, status) {
  const normalizedEvent = String(eventType).toLowerCase();
  const normalizedStatus = String(status ?? '').toLowerCase();
  if (normalizedEvent.includes('success') || normalizedStatus === 'completed' || normalizedStatus === 'success') {
    return 'success';
  }
  if (normalizedEvent.includes('fail') || normalizedStatus === 'failed' || normalizedStatus === 'error') {
    return 'failed';
  }
  return normalizedStatus || null;
}
