import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_TOLERANCE_SEC = 300;

export function verifyRenderSignature({ body, headers, secret }) {
  if (!secret) {
    throw Object.assign(new Error('MEDIA_RENDER_HMAC_SECRET is not configured'), { statusCode: 500 });
  }
  const timestamp = headers['x-newleaf-timestamp'];
  const signature = headers['x-newleaf-signature'];
  if (!timestamp || !signature) {
    throw Object.assign(new Error('Missing render signature headers'), { statusCode: 401 });
  }
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) {
    throw Object.assign(new Error('Invalid render signature timestamp'), { statusCode: 401 });
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - numericTimestamp) > SIGNATURE_TOLERANCE_SEC) {
    throw Object.assign(new Error('Render signature timestamp is outside tolerance'), { statusCode: 401 });
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  if (!safeEqual(signature, expected)) {
    throw Object.assign(new Error('Invalid render signature'), { statusCode: 401 });
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), 'hex');
  const rightBuffer = Buffer.from(String(right), 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
