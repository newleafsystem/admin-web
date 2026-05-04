import http from 'node:http';
import { verifyRenderSignature } from './auth.js';
import { createStorageClientFromEnv } from './storage.js';
import { renderTimelineJob } from './render.js';

const PORT = Number(process.env.PORT ?? 8080);
const MAX_BODY_BYTES = Number(process.env.MAX_RENDER_REQUEST_BYTES ?? 1_048_576);

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, {
        ok: true,
        service: 'newleaf-media-renderer',
        ffmpeg: 'available-in-container',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/render') {
      const rawBody = await readRequestBody(request);
      verifyRenderSignature({
        body: rawBody,
        headers: request.headers,
        secret: process.env.MEDIA_RENDER_HMAC_SECRET,
      });

      const payload = JSON.parse(rawBody);
      const storage = createStorageClientFromEnv();
      const result = await renderTimelineJob({ payload, storage });
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: {
        message: 'Route not found',
      },
    });
  } catch (error) {
    const status = Number(error.statusCode ?? 500);
    sendJson(response, status, {
      ok: false,
      error: {
        message: error.message,
      },
    });
  }
});

server.listen(PORT, () => {
  console.log(`NewLeaf media renderer listening on ${PORT}`);
});

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Render request body is too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}
