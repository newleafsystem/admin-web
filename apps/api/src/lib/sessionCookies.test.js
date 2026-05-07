import assert from 'node:assert/strict';
import { readCookieValue } from './sessionCookies.js';

assert.equal(readCookieValue('other=1; newleaf_session=abc123; theme=dark', 'newleaf_session'), 'abc123');
assert.equal(readCookieValue('newleaf_session=a%20b%3Dc', 'newleaf_session'), 'a b=c');
assert.equal(readCookieValue('newleaf_session=; other=1', 'newleaf_session'), null);
assert.equal(readCookieValue('other=1', 'newleaf_session'), null);
assert.equal(readCookieValue('', 'newleaf_session'), null);

console.log('Session cookie helper tests passed.');
