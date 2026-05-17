import assert from 'node:assert/strict';
import express from 'express';
import { createAuthSessionRouter } from './authSession.js';

const decodedToken = Object.freeze({
  uid: 'user-123',
  email: 'client@example.com',
  name: 'Client User',
  picture: 'https://example.com/avatar.png',
  email_verified: true,
});

const appUser = Object.freeze({
  id: 'user-123',
  uid: 'user-123',
  email: 'client@example.com',
  displayName: 'Client User',
  photoUrl: 'https://example.com/avatar.png',
  role: 'anonymous',
  roles: ['anonymous'],
  appAccess: {
    admin: false,
    invest: true,
    picks: false,
    workbench: true,
    quant: false,
    desk: false,
  },
  status: 'active',
  immutable: false,
  accessManagedBy: 'admin-web',
  accessUpdatedAt: '2026-05-10T00:00:00.000Z',
});

let clearedCookie = false;
let failCustomToken = false;

const firebaseAuthService = {
  async verifyIdToken(idToken) {
    assert.equal(idToken, 'firebase-id-token');
    return decodedToken;
  },
  async verifySessionCookie(sessionCookie) {
    if (sessionCookie === 'bad-session') {
      throw new Error('invalid session');
    }
    assert.equal(sessionCookie, 'session-token');
    return decodedToken;
  },
  async createCustomToken(uid) {
    assert.equal(uid, decodedToken.uid);
    if (failCustomToken) {
      const error = new Error('signBlob permission denied');
      error.code = 'auth/insufficient-permission';
      throw error;
    }
    return 'custom-token';
  },
};

const sessionCookieService = {
  async setFromIdToken(res, idToken) {
    assert.equal(idToken, 'firebase-id-token');
    res.cookie('newleaf_session', 'session-token');
    return {
      name: 'newleaf_session',
      maxAgeSec: 86400,
      domain: '.newleafsystem.com',
      path: '/',
      hostOnlyFallback: true,
    };
  },
  clear(res) {
    clearedCookie = true;
    res.clearCookie('newleaf_session');
  },
};

const userAccessService = {
  async ensureAuthenticatedUser({ uid, email, displayName, photoUrl, loginContext }) {
    assert.equal(uid, decodedToken.uid);
    assert.equal(email, decodedToken.email);
    assert.equal(displayName, decodedToken.name);
    assert.equal(photoUrl, decodedToken.picture);
    assert.ok(loginContext);
    return appUser;
  },
};

const app = express();
app.use(express.json());
app.use(
  '/api/auth',
  createAuthSessionRouter({
    userAccessService,
    sessionCookieService,
    firebaseAuthService,
  }),
);

const server = await listen(app);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const createResponse = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: 'firebase-id-token' }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.authenticated, true);
  assert.equal(created.user.uid, 'user-123');
  assert.equal(created.profile.appAccess.invest, true);
  assert.equal(created.access.appMap.workbench, true);
  assert.equal(created.cookie.path, '/');

  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { cookie: 'newleaf_session=session-token' },
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, true);
  assert.equal(session.profile.accessManagedBy, 'admin-web');

  const customTokenResponse = await fetch(`${baseUrl}/api/auth/custom-token`, {
    method: 'POST',
    headers: { cookie: 'newleaf_session=session-token' },
  });
  assert.equal(customTokenResponse.status, 200);
  const customToken = await customTokenResponse.json();
  assert.equal(customToken.authenticated, true);
  assert.equal(customToken.customToken, 'custom-token');
  assert.equal(customToken.profile.accessManagedBy, 'admin-web');

  failCustomToken = true;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  let customTokenFallbackResponse;
  try {
    customTokenFallbackResponse = await fetch(`${baseUrl}/api/auth/custom-token`, {
      method: 'POST',
      headers: { cookie: 'newleaf_session=session-token' },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(customTokenFallbackResponse.status, 200);
  const customTokenFallback = await customTokenFallbackResponse.json();
  assert.equal(customTokenFallback.authenticated, true);
  assert.equal(customTokenFallback.customToken, null);
  assert.equal(customTokenFallback.customTokenUnavailable, true);
  assert.equal(customTokenFallback.profile.appAccess.invest, true);
  assert.equal(warnings.length, 1);
  failCustomToken = false;

  const invalidSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { cookie: 'newleaf_session=bad-session' },
  });
  assert.equal(invalidSessionResponse.status, 200);
  assert.deepEqual(await invalidSessionResponse.json(), { authenticated: false });
  assert.equal(clearedCookie, true);

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
  assert.equal(logoutResponse.status, 204);

  console.log('Browser auth session route tests passed.');
} finally {
  await close(server);
}

function listen(targetApp) {
  return new Promise((resolve) => {
    const server = targetApp.listen(0, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
