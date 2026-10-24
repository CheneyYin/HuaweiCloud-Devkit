import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { freshRoot, opts, vaultErrorCode } from './secret-vault-helpers.ts';
import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { resolveSecretValue, vaultDelete, vaultGet, vaultSet } from '../plugins/huaweicloud-core/src/lib/secret-vault/store.ts';
import { isSecretRef, parseSecretRef } from '../plugins/huaweicloud-core/src/lib/secret-vault/refs.ts';

test('refs: grammar accepts the canonical shape only', () => {
  assert.deepEqual(parseSecretRef('secret://user/hw-ak'), { scope: 'user', name: 'hw-ak' });
  assert.equal(isSecretRef('secret://devteam/prod-token'), true);
  for (const bad of [
    'secret://User/hw-ak',
    'secret://user/HW-AK',
    'secret://user/../etc/passwd',
    'secret://user/a%2Fb',
    'secret://user:8080/ak',
    'secret://user/ak/inner',
    'secret://user',
    'secret://user/',
    'secret://lock/foo',
    'SECRET://user/ak',
    'hw-ak',
    '',
  ]) {
    assert.equal(parseSecretRef(bad), null, `"${bad}" must be rejected`);
    assert.equal(isSecretRef(bad), false, `"${bad}" must fail the type guard`);
  }
  const longSegment = 'a'.repeat(64);
  assert.deepEqual(parseSecretRef(`secret://user/${longSegment}`), { scope: 'user', name: longSegment });
  assert.equal(parseSecretRef(`secret://user/${'a'.repeat(65)}`), null);
});

test('store: get on an uninitialized vault fails loud with guidance', () => {
  const root = freshRoot();
  let caught: unknown;
  assert.throws(
    () => vaultGet('secret://user/never-set', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_NOT_INITIALIZED');
});

test('store: a corrupt keyfile fails loud instead of silently re-keying', () => {
  const root = freshRoot();
  vaultSet('secret://user/x', 'v', undefined, opts(root));
  writeFileSync(join(root, '.master-key'), 'not-base64-32-bytes!!', 'utf8');
  clearCustodyCache(root);
  let caught: unknown;
  assert.throws(
    () => vaultGet('secret://user/x', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_KEYFILE_CORRUPT');
});

test('store: unknown record format fails with an upgrade hint', () => {
  const root = freshRoot();
  vaultSet('secret://user/fmt', 'v', undefined, opts(root));
  const path = join(root, 'user', 'fmt.json');
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...record, format: 99 }), 'utf8');
  let caught: unknown;
  assert.throws(
    () => vaultGet('secret://user/fmt', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_FORMAT_UNKNOWN');
});

test('store: bad refs are rejected at every entry point', () => {
  const root = freshRoot();
  const cases = [
    () => vaultSet('secret://user/BAD', 'x', undefined, opts(root)),
    () => vaultGet('secret://lock/pid', opts(root)),
    () => vaultDelete('secret://user/../etc', opts(root)),
    () => vaultGet('hw-ak', opts(root)),
  ];
  for (const fn of cases) {
    let caught: unknown;
    assert.throws(fn, (error: unknown) => {
      caught = error;
      return true;
    });
    assert.equal(vaultErrorCode(caught), 'VAULT_BAD_REF');
  }
});

test('store: resolveSecretValue is the pass-through-or-resolve seam', () => {
  const root = freshRoot();
  vaultSet('secret://user/ak', 'RESOLVED-AK', undefined, opts(root));
  assert.equal(resolveSecretValue('plain-value', opts(root)), 'plain-value');
  assert.equal(resolveSecretValue('secret://user/ak', opts(root)), 'RESOLVED-AK');
  assert.equal(resolveSecretValue(undefined, opts(root)), undefined);
  let caught: unknown;
  assert.throws(
    () => resolveSecretValue('secret://user/missing', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_REF_NOT_FOUND');
});

test('store: empty plaintext is refused at the shared boundary (CLI and MCP fold here)', () => {
  const root = freshRoot();
  vaultSet('secret://user/keep', 'real-value', undefined, opts(root));
  let caught: unknown;
  assert.throws(
    () => vaultSet('secret://user/keep', '', undefined, opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_EMPTY_SECRET');
  // The previous secret survives the refused rotation.
  assert.equal(vaultGet('secret://user/keep', opts(root)).value, 'real-value');
});
