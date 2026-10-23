import assert from 'node:assert/strict';
import test from 'node:test';

import { signSdkHmacRequest } from '../plugins/huaweicloud-core/src/lib/hw-request-signing.ts';

// Characterization pins for the unified SDK-HMAC-SHA256 signer. The two
// legacy implementations (IAM validator, hwlink client) merged into one
// module with no direct coverage — the fake-server tests only assert the
// Authorization PREFIX, so a regression in canonical-request assembly, key
// sorting, urlEncode, or body hashing would still emit a well-formed header
// and surface as production 401s. These vectors pin the exact signature for
// a fixed timestamp (the only non-deterministic input), across the four
// caller shapes: GET with/without security token, POST with body with/without
// token, plus the falsy-body contract.
//
// The literals were generated once from the merged implementation at
// behavior-parity with both legacy signers (traced line-by-line during the
// unification) and are frozen: any change to the signing algebra must be
// deliberate and update these vectors in the same commit.

const IAM_BASE = 'https://iam.myhuaweicloud.com';
const HWLINK_BASE = 'https://devstation.myhuaweicloud.com';
const FIXED_TS = '20260101T000000Z';
const AK = 'TESTAK';
const SK = 'TESTSK123';

test('signSdkHmacRequest: GET with query, no token (IAM shape)', () => {
  const headers = signSdkHmacRequest({
    ak: AK,
    sk: SK,
    baseUrl: IAM_BASE,
    timestamp: FIXED_TS,
    path: '/v3/projects',
    query: { name: 'cn-north-4' },
  });
  assert.equal(headers.host, 'iam.myhuaweicloud.com');
  assert.equal(headers['x-sdk-date'], FIXED_TS);
  assert.equal('x-security-token' in headers, false);
  assert.equal(
    headers.Authorization,
    'SDK-HMAC-SHA256 Access=TESTAK, SignedHeaders=host;x-sdk-date, Signature=d0f0acfa341be5875f55d0b5d01a21e007bc4bdff70e6b3baf39499150f9d91f',
  );
});

test('signSdkHmacRequest: GET with security token', () => {
  const headers = signSdkHmacRequest({
    ak: AK,
    sk: SK,
    baseUrl: IAM_BASE,
    timestamp: FIXED_TS,
    path: '/v3/projects',
    query: { name: 'cn-north-4' },
    securityToken: 'STOKEN123',
  });
  assert.equal(headers.host, 'iam.myhuaweicloud.com');
  assert.equal(headers['x-sdk-date'], FIXED_TS);
  assert.equal(headers['x-security-token'], 'STOKEN123');
  assert.equal(
    headers.Authorization,
    'SDK-HMAC-SHA256 Access=TESTAK, SignedHeaders=host;x-sdk-date;x-security-token, Signature=79edfdd702fba1c17ad71229299a27592444f04835c8bca154513f4a7d294e15',
  );
});

test('signSdkHmacRequest: POST with JSON body and token (hwlink shape)', () => {
  const headers = signSdkHmacRequest({
    ak: AK,
    sk: SK,
    baseUrl: HWLINK_BASE,
    timestamp: FIXED_TS,
    method: 'POST',
    path: '/open-api-public/v1/devenvs/env-1/connections',
    query: {},
    body: { source: 'CLI' },
    securityToken: 'STOKEN123',
  });
  assert.equal(headers.host, 'devstation.myhuaweicloud.com');
  assert.equal(headers['x-sdk-date'], FIXED_TS);
  assert.equal(headers['x-security-token'], 'STOKEN123');
  assert.equal(
    headers.Authorization,
    'SDK-HMAC-SHA256 Access=TESTAK, SignedHeaders=host;x-sdk-date;x-security-token, Signature=21c58de5d5c909deb753715d64c9b2a2683893850fa51d5ad2d290582a341cb6',
  );
});

test('signSdkHmacRequest: POST with JSON body, no token', () => {
  const headers = signSdkHmacRequest({
    ak: AK,
    sk: SK,
    baseUrl: HWLINK_BASE,
    timestamp: FIXED_TS,
    method: 'POST',
    path: '/open-api-public/v1/devenvs/env-1/connections',
    query: {},
    body: { source: 'CLI' },
  });
  assert.equal(headers.host, 'devstation.myhuaweicloud.com');
  assert.equal('x-security-token' in headers, false);
  assert.equal(
    headers.Authorization,
    'SDK-HMAC-SHA256 Access=TESTAK, SignedHeaders=host;x-sdk-date, Signature=3a20af5fefaa8a61590dfc7713f0e5768759d3d42215123dcdbfcd30ccff1bdc',
  );
});

test('signSdkHmacRequest: falsy body signs the empty payload (legacy contract)', () => {
  // The doc contract: undefined, '', null, 0, false all hash '' — the
  // truthiness check both legacy signers used. A scalar 0 must sign
  // identically to no body at all.
  const falsy = signSdkHmacRequest({
    ak: AK,
    sk: SK,
    baseUrl: IAM_BASE,
    timestamp: FIXED_TS,
    method: 'POST',
    path: '/x',
    query: {},
    body: 0,
  });
  const empty = signSdkHmacRequest({
    ak: AK,
    sk: SK,
    baseUrl: IAM_BASE,
    timestamp: FIXED_TS,
    method: 'POST',
    path: '/x',
    query: {},
  });
  assert.equal(falsy.Authorization, empty.Authorization);
});

test('signSdkHmacRequest: wall-clock default carries the legacy double-Z timestamp', () => {
  // A regression that pins ts to a constant would pass every fixed-vector
  // test above and break only here (and in production). The format is the
  // legacy quirk both signers shipped: toISOString's trailing Z plus the
  // appended Z — 20261023T124325ZZ. The servers accept it (the signature
  // covers whatever string is used), so it is preserved, not fixed.
  const a = signSdkHmacRequest({ ak: AK, sk: SK, baseUrl: IAM_BASE, path: '/v3/projects' });
  assert.match(a['x-sdk-date'] ?? '', /^\d{8}T\d{6}ZZ$/);
});
