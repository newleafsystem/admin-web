import { config } from '../config.js';
import { unauthorized } from './httpErrors.js';
import { getFirebaseAuth } from './firebaseAdmin.js';

export function readAuthSessionCookie(req) {
  return readCookieValue(req.get('cookie'), config.auth.sessionCookieName);
}

export function hasAuthSessionCookie(req) {
  return Boolean(readAuthSessionCookie(req));
}

export async function verifyAuthSessionCookie(sessionCookie) {
  const auth = await getFirebaseAuth();
  if (!auth) {
    throw unauthorized('Firebase Auth is not configured');
  }
  return auth.verifySessionCookie(sessionCookie, true);
}

export async function setAuthSessionCookieFromIdToken(res, idToken) {
  if (!idToken) {
    throw unauthorized('Missing Firebase ID token for session cookie');
  }
  const auth = await getFirebaseAuth();
  if (!auth) {
    throw unauthorized('Firebase Auth is not configured');
  }
  const sessionCookie = await auth.createSessionCookie(idToken, {
    expiresIn: config.auth.sessionCookieMaxAgeMs,
  });
  res.cookie(config.auth.sessionCookieName, sessionCookie, sessionCookieOptions());
  res.cookie(config.auth.sessionHintCookieName, '1', sessionHintCookieOptions());
  if (config.auth.sessionCookieDomain) {
    res.cookie(config.auth.sessionCookieName, sessionCookie, sessionCookieOptions({ hostOnly: true }));
    res.cookie(config.auth.sessionHintCookieName, '1', sessionHintCookieOptions({ hostOnly: true }));
  }
  return {
    name: config.auth.sessionCookieName,
    hintName: config.auth.sessionHintCookieName,
    maxAgeSec: Math.floor(config.auth.sessionCookieMaxAgeMs / 1000),
    domain: config.auth.sessionCookieDomain ?? null,
    path: config.auth.sessionCookiePath,
    hostOnlyFallback: Boolean(config.auth.sessionCookieDomain),
  };
}

export function clearAuthSessionCookie(res) {
  res.clearCookie(config.auth.sessionCookieName, sessionCookieOptions({ clear: true }));
  res.clearCookie(config.auth.sessionHintCookieName, sessionHintCookieOptions({ clear: true }));
  if (config.auth.sessionCookieDomain) {
    res.clearCookie(config.auth.sessionCookieName, sessionCookieOptions({ clear: true, hostOnly: true }));
    res.clearCookie(config.auth.sessionHintCookieName, sessionHintCookieOptions({ clear: true, hostOnly: true }));
  }
}

export function readCookieValue(cookieHeader, name) {
  const target = String(name ?? '').trim();
  if (!target) {
    return null;
  }

  for (const cookie of String(cookieHeader ?? '').split(';')) {
    const [rawName, ...rawValueParts] = cookie.split('=');
    if (rawName?.trim() !== target) {
      continue;
    }
    const rawValue = rawValueParts.join('=').trim();
    if (!rawValue) {
      return null;
    }
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}

function sessionCookieOptions({ clear = false, hostOnly = false } = {}) {
  const options = {
    httpOnly: true,
    secure: Boolean(config.auth.sessionCookieSecure),
    sameSite: normalizeSameSite(config.auth.sessionCookieSameSite),
    path: config.auth.sessionCookiePath,
  };
  if (!clear) {
    options.maxAge = config.auth.sessionCookieMaxAgeMs;
  }
  if (config.auth.sessionCookieDomain && !hostOnly) {
    options.domain = config.auth.sessionCookieDomain;
  }
  return options;
}

function sessionHintCookieOptions({ clear = false, hostOnly = false } = {}) {
  const options = {
    secure: Boolean(config.auth.sessionCookieSecure),
    sameSite: normalizeSameSite(config.auth.sessionCookieSameSite),
    path: config.auth.sessionCookiePath,
  };
  if (!clear) {
    options.maxAge = config.auth.sessionCookieMaxAgeMs;
  }
  if (config.auth.sessionCookieDomain && !hostOnly) {
    options.domain = config.auth.sessionCookieDomain;
  }
  return options;
}

function normalizeSameSite(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['strict', 'lax', 'none'].includes(normalized) ? normalized : 'lax';
}
