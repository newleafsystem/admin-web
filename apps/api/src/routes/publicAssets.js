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

  router.get('/data/*', proxyPublicAsset(() => config.publicAssets.dataOriginUrl, 'data'));
  router.head('/data/*', proxyPublicAsset(() => config.publicAssets.dataOriginUrl, 'data'));
  router.get('/media/*', proxyPublicAsset(() => config.publicAssets.mediaOriginUrl, 'media'));
  router.head('/media/*', proxyPublicAsset(() => config.publicAssets.mediaOriginUrl, 'media'));

  return router;
}

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
  if (!/^https:\/\//i.test(origin)) {
    throw conflict('Public asset origin must use HTTPS', {
      assetType: label,
    });
  }
  return origin;
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
