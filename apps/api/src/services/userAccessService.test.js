import assert from 'node:assert/strict';
import { createInMemoryRepository } from '../lib/repository.js';
import { createUserAccessService, IMMUTABLE_ADMIN_EMAIL, IMMUTABLE_ADMIN_EMAILS } from './userAccessService.js';

const repository = createInMemoryRepository({
  clock: (() => {
    let index = 0;
    return () => `2026-01-01T00:00:0${index++}.000Z`;
  })(),
});
const service = createUserAccessService({
  repository,
  clock: (() => {
    let index = 0;
    return () => `2026-01-01T00:00:0${index++}.000Z`;
  })(),
});

const immutableAdmin = await service.ensureAuthenticatedUser({
  uid: 'firebase-owner',
  email: IMMUTABLE_ADMIN_EMAIL,
  displayName: 'Primary Admin',
});

assert.equal(immutableAdmin.role, 'admin');
assert.deepEqual(immutableAdmin.roles, ['admin']);
assert.deepEqual(immutableAdmin.appAccess, {
  admin: true,
  invest: true,
  picks: true,
  workbench: true,
  quant: true,
  desk: true,
});
assert.equal(immutableAdmin.immutable, true);

await assert.rejects(
  () => service.updateUserRole(immutableAdmin.id, 'anonymous', { actorUid: 'other-admin' }),
  /primary NewLeaf admin cannot be changed/i,
);
await assert.rejects(
  () => service.deleteUser(immutableAdmin.id),
  /primary NewLeaf admin cannot be deleted/i,
);

const secondImmutableAdmin = await service.ensureAuthenticatedUser({
  uid: 'firebase-admin-two',
  email: IMMUTABLE_ADMIN_EMAILS[1],
  displayName: 'Second Primary Admin',
});

assert.equal(secondImmutableAdmin.role, 'admin');
assert.deepEqual(secondImmutableAdmin.roles, ['admin']);
assert.equal(secondImmutableAdmin.appAccess.admin, true);
assert.equal(secondImmutableAdmin.appAccess.invest, true);
assert.equal(secondImmutableAdmin.immutable, true);

await assert.rejects(
  () => service.updateUserAccess(secondImmutableAdmin.id, {
    role: 'anonymous',
    appAccess: {
      admin: false,
      invest: false,
      picks: false,
      workbench: false,
      quant: false,
      desk: false,
    },
  }, { actorUid: immutableAdmin.id }),
  /primary NewLeaf admin cannot be changed/i,
);

const newUser = await service.ensureAuthenticatedUser({
  uid: 'firebase-user',
  email: 'new.user@example.com',
  displayName: 'New User',
  loginContext: {
    ipAddress: '203.0.113.10',
    city: 'Mumbai',
    region: 'Maharashtra',
    country: 'IN',
    timezone: 'Asia/Kolkata',
    source: 'cloudflare',
  },
});

assert.equal(newUser.role, 'anonymous');
assert.deepEqual(newUser.roles, ['anonymous']);
assert.deepEqual(newUser.notificationPreferences.email.topics, {
  weeklyPicks: true,
  scannerAlerts: false,
  publishingAlerts: false,
  accountAccess: true,
  systemAlerts: false,
});
assert.deepEqual(newUser.appAccess, {
  admin: false,
  invest: false,
  picks: false,
  workbench: false,
  quant: false,
  desk: false,
});
assert.deepEqual(newUser.lastLoginContext, {
  ipAddress: '203.0.113.10',
  country: 'IN',
  city: 'Mumbai',
  region: 'Maharashtra',
  regionCode: null,
  continent: null,
  timezone: 'Asia/Kolkata',
  latitude: null,
  longitude: null,
  postalCode: null,
  metroCode: null,
  rayId: null,
  userAgent: null,
  source: 'cloudflare',
  capturedAt: '2026-01-01T00:00:02.000Z',
});

const promoted = await service.updateUserAccess(newUser.id, {
  role: 'admin',
  appAccess: {
    admin: true,
    invest: true,
    picks: false,
    workbench: true,
    quant: false,
    desk: false,
  },
}, { actorUid: immutableAdmin.id });
assert.equal(promoted.role, 'admin');
assert.deepEqual(promoted.roles, ['admin']);
assert.equal(promoted.appAccess.admin, true);
assert.equal(promoted.appAccess.invest, true);
assert.equal(promoted.appAccess.workbench, true);
assert.equal(promoted.appAccess.picks, true);
assert.equal(promoted.appAccess.quant, true);
assert.equal(promoted.appAccess.desk, true);

const users = await service.listUsers();
assert.deepEqual(new Set(users.slice(0, 2).map((user) => user.email)), new Set(IMMUTABLE_ADMIN_EMAILS));
assert.equal(users.length, 3);

const notificationUpdated = await service.updateUserNotifications(newUser.id, {
  email: {
    enabled: true,
    address: 'alerts@example.com',
    topics: {
      weeklyPicks: false,
      scannerAlerts: true,
    },
  },
}, { actorUid: immutableAdmin.id });
assert.equal(notificationUpdated.notificationPreferences.email.address, 'alerts@example.com');
assert.equal(notificationUpdated.notificationPreferences.email.enabled, true);
assert.equal(notificationUpdated.notificationPreferences.email.topics.weeklyPicks, false);
assert.equal(notificationUpdated.notificationPreferences.email.topics.scannerAlerts, true);
assert.equal(notificationUpdated.notificationPreferences.email.topics.accountAccess, true);
assert.equal(notificationUpdated.notificationPreferences.email.updatedBy, immutableAdmin.id);

const deleted = await service.deleteUser(newUser.id);
assert.equal(deleted.email, 'new.user@example.com');
assert.equal((await service.listUsers()).length, 2);

console.log('User access service tests passed.');
