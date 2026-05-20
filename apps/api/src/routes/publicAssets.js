import { Readable } from 'node:stream';
import { Router } from 'express';
import { config } from '../config.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badGateway, badRequest, conflict, notFound } from '../lib/httpErrors.js';
import {
  isObjectStorageProvider,
  tryStreamObjectStorageKey,
} from '../lib/assetStorage.js';

const RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
];

export function createPublicAssetsRouter({
  recommendationBatchService = null,
  repository = null,
} = {}) {
  const router = Router();

  router.get('/data/reports/latest', proxyLatestReportsBatch);
  router.post('/data/reports/latest', proxyLatestReportsBatch);
  router.get('/data/*', proxyPublicAsset(() => config.publicAssets.dataOriginUrl, 'data', {
    recommendationBatchService,
    repository,
  }));
  router.head('/data/*', proxyPublicAsset(() => config.publicAssets.dataOriginUrl, 'data', {
    recommendationBatchService,
    repository,
  }));
  router.get('/media/*', proxyPublicAsset(() => config.publicAssets.mediaOriginUrl, 'media'));
  router.head('/media/*', proxyPublicAsset(() => config.publicAssets.mediaOriginUrl, 'media'));

  return router;
}

const MAX_BATCH_SYMBOLS = 250;
const BATCH_CONCURRENCY = 16;

const proxyLatestReportsBatch = asyncHandler(async (req, res) => {
  const origin = normalizeOrigin(config.publicAssets.dataOriginUrl, 'data');
  const symbols = readBatchSymbols(req);
  const fetchedAt = new Date().toISOString();
  const reports = {};
  const errors = {};

  await mapWithConcurrency(symbols, BATCH_CONCURRENCY, async (symbol) => {
    const upstreamUrl = buildUpstreamUrl(origin, `reports/${symbol}/latest.json`, {});
    let upstream;
    try {
      upstream = await fetch(upstreamUrl);
    } catch (error) {
      errors[symbol] = {
        status: 502,
        message: 'Unable to fetch symbol report',
        reason: error.name ?? 'fetch_failed',
      };
      return;
    }

    if (upstream.status === 404) {
      errors[symbol] = {
        status: 404,
        message: 'Symbol report not found',
      };
      return;
    }

    if (!upstream.ok) {
      errors[symbol] = {
        status: upstream.status,
        message: 'Symbol report upstream returned an error',
      };
      return;
    }

    try {
      reports[symbol] = await upstream.json();
    } catch {
      errors[symbol] = {
        status: 502,
        message: 'Symbol report is not valid JSON',
      };
    }
  });

  if (Object.keys(reports).length === 0) {
    throw badGateway('Unable to fetch any symbol reports', {
      symbols,
      failures: Object.fromEntries(
        Object.entries(errors).map(([symbol, error]) => [symbol, { status: error.status }]),
      ),
    });
  }

  res.set('cache-control', `public, max-age=${config.publicAssets.cacheMaxAgeSec}`);
  res.set('x-content-type-options', 'nosniff');
  res.json({
    fetchedAt,
    symbols,
    count: Object.keys(reports).length,
    reports,
    errors,
  });
});

function proxyPublicAsset(originResolver, label, services = {}) {
  return asyncHandler(async (req, res) => {
    const origin = normalizeOrigin(originResolver(), label);
    const assetPath = readAssetPath(req);
    const upstreamUrl = buildUpstreamUrl(origin, assetPath, req.query);
    const headers = {};
    const range = req.get('range');
    if (range) headers.range = range;

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
      });
    } catch (error) {
      throw badGateway('Unable to fetch public asset', {
        assetType: label,
        assetPath,
        reason: error.name ?? 'fetch_failed',
      });
    }

    if (upstream.status === 404) {
      if (label === 'data') {
        const servedFromObjectStorage = await tryStreamObjectStorageKey({
          storageKey: assetPath,
          range,
          response: res,
          fallbackContentType: contentTypeForPublicDataPath(assetPath),
          headOnly: req.method === 'HEAD',
        });
        if (servedFromObjectStorage) {
          return;
        }
        const servedFromPublishedArtifact = await tryStreamPublishedRecommendationPdf({
          assetPath,
          range,
          response: res,
          headOnly: req.method === 'HEAD',
          recommendationBatchService: services.recommendationBatchService,
          repository: services.repository,
        });
        if (servedFromPublishedArtifact) {
          return;
        }
      }
      throw notFound('Public asset not found', { assetType: label, assetPath });
    }

    if (!upstream.ok && upstream.status !== 206) {
      throw badGateway('Public asset upstream returned an error', {
        assetType: label,
        assetPath,
        status: upstream.status,
      });
    }

    res.status(upstream.status);
    for (const header of RESPONSE_HEADERS) {
      const value = upstream.headers.get(header);
      if (value) res.set(header, value);
    }
    if (!upstream.headers.get('cache-control')) {
      res.set('cache-control', `public, max-age=${config.publicAssets.cacheMaxAgeSec}`);
    }
    res.set('x-content-type-options', 'nosniff');

    if (req.method === 'HEAD' || !upstream.body) {
      return res.end();
    }

    return Readable.fromWeb(upstream.body).pipe(res);
  });
}

async function tryStreamPublishedRecommendationPdf({
  assetPath,
  range,
  response,
  headOnly,
  recommendationBatchService,
  repository,
}) {
  if (!recommendationBatchService?.getLatestPublishedBatch || !repository?.getArtifact) {
    return false;
  }
  const request = parseRecommendationPdfAssetPath(assetPath);
  if (!request) {
    return false;
  }
  const batch = await recommendationBatchService.getLatestPublishedBatch();
  if (!batch?.publicData) {
    return false;
  }
  const recommendations = Array.isArray(batch.publicData.recommendations)
    ? batch.publicData.recommendations
    : [];
  const recommendation = recommendations.find((item) =>
    recommendationPdfFilename(item) === request.filename
    && String(item.symbol ?? '').trim().toUpperCase() === request.symbol,
  );
  if (!recommendation?.id) {
    return false;
  }

  const outputArtifacts = findPickOutputArtifacts(batch, recommendation.id, recommendations.length);
  const artifactId = outputArtifacts?.pdf?.artifactId ?? outputArtifacts?.pdf?.id;
  if (!artifactId) {
    return false;
  }
  const artifact = await repository.getArtifact(artifactId);
  if (!artifact || !isObjectStorageProvider(artifact.storageProvider)) {
    return false;
  }
  return tryStreamObjectStorageKey({
    storageKey: artifact.storageKey,
    range,
    response,
    fallbackContentType: artifact.mimeType ?? 'application/pdf',
    headOnly,
    cacheControl: `public, max-age=${config.publicAssets.cacheMaxAgeSec}`,
    contentDisposition: `attachment; filename="${request.filename}"`,
  });
}

function parseRecommendationPdfAssetPath(assetPath) {
  const match = /^reports\/pdf\/([^/]+)\/([^/]+-latest\.pdf)$/i.exec(String(assetPath ?? ''));
  if (!match) return null;
  const symbol = String(match[1] ?? '').trim().toUpperCase();
  const filename = String(match[2] ?? '').trim();
  if (!/^[A-Z0-9^][A-Z0-9.\-^=]{0,23}$/.test(symbol) || !filename) {
    return null;
  }
  return { symbol, filename };
}

function recommendationPdfFilename(recommendation) {
  const symbol = String(recommendation?.symbol ?? '').trim().toUpperCase();
  if (!symbol) return '';
  const strategySlug = String(recommendation?.strategy ?? 'Recommendation')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'Recommendation';
  return `${symbol}-${strategySlug}-latest.pdf`;
}

function findPickOutputArtifacts(batch, recommendationId, recommendationCount) {
  const pickOutputArtifacts = batch?.pickOutputArtifacts;
  if (pickOutputArtifacts && typeof pickOutputArtifacts === 'object' && !Array.isArray(pickOutputArtifacts)) {
    const direct = pickOutputArtifacts[recommendationId];
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return direct;
    }
  }
  if (recommendationCount === 1 && batch?.outputArtifacts && typeof batch.outputArtifacts === 'object') {
    return batch.outputArtifacts;
  }
  return null;
}

function contentTypeForPublicDataPath(assetPath) {
  const lower = String(assetPath ?? '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function normalizeOrigin(value, label) {
  const origin = String(value ?? '').trim().replace(/\/+$/, '');
  if (!origin) {
    throw conflict('Public asset origin is not configured', {
      assetType: label,
    });
  }
  if (!/^https:\/\//i.test(origin) && !isLocalHttpOrigin(origin)) {
    throw conflict('Public asset origin must use HTTPS', {
      assetType: label,
    });
  }
  return origin;
}

function isLocalHttpOrigin(origin) {
  if (process.env.NODE_ENV === 'production') return false;
  return /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin);
}

function readAssetPath(req) {
  const rawPath = req.params[0] ?? '';
  const path = String(rawPath).replace(/^\/+/, '');
  if (
    !path ||
    path.length > 1024 ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '..' || part === '')
  ) {
    throw badRequest('Invalid public asset path');
  }
  return path;
}

function readBatchSymbols(req) {
  const rawSymbols =
    req.method === 'POST' && req.body && Object.prototype.hasOwnProperty.call(req.body, 'symbols')
      ? req.body.symbols
      : req.query.symbols;
  const values = Array.isArray(rawSymbols)
    ? rawSymbols.flatMap((value) => String(value).split(','))
    : String(rawSymbols ?? '').split(',');
  const symbols = Array.from(
    new Set(
      values
        .map((value) => String(value).trim().toUpperCase())
        .filter(Boolean),
    ),
  );

  if (!symbols.length) {
    throw badRequest('At least one symbol is required', { field: 'symbols' });
  }
  if (symbols.length > MAX_BATCH_SYMBOLS) {
    throw badRequest('Too many symbols requested', {
      maxSymbols: MAX_BATCH_SYMBOLS,
      requestedSymbols: symbols.length,
    });
  }
  for (const symbol of symbols) {
    if (!/^[A-Z0-9^][A-Z0-9.\-^=]{0,23}$/.test(symbol)) {
      throw badRequest('Invalid symbol in batch request', { symbol });
    }
  }
  return symbols;
}

function buildUpstreamUrl(origin, assetPath, query) {
  const encodedPath = assetPath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const url = new URL(`${origin}/${encodedPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const executing = new Set();
  for (const item of items) {
    const promise = Promise.resolve()
      .then(() => worker(item))
      .finally(() => executing.delete(promise));
    executing.add(promise);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
