import assert from 'node:assert/strict';
import { createHeyGenService } from './heygenService.js';

const capturedRequests = [];
const service = createHeyGenService({
  config: {
    apiKey: 'test-key',
    apiBaseUrl: 'https://api.heygen.com',
    callbackUrl: 'https://api.example.com/api/v1/webhooks/heygen',
    webhookSecret: null,
    signatureHeader: 'signature',
  },
  fetchImpl: async (url, options = {}) => {
    capturedRequests.push({
      url: String(url),
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : null,
    });

    if (String(url).includes('/v1/video_agent/generate')) {
      return jsonResponse({
        data: {
          video_id: 'heygen_video_123',
          api_key: 'should-not-leak',
        },
      });
    }

    if (String(url).includes('/v1/video_status.get')) {
      return jsonResponse({
        data: {
          status: 'completed',
          video_id: 'heygen_video_123',
          video_url: 'https://cdn.example.com/video.mp4',
          access_token: 'should-not-leak',
        },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  },
});

const requestResult = await service.requestVideoAgent({
  prompt: 'Create a concise market update.',
  callbackId: 'job-123:project-123:10:intro',
  callbackUrl: 'https://api.example.com/api/v1/webhooks/heygen',
  config: null,
  files: [],
});

assert.equal(requestResult.externalId, 'heygen_video_123');
assert.equal(requestResult.providerResponse.data.api_key, '[redacted]');
assert.equal(capturedRequests[0].url, 'https://api.heygen.com/v1/video_agent/generate');
assert.equal(capturedRequests[0].method, 'POST');
assert.equal(capturedRequests[0].headers['x-api-key'], 'test-key');
assert.deepEqual(capturedRequests[0].body, {
  prompt: 'Create a concise market update.',
  callback_id: 'job-123:project-123:10:intro',
  callback_url: 'https://api.example.com/api/v1/webhooks/heygen',
});

const pollResult = await service.pollProviderJob({
  id: 'providerJob_123',
  externalId: 'heygen_video_123',
  status: 'processing',
});

assert.equal(pollResult.terminalStatus, 'success');
assert.equal(pollResult.videoUrl, 'https://cdn.example.com/video.mp4');
assert.equal(pollResult.providerResponse.data.access_token, '[redacted]');

const event = service.parseWebhookEvent(
  Buffer.from(
    JSON.stringify({
      data: {
        status: 'completed',
        video_id: 'heygen_video_123',
        callback_id: 'job-123:project-123:10:intro',
        video_url: 'https://cdn.example.com/video.mp4',
      },
    }),
  ),
);

assert.equal(event.eventType, 'video.completed');
assert.equal(event.terminalStatus, 'success');
assert.equal(event.videoId, 'heygen_video_123');
assert.equal(event.callbackId, 'job-123:project-123:10:intro');
assert.equal(event.videoUrl, 'https://cdn.example.com/video.mp4');

console.log('HeyGen service mapping tests passed.');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}
