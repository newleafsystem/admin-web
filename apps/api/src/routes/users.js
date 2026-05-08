import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { clearAuthSessionCookie, setAuthSessionCookieFromIdToken } from '../lib/sessionCookies.js';
import { rejectUnknownFields, requireObject, requireString } from '../lib/validation.js';
import { USER_ROLES } from '../services/userAccessService.js';
import { badRequest } from '../lib/httpErrors.js';

const defaultSessionCookieService = {
  setFromIdToken: setAuthSessionCookieFromIdToken,
  clear: clearAuthSessionCookie,
};

export function createUsersRouter({ userAccessService, sessionCookieService = defaultSessionCookieService }) {
  const router = Router();

  router.get(
    '/session',
    asyncHandler(async (req, res) => {
      const cookie = await maybeRefreshSessionCookie(req, res, sessionCookieService);
      res.json({
        user: req.user,
        roles: req.user?.roles ?? [],
        cookie,
      });
    }),
  );

  router.post(
    '/session/cookie',
    asyncHandler(async (req, res) => {
      const cookie = await maybeRefreshSessionCookie(req, res, sessionCookieService);
      res.status(cookie.created ? 201 : 200).json({ cookie });
    }),
  );

  router.delete(
    '/session/cookie',
    asyncHandler(async (req, res) => {
      sessionCookieService.clear(res);
      res.status(204).send();
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

async function maybeRefreshSessionCookie(req, res, sessionCookieService) {
  if (req.authCredential?.mode !== 'firebase-id-token' || !req.authCredential.token) {
    return {
      created: false,
      mode: req.authCredential?.mode ?? req.user?.authMode ?? 'unknown',
    };
  }

  try {
    const cookie = await sessionCookieService.setFromIdToken(res, req.authCredential.token);
    return {
      created: true,
      ...cookie,
    };
  } catch (error) {
    console.warn('Session cookie refresh skipped', {
      requestId: req.requestId,
      uid: req.user?.uid,
      errorCode: getErrorCode(error),
    });
    return {
      created: false,
      mode: 'firebase-id-token',
      warning: 'session_cookie_unavailable',
      errorCode: getErrorCode(error),
    };
  }
}

function getErrorCode(error) {
  return error?.code ?? error?.errorInfo?.code ?? 'unknown';
}
