import { Readable } from 'node:stream';
import { Router } from 'express';
import { config } from '../config.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badGateway, badRequest, conflict, notFound } from '../lib/httpErrors.js';

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

export function createPublicAssetsRouter() {
  const router = Router();

  router.get('/data/reports/latest', proxyLatestReportsBatch);
  router.post('/data/reports/latest', proxyLatestReportsBatch);
  router.get('/data/*', proxyPublicAsset(() => config.publicAssets.dataOriginUrl, 'data'));
  router.head('/data/*', proxyPublicAsset(() => config.publicAssets.dataOriginUrl, 'data'));
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

function proxyPublicAsset(originResolver, label) {
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
