import assert from 'node:assert/strict';
import test from 'node:test';

import { exposeViaSeam, healthyOneShot } from './devbridge-harness.ts';

test('exposeTunnel returns ok:true with the publicUrl on a healthy attempt, verified from a second session', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const result = await exposeViaSeam(healthyOneShot(url), 8080, { keepalive: false });
  assert.equal(result.ok, true);
  assert.equal(result.publicUrl, url);
  assert.equal(result.tunnelId, 'c4rdv7bv');
  assert.equal(result.authMode, 'API_KEY_KEYRING');
  assert.equal(result.httpCode, '200');
  assert.equal(result.port, 8080);
  // #919: the fresh-session recheck fields.
  assert.equal(result.verifyHttpCode, '200');
  assert.equal(result.verifyNotFound, undefined);
  assert.equal(result.persistent, true);
  assert.equal(result.expiresInHours, 72);
  assert.ok(result.expiresAt, 'expiresAt must be present when DB_EXPIRY_HOURS echoed');
  assert.equal(result.warnings, undefined);
});
