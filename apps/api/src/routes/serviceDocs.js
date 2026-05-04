import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const openApiPath = path.resolve(currentDir, '../../../../docs/service-api-openapi.yaml');

export function createServiceDocsRouter() {
  const router = Router();

  router.get(
    '/openapi.yaml',
    asyncHandler(async (req, res) => {
      const spec = await fsp.readFile(openApiPath, 'utf8');
      res
        .type('application/yaml')
        .set('X-Content-Type-Options', 'nosniff')
        .send(spec);
    }),
  );

  router.get('/docs', (req, res) => {
    res
      .type('html')
      .set('X-Content-Type-Options', 'nosniff')
      .send(renderSwaggerUiPage());
  });

  return router;
}

function renderSwaggerUiPage() {
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
        border: 1px solid #d8dee4;
        border-radius: 6px;
        padding: 8px 12px;
        color: #164a82;
        text-decoration: none;
        white-space: nowrap;
      }

      .docs-note {
        max-width: 1280px;
        margin: 16px auto 0;
        border: 1px solid #d8dee4;
        border-left: 4px solid #2364aa;
        border-radius: 8px;
        padding: 14px 16px;
        background: #ffffff;
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
      <strong>Protected calls require signed vendor credentials.</strong>
      The docs page and OpenAPI YAML are public, but service operations must be called from a backend with
      <code>x-newleaf-key-id</code>, <code>x-newleaf-timestamp</code>, and <code>x-newleaf-signature</code>.
      A browser request without those headers returns "Missing service API credentials".
    </section>
    <main id="swagger-ui"></main>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/api/v1/service/openapi.yaml',
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
