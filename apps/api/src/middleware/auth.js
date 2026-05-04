import { config } from '../config.js';
import { forbidden, unauthorized } from '../lib/httpErrors.js';
import { getFirebaseAuth } from '../lib/firebaseAdmin.js';

const LOCAL_DEV_USER = Object.freeze({
  uid: 'local-dev',
  email: 'local-dev@newleaf.invalid',
  roles: ['admin', 'editor', 'reviewer', 'publisher', 'viewer'],
  authMode: 'local-dev',
});

export function authenticateRequest(options = {}) {
  const requireAuth = options.requireAuth ?? config.auth.requireAuth;

  return async (req, res, next) => {
    try {
      if (!requireAuth) {
        req.user = LOCAL_DEV_USER;
        return next();
      }

      const authorization = req.get('authorization') ?? '';
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        throw unauthorized('Missing bearer token');
      }

      const auth = await getFirebaseAuth();
      if (!auth) {
        throw unauthorized('Firebase Auth is not configured');
      }

      const decodedToken = await auth.verifyIdToken(match[1]);
      req.user = {
        uid: decodedToken.uid,
        email: decodedToken.email ?? null,
        roles: normalizeRoles(decodedToken.roles ?? decodedToken.role),
        claims: decodedToken,
        authMode: 'firebase',
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

function normalizeRoles(value) {
  if (Array.isArray(value)) {
    return value.filter((role) => typeof role === 'string');
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}
