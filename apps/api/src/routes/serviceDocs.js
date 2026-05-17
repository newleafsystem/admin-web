import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { Router } from 'express';
import { authenticateUserOrService, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const openApiPath = path.resolve(currentDir, '../../../../docs/service-api-openapi.yaml');

export function createServiceDocsRouter({ repository, userAccessService } = {}) {
  const router = Router();
  const docsAuth = [authenticateUserOrService({ repository, userAccessService }), requireRole('service')];

  router.get(
    '/openapi.yaml',
    docsAuth,
    asyncHandler(async (req, res) => {
      const spec = await fsp.readFile(openApiPath, 'utf8');
      res
        .type('application/yaml')
        .set('X-Content-Type-Options', 'nosniff')
        .send(spec);
    }),
  );

  router.get(
    '/docs',
    docsAuth,
    asyncHandler(async (req, res) => {
      const spec = await fsp.readFile(openApiPath, 'utf8');
      res
        .type('html')
        .set('X-Content-Type-Options', 'nosniff')
        .send(renderSwaggerUiPage(spec));
    }),
  );

  return router;
}

function renderSwaggerUiPage(spec) {
  const specDataUrl = `data:application/yaml;base64,${Buffer.from(spec, 'utf8').toString('base64')}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NewLeaf Service API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body {
        margin: 0;
        background: #f5f6f1;
      }

      .docs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 24px;
        border-bottom: 1px solid #d8dee4;
        background: #ffffff;
        color: #1f2933;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .docs-header h1 {
        margin: 0;
        font-size: 1.25rem;
      }

      .docs-header p {
        margin: 4px 0 0;
        color: #667085;
        font-size: 0.88rem;
      }

      .docs-header a {
        min-height: 36px;
        border: 1px solid rgba(215, 181, 109, 0.55);
        border-radius: 10px;
        padding: 8px 12px;
        color: #0b2d23;
        text-decoration: none;
        white-space: nowrap;
      }

      .docs-note {
        max-width: 1280px;
        margin: 16px auto 0;
        border: 1px solid #d7ded7;
        border-left: 4px solid #b8862d;
        border-radius: 8px;
        padding: 14px 16px;
        background: linear-gradient(180deg, #ffffff 0%, #fbfaf6 100%);
        color: #1f2933;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.5;
      }

      .docs-note strong {
        display: block;
        margin-bottom: 4px;
      }

      .docs-note code {
        border: 1px solid #d8dee4;
        border-radius: 4px;
        padding: 1px 4px;
        background: #f5f6f1;
      }

      #swagger-ui {
        max-width: 1280px;
        margin: 0 auto;
      }
    </style>
  </head>
  <body>
    <header class="docs-header">
      <div>
        <h1>NewLeaf Service API</h1>
        <p>Signed vendor API for text-to-HeyGen job submission, status checks, retries, and artifacts.</p>
      </div>
      <a href="/api/v1/service/openapi.yaml">OpenAPI YAML</a>
    </header>
    <section class="docs-note">
      <strong>Service API documentation is protected.</strong>
      Use either an approved NewLeaf admin session cookie or backend vendor credentials. Operational service calls require
      <code>x-newleaf-key-id</code>, <code>x-newleaf-timestamp</code>, and <code>x-newleaf-signature</code>.
      Browser requests without a NewLeaf admin cookie, Firebase token, or vendor credentials are rejected.
    </section>
    <main id="swagger-ui"></main>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '${specDataUrl}',
        dom_id: '#swagger-ui',
        deepLinking: true,
        layout: 'BaseLayout',
        displayRequestDuration: true,
        supportedSubmitMethods: []
      });
    </script>
  </body>
</html>`;
}
