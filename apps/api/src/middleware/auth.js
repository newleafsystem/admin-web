import { config } from '../config.js';
import { forbidden, unauthorized } from '../lib/httpErrors.js';
import { getFirebaseAuth } from '../lib/firebaseAdmin.js';
import { createUserAccessService, localAdminUser } from '../services/userAccessService.js';

export function authenticateRequest(options = {}) {
  const requireAuth = options.requireAuth ?? config.auth.requireAuth;
  const userAccessService = options.userAccessService ?? createUserAccessService({ repository: options.repository });

  return async (req, res, next) => {
    try {
      if (!requireAuth) {
        req.user = localAdminUser();
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
