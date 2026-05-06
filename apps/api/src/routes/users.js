import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { rejectUnknownFields, requireObject, requireString } from '../lib/validation.js';
import { USER_ROLES } from '../services/userAccessService.js';
import { badRequest } from '../lib/httpErrors.js';

export function createUsersRouter({ userAccessService }) {
  const router = Router();

  router.get(
    '/session',
    asyncHandler(async (req, res) => {
      res.json({
        user: req.user,
        roles: req.user?.roles ?? [],
      });
    }),
  );

  router.get(
    '/users',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      res.json({ users: await userAccessService.listUsers() });
    }),
  );

  router.patch(
    '/users/:userId',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['role']);
      const role = requireString(body, 'role', { maxLength: 40 });
      if (!USER_ROLES.includes(role)) {
        throw badRequest('User role is not supported', { role, allowed: USER_ROLES });
      }
      const user = await userAccessService.updateUserRole(req.params.userId, role, {
        actorUid: req.user.uid,
      });
      res.json({ user });
    }),
  );

  router.delete(
    '/users/:userId',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const user = await userAccessService.deleteUser(req.params.userId);
      res.json({ user });
    }),
  );

  return router;
}
