import { config, isProduction } from '../config.js';

const DEFAULT_ALLOWED_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'authorization,content-type,x-request-id';

export function corsMiddleware(options = {}) {
  const allowedOrigins = options.allowedOrigins ?? config.cors.allowedOrigins;

  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && isOriginAllowed(origin, allowedOrigins)) {
      res.set('access-control-allow-origin', origin);
      res.set('access-control-allow-credentials', 'true');
      res.set('vary', appendVary(res.get('vary'), 'Origin'));
      res.set(
        'access-control-allow-methods',
        req.get('access-control-request-method') ?? DEFAULT_ALLOWED_METHODS,
      );
      res.set(
        'access-control-allow-headers',
        req.get('access-control-request-headers') ?? DEFAULT_ALLOWED_HEADERS,
      );
      res.set('access-control-max-age', '600');
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).send();
    }

    return next();
  };
}

export function isOriginAllowed(origin, allowedOrigins = []) {
  if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
    return true;
  }

  if (!isProduction() && isLocalDevOrigin(origin)) {
    return true;
  }

  return false;
}

function isLocalDevOrigin(origin) {
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function appendVary(existing, value) {
  if (!existing) {
    return value;
  }
  const parts = existing.split(',').map((part) => part.trim().toLowerCase());
  return parts.includes(value.toLowerCase()) ? existing : `${existing}, ${value}`;
}
