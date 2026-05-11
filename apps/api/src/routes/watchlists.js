import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import { badRequest } from '../lib/httpErrors.js';
import { requireObject } from '../lib/validation.js';
import { WATCHLIST_CONFIG_ID } from '../services/watchlistService.js';

export function createWatchlistsRouter({ watchlistService }) {
  const router = Router();

  router.get(
    '/watchlists/default',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      res.json({ watchlist: await watchlistService.getWatchlistConfig() });
    }),
  );

  router.put(
    '/watchlists/default',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      if (body.id && body.id !== WATCHLIST_CONFIG_ID) {
        throw badRequest('Only the default scanner watchlist can be updated right now', {
          id: body.id,
        });
      }
      const watchlist = await watchlistService.updateWatchlistConfig(body, {
        actorUid: req.user?.uid ?? null,
      });
      res.json({ watchlist });
    }),
  );

  return router;
}
