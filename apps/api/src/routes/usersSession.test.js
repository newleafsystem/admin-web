import assert from 'node:assert/strict';
import express from 'express';
import { createUsersRouter } from './users.js';

const failingCookieService = {
  async setFromIdToken() {
    const error = new Error('missing firebase auth permission');
    error.code = 'auth/insufficient-permission';
    throw error;
  },
  clear() {},
};

const app = express();
app.use((req, res, next) => {
  req.requestId = 'test-session-request';
  req.user = {
    uid: 'admin-user',
    email: 'sd.nirsha@gmail.com',
    roles: ['admin'],
  };
  req.authCredential = {
    mode: 'firebase-id-token',
    token: 'test-token',
  };
  next();
});
app.use(
  '/api/v1',
  createUsersRouter({
    userAccessService: {},
    sessionCookieService: failingCookieService,
  }),
);

const server = await listen(app);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const originalWarn = console.warn;
console.warn = () => {};

try {
  const response = await fetch(`${baseUrl}/api/v1/session`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.email, 'sd.nirsha@gmail.com');
  assert.deepEqual(body.roles, ['admin']);
  assert.equal(body.cookie.created, false);
  assert.equal(body.cookie.warning, 'session_cookie_unavailable');
  assert.equal(body.cookie.errorCode, 'auth/insufficient-permission');

  console.log('User session cookie fallback tests passed.');
} finally {
  console.warn = originalWarn;
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
