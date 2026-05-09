import assert from 'node:assert/strict';
import { createInMemoryRepository } from '../lib/repository.js';
import { createUserAccessService, IMMUTABLE_ADMIN_EMAIL } from './userAccessService.js';

const repository = createInMemoryRepository({
  clock: (() => {
    let index = 0;
    return () => `2026-01-01T00:00:0${index++}.000Z`;
  })(),
});
const service = createUserAccessService({ repository });

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

const newUser = await service.ensureAuthenticatedUser({
  uid: 'firebase-user',
  email: 'new.user@example.com',
  displayName: 'New User',
});

assert.equal(newUser.role, 'anonymous');
assert.deepEqual(newUser.roles, ['anonymous']);
assert.deepEqual(newUser.appAccess, {
  admin: false,
  invest: false,
  picks: false,
  workbench: false,
  quant: false,
  desk: false,
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
assert.equal(promoted.appAccess.picks, false);

const users = await service.listUsers();
assert.equal(users[0].email, IMMUTABLE_ADMIN_EMAIL);
assert.equal(users.length, 2);

const deleted = await service.deleteUser(newUser.id);
assert.equal(deleted.email, 'new.user@example.com');
assert.equal((await service.listUsers()).length, 1);

console.log('User access service tests passed.');
