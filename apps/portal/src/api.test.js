import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPortal, localSignInPath, routeFor } from './api.js';
import { messages } from './i18n.js';

const token = 'a'.repeat(43);

test('portal routes accept a capability only in the fragment', () => {
  assert.deepEqual(routeFor('/s/share_1', `#${token}`), { type: 'share', id: 'share_1', token });
  assert.deepEqual(routeFor('/invite/invite_1', '#invalid'), { type: 'invite', id: 'invite_1', token: undefined });
  assert.deepEqual(routeFor('/s/%2f', `#${token}`), { type: 'missing' });
  assert.equal(localSignInPath('//phish.example'), null);
  assert.equal(localSignInPath('/%2fphish.example'), null);
  assert.equal(localSignInPath('/auth/login'), '/auth/login');
});

test('capability requests omit cookies and send proof only via the authorization header', async () => {
  const result = await fetchPortal('/shares/share_1', { token }, async (path, options) => {
    assert.equal(path, '/api/v1/portal/shares/share_1');
    assert.equal(options.headers.Authorization, `Share ${token}`);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    return Response.json({ data: { id: 'share_1' } });
  });
  assert.deepEqual(result, { id: 'share_1' });
});

test('both portal locales provide the same string keys', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages['zh-Hant']).sort());
});