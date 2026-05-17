import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { buildLoginContextFromRequest } from '../middleware/auth.js';
import { getFirebaseAuth } from '../lib/firebaseAdmin.js';
import { badRequest, unauthorized } from '../lib/httpErrors.js';
import {
  clearAuthSessionCookie,
  readAuthSessionCookie,
  setAuthSessionCookieFromIdToken,
  verifyAuthSessionCookie,
} from '../lib/sessionCookies.js';
import { rejectUnknownFields, requireObject, requireString } from '../lib/validation.js';

const defaultSessionCookieService = {
  setFromIdToken: setAuthSessionCookieFromIdToken,
  clear: clearAuthSessionCookie,
};

const defaultFirebaseAuthService = {
  async verifyIdToken(idToken) {
    const auth = await requireFirebaseAuth();
    return auth.verifyIdToken(idToken);
  },
  async verifySessionCookie(sessionCookie) {
    return verifyAuthSessionCookie(sessionCookie);
  },
  async createCustomToken(uid) {
    const auth = await requireFirebaseAuth();
    return auth.createCustomToken(uid);
  },
};

export function createAuthSessionRouter({
  userAccessService,
  sessionCookieService = defaultSessionCookieService,
  firebaseAuthService = defaultFirebaseAuthService,
} = {}) {
  if (!userAccessService) {
    throw new Error('createAuthSessionRouter requires userAccessService');
  }

  const router = Router();

  router.get(
    '/session',
    asyncHandler(async (req, res) => {
      const sessionCookie = readAuthSessionCookie(req);
      if (!sessionCookie) {
        res.json({ authenticated: false });
        return;
      }

      let decodedToken;
      try {
        decodedToken = await firebaseAuthService.verifySessionCookie(sessionCookie);
      } catch {
        sessionCookieService.clear(res);
        res.json({ authenticated: false });
        return;
      }

      const user = await ensureSessionUser({ userAccessService, decodedToken, req });
      res.json(toAuthSessionResponse({ user, decodedToken }));
    }),
  );

  router.post(
    '/session',
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body);
      rejectUnknownFields(body, ['idToken']);
      const idToken = requireString(body, 'idToken', { maxLength: 10000 });
      const decodedToken = await firebaseAuthService.verifyIdToken(idToken);
      const user = await ensureSessionUser({ userAccessService, decodedToken, req });
      const cookie = await sessionCookieService.setFromIdToken(res, idToken);
      res.status(201).json(toAuthSessionResponse({ user, decodedToken, cookie }));
    }),
  );

  router.post(
    '/custom-token',
    asyncHandler(async (req, res) => {
      const sessionCookie = readAuthSessionCookie(req);
      if (!sessionCookie) {
        throw unauthorized('Missing NewLeaf session cookie');
      }

      let decodedToken;
      try {
        decodedToken = await firebaseAuthService.verifySessionCookie(sessionCookie);
      } catch {
        sessionCookieService.clear(res);
        throw unauthorized('Invalid or expired NewLeaf session cookie');
      }

      const user = await ensureSessionUser({ userAccessService, decodedToken, req });
      const session = toAuthSessionResponse({ user, decodedToken });
      try {
        const customToken = await firebaseAuthService.createCustomToken(decodedToken.uid);
        res.json({ ...session, customToken });
      } catch (error) {
        console.warn('Firebase custom token restore is unavailable', {
          requestId: req.requestId,
          code: getFirebaseAuthErrorCode(error),
        });
        res.json({
          ...session,
          customToken: null,
          customTokenUnavailable: true,
        });
      }
    }),
  );

  router.post('/logout', clearSession(sessionCookieService));
  router.delete('/session', clearSession(sessionCookieService));

  return router;
}

function clearSession(sessionCookieService) {
  return asyncHandler(async (req, res) => {
    sessionCookieService.clear(res);
    res.status(204).send();
  });
}

async function ensureSessionUser({ userAccessService, decodedToken, req }) {
  if (!decodedToken?.uid) {
    throw badRequest('Firebase token is missing uid');
  }

  return userAccessService.ensureAuthenticatedUser({
    uid: decodedToken.uid,
    email: decodedToken.email ?? null,
    displayName: decodedToken.name ?? null,
    photoUrl: decodedToken.picture ?? null,
    authMode: 'firebase',
    loginContext: buildLoginContextFromRequest(req),
  });
}

function toAuthSessionResponse({ user, decodedToken, cookie = null }) {
  const safeUser = toSafeUser(user, decodedToken);
  const profile = toClientProfile(user, safeUser);
  return {
    authenticated: true,
    user: safeUser,
    profile,
    access: {
      roles: profile.roles,
      appMap: profile.appAccess,
    },
    expiresAt: cookie ? Date.now() + cookie.maxAgeSec * 1000 : null,
    cookie,
  };
}

function toSafeUser(user, decodedToken) {
  return {
    uid: user.uid,
    email: user.email ?? decodedToken.email ?? null,
    displayName: user.displayName ?? decodedToken.name ?? null,
    photoURL: user.photoUrl ?? decodedToken.picture ?? null,
    emailVerified: decodedToken.email_verified === true,
  };
}

function toClientProfile(user, safeUser) {
  return {
    uid: user.uid,
    email: user.email,
    communicationEmail: user.email,
    displayName: user.displayName,
    photoURL: user.photoUrl,
    emailVerified: safeUser.emailVerified,
    role: user.role,
    roles: user.roles,
    appAccess: user.appAccess,
    apps: user.appAccess,
    applications: user.appAccess,
    productAccess: user.appAccess,
    status: user.status,
    disabled: user.status !== 'active',
    immutable: user.immutable,
    accessManagedBy: user.accessManagedBy,
    accessUpdatedAt: user.accessUpdatedAt,
  };
}

function getFirebaseAuthErrorCode(error) {
  return error?.code ?? error?.errorInfo?.code ?? 'unknown';
}

async function requireFirebaseAuth() {
  const auth = await getFirebaseAuth();
  if (!auth) {
    throw unauthorized('Firebase Auth is not configured');
  }
  return auth;
}
