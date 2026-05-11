import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { clearAuthSessionCookie, setAuthSessionCookieFromIdToken } from '../lib/sessionCookies.js';
import { optionalObject, rejectUnknownFields, requireObject, requireString } from '../lib/validation.js';
import { USER_APP_IDS, USER_NOTIFICATION_TOPIC_IDS, USER_ROLES } from '../services/userAccessService.js';
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
      rejectUnknownFields(body, ['role', 'appAccess']);

      let role;
      if (Object.prototype.hasOwnProperty.call(body, 'role')) {
        role = requireString(body, 'role', { maxLength: 40 });
        if (!USER_ROLES.includes(role)) {
          throw badRequest('User role is not supported', { role, allowed: USER_ROLES });
        }
      }

      const appAccess = optionalObject(body, 'appAccess', { defaultValue: undefined });
      if (appAccess !== undefined) {
        rejectUnknownFields(appAccess, USER_APP_IDS, 'appAccess');
        for (const [appId, enabled] of Object.entries(appAccess)) {
          if (typeof enabled !== 'boolean') {
            throw badRequest('appAccess values must be booleans', { appId });
          }
        }
      }

      if (role === undefined && appAccess === undefined) {
        throw badRequest('At least one user access field is required', {
          allowedFields: ['role', 'appAccess'],
        });
      }

      const user = await userAccessService.updateUserAccess(req.params.userId, { role, appAccess }, {
        actorUid: req.user.uid,
      });
      res.json({ user });
    }),
  );

  router.patch(
    '/users/:userId/notifications',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['email']);

      const email = optionalObject(body, 'email', { defaultValue: undefined });
      if (email === undefined) {
        throw badRequest('At least one notification field is required', {
          allowedFields: ['email'],
        });
      }

      rejectUnknownFields(email, ['enabled', 'address', 'topics'], 'email');
      if (Object.prototype.hasOwnProperty.call(email, 'enabled') && typeof email.enabled !== 'boolean') {
        throw badRequest('email.enabled must be a boolean');
      }
      if (Object.prototype.hasOwnProperty.call(email, 'address') && email.address !== null) {
        requireString(email, 'address', { minLength: 3, maxLength: 254 });
      }

      const topics = optionalObject(email, 'topics', { defaultValue: undefined });
      if (topics !== undefined) {
        rejectUnknownFields(topics, USER_NOTIFICATION_TOPIC_IDS, 'email.topics');
        for (const [topicId, enabled] of Object.entries(topics)) {
          if (typeof enabled !== 'boolean') {
            throw badRequest('email.topics values must be booleans', { topicId });
          }
        }
      }

      const user = await userAccessService.updateUserNotifications(req.params.userId, { email }, {
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
