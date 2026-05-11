import { Router } from 'express';
import { config } from '../config.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { badGateway, badRequest, conflict } from '../lib/httpErrors.js';
import { optionalString, requireString } from '../lib/validation.js';

export function createMarketDataRouter() {
  const router = Router();

  router.get(
    '/options/snapshots',
    asyncHandler(async (req, res) => {
      const symbol = requireString(req.query, 'symbols', { maxLength: 120 });
      if (!/^[A-Z0-9.\-_, ]+$/i.test(symbol)) {
        throw badRequest('Invalid options symbol request');
      }

      const feed = optionalString(req.query, 'feed', { maxLength: 24, defaultValue: 'opra' });
      if (feed && !/^[a-z0-9_-]+$/i.test(feed)) {
        throw badRequest('Invalid options feed');
      }

      const upstreamUrl = new URL('/v1beta1/options/snapshots', normalizeAlpacaBaseUrl());
      upstreamUrl.searchParams.set('symbols', symbol);
      if (feed) upstreamUrl.searchParams.set('feed', feed);

      const upstream = await fetch(upstreamUrl, {
        headers: {
          'APCA-API-KEY-ID': readAlpacaApiKey(),
          'APCA-API-SECRET-KEY': readAlpacaSecretKey(),
        },
      }).catch((error) => {
        throw badGateway('Unable to fetch option snapshot', {
          reason: error.name ?? 'fetch_failed',
        });
      });

      const body = await upstream.text();
      res.status(upstream.status);
      res.set('cache-control', 'no-store');
      res.set('content-type', upstream.headers.get('content-type') ?? 'application/json');
      res.set('x-content-type-options', 'nosniff');
      return res.send(body);
    }),
  );

  return router;
}

function normalizeAlpacaBaseUrl() {
  const value = String(config.alpaca.dataBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(value)) {
    throw conflict('Alpaca data API base URL must use HTTPS');
  }
  return value;
}

function readAlpacaApiKey() {
  if (!config.alpaca.apiKey) {
    throw conflict('Alpaca API key is not configured');
  }
  return config.alpaca.apiKey;
}

function readAlpacaSecretKey() {
  if (!config.alpaca.secretKey) {
    throw conflict('Alpaca secret key is not configured');
  }
  return config.alpaca.secretKey;
}
