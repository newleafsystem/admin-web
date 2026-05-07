import { config } from '../config.js';
import { forbidden, unauthorized } from '../lib/httpErrors.js';
import { getFirebaseAuth } from '../lib/firebaseAdmin.js';
import { hasAuthSessionCookie, readAuthSessionCookie, verifyAuthSessionCookie } from '../lib/sessionCookies.js';
import { createUserAccessService, localAdminUser } from '../services/userAccessService.js';
import { authenticateServiceApiKey } from './serviceApiAuth.js';

export function authenticateRequest(options = {}) {
  const requireAuth = options.requireAuth ?? config.auth.requireAuth;
  const userAccessService = options.userAccessService ?? createUserAccessService({ repository: options.repository });

  return async (req, res, next) => {
    try {
      if (!requireAuth) {
        req.user = localAdminUser();
        return next();
      }

      const bearerToken = readBearerToken(req.get('authorization'));
      const sessionCookie = readAuthSessionCookie(req);
      if (!bearerToken && !sessionCookie) {
        throw unauthorized('Missing bearer token or NewLeaf session cookie');
      }

      const auth = await getFirebaseAuth();
      if (!auth) {
        throw unauthorized('Firebase Auth is not configured');
      }

      const decodedToken = bearerToken
        ? await auth.verifyIdToken(bearerToken)
        : await verifyAuthSessionCookie(sessionCookie);
      req.authCredential = bearerToken
        ? { mode: 'firebase-id-token', token: bearerToken }
        : { mode: 'firebase-session-cookie' };
      const user = await userAccessService.ensureAuthenticatedUser({
        uid: decodedToken.uid,
        email: decodedToken.email ?? null,
        displayName: decodedToken.name ?? null,
        photoUrl: decodedToken.picture ?? null,
        authMode: 'firebase',
      });
      req.user = {
        ...user,
        claims: decodedToken,
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const roles = req.user?.roles ?? [];
    if (roles.includes('admin') || allowedRoles.some((role) => roles.includes(role))) {
      return next();
    }
    return next(forbidden('Insufficient role for this operation', { allowedRoles }));
  };
}

export function authenticateUserOrService(options = {}) {
  const userAuth = authenticateRequest(options);
  const serviceAuth = authenticateServiceApiKey({
    repository: options.repository,
    keyHashes: options.serviceApiKeyHashes,
    rateLimitPerMinute: options.serviceApiRateLimitPerMinute,
    signatureToleranceSec: options.serviceApiSignatureToleranceSec,
  });

  return async (req, res, next) => {
    const snapshot = captureAuthState(req);
    const hasUserCredentials = hasBearerToken(req) || hasAuthSessionCookie(req);
    const hasServiceCredentials = hasExplicitServiceCredentials(req);
    let userError = null;
    let serviceError = null;

    if (hasServiceCredentials) {
      try {
        await runMiddleware(serviceAuth, req, res);
        return next();
      } catch (error) {
        serviceError = error;
        restoreAuthState(req, snapshot);
      }
    }

    if (hasUserCredentials || !hasServiceCredentials) {
      try {
        await runMiddleware(userAuth, req, res);
        return next();
      } catch (error) {
        userError = error;
        restoreAuthState(req, snapshot);
      }
    }

    if (!hasUserCredentials && !hasServiceCredentials) {
      return next(
        unauthorized('Missing login or service API credentials', {
          acceptedCredentials: [
            'Authorization: Bearer <Firebase ID token>',
            'NewLeaf admin session cookie',
            'x-newleaf-key-id + x-newleaf-timestamp + x-newleaf-signature',
            'x-newleaf-api-key',
          ],
        }),
      );
    }

    return next(serviceError ?? userError ?? unauthorized());
  };
}

function hasBearerToken(req) {
  return Boolean(readBearerToken(req.get('authorization')));
}

function hasExplicitServiceCredentials(req) {
  return Boolean(
    req.get('x-newleaf-key-id') ??
      req.get('x-newleaf-signature') ??
      req.get('x-newleaf-api-key') ??
      req.get('x-api-key'),
  );
}

function runMiddleware(middleware, req, res) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function captureAuthState(req) {
  return {
    user: req.user,
    serviceClient: req.serviceClient,
    authCredential: req.authCredential,
  };
}

function restoreAuthState(req, snapshot) {
  if (snapshot.user === undefined) {
    delete req.user;
  } else {
    req.user = snapshot.user;
  }

  if (snapshot.serviceClient === undefined) {
    delete req.serviceClient;
  } else {
    req.serviceClient = snapshot.serviceClient;
  }

  if (snapshot.authCredential === undefined) {
    delete req.authCredential;
  } else {
    req.authCredential = snapshot.authCredential;
  }
}

function readBearerToken(authorization) {
  const header = String(authorization ?? '').trim();
  if (header.length <= 'Bearer '.length || header.slice(0, 6).toLowerCase() !== 'bearer') {
    return null;
  }

  const separator = header[6];
  if (separator !== ' ' && separator !== '\t') {
    return null;
  }

  const token = header.slice(7).trim();
  return token || null;
}
