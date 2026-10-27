import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';

import { freshRoot, opts, vaultErrorCode } from './secret-vault-helpers.ts';
import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { vaultDelete, vaultGet, vaultList, vaultSet } from '../plugins/huaweicloud-core/src/lib/secret-vault/store.ts';

test('store: set/get round-trips through the keyfile tier', () => {
  const root = freshRoot();
  const result = vaultSet('secret://user/hw-sk', 'SKVALUE-abc123', 'main account', opts(root));
  assert.equal(result.status, 'set');
  assert.equal(result.version, 1);
  const read = vaultGet('secret://user/hw-sk', opts(root));
  assert.equal(read.value, 'SKVALUE-abc123');
  assert.equal(read.note, 'main account');
  assert.equal(read.version, 1);
  assert.equal(existsSync(join(root, '.master-key')), true);
  const mode = statSync(join(root, '.master-key')).mode & 0o777;
  // POSIX-only: Windows reports any writable file as 0o666 — there is no
  // chmod to tighten, so the 0600 contract is unenforceable there.
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
});

test('store: idempotent set keeps the version; rotation increments it', () => {
  const root = freshRoot();
  vaultSet('secret://user/token', 'v1', undefined, opts(root));
  const again = vaultSet('secret://user/token', 'v1', undefined, opts(root));
  assert.equal(again.status, 'unchanged');
  assert.equal(again.version, 1);
  const rotated = vaultSet('secret://user/token', 'v2', undefined, opts(root));
  assert.equal(rotated.status, 'set');
  assert.equal(rotated.version, 2);
  assert.equal(vaultGet('secret://user/token', opts(root)).value, 'v2');
});

test('store: ciphertext is AAD-bound to its ref — swapping files fails decryption', () => {
  const root = freshRoot();
  vaultSet('secret://user/alpha', 'alpha-secret', undefined, opts(root));
  vaultSet('secret://user/beta', 'beta-secret', undefined, opts(root));
  const alphaPath = join(root, 'user', 'alpha.json');
  const betaPath = join(root, 'user', 'beta.json');
  writeFileSync(betaPath, readFileSync(alphaPath, 'utf8'), 'utf8');
  let caught: unknown;
  assert.throws(
    () => vaultGet('secret://user/beta', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_DECRYPT_FAILED');
  assert.equal(vaultGet('secret://user/alpha', opts(root)).value, 'alpha-secret');
});

test('store: file contents never contain the plaintext', () => {
  const root = freshRoot();
  vaultSet('secret://user/hw-ak', 'PLAINTEXT-MARKER-9f2e', undefined, opts(root));
  const raw = readFileSync(join(root, 'user', 'hw-ak.json'), 'utf8');
  assert.doesNotMatch(raw, /PLAINTEXT-MARKER-9f2e/);
  assert.match(raw, /"format": 1/);
  assert.match(raw, /"ciphertext": "/);
});

test('store: rm is count-reporting and idempotent; get then fails loud', () => {
  const root = freshRoot();
  vaultSet('secret://user/gone', 'x', undefined, opts(root));
  assert.deepEqual(vaultDelete('secret://user/gone', opts(root)), { removed: 1 });
  assert.deepEqual(vaultDelete('secret://user/gone', opts(root)), { removed: 0 });
  let caught: unknown;
  assert.throws(
    () => vaultGet('secret://user/gone', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_REF_NOT_FOUND');
});

test('store: list returns envelope metadata without decrypting, skips reserved and foreign dirs', () => {
  const root = freshRoot();
  vaultSet('secret://user/one', 'v1', 'note one', opts(root));
  vaultSet('secret://user/two', 'v2', undefined, opts(root));
  vaultSet('secret://ci/three', 'v3', undefined, opts(root));
  mkdirSync(join(root, 'lock'), { recursive: true });
  writeFileSync(join(root, 'lock', 'pid'), `${process.pid}\n`, 'utf8');
  mkdirSync(join(root, 'stash.dir'), { recursive: true });
  const listed = vaultList(undefined, opts(root));
  assert.deepEqual(
    listed.map((entry) => entry.ref),
    ['secret://ci/three', 'secret://user/one', 'secret://user/two'],
  );
  assert.equal(
    listed.every((entry) => entry.fingerprint.length === 16),
    true,
  );
  assert.equal(listed[1]!.note, 'note one');
  assert.equal(listed[1]!.version, 1);
  const scoped = vaultList('user', opts(root));
  assert.equal(scoped.length, 2);
  let caught: unknown;
  assert.throws(
    () => vaultList('BAD SCOPE', opts(root)),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_BAD_SCOPE');
});

test('store: interleaved set/get/set converges (rotation visible to readers)', () => {
  const root = freshRoot();
  vaultSet('secret://user/seq', 'one', undefined, opts(root));
  assert.equal(vaultGet('secret://user/seq', opts(root)).value, 'one');
  vaultSet('secret://user/seq', 'two', undefined, opts(root));
  assert.equal(vaultGet('secret://user/seq', opts(root)).value, 'two');
  assert.equal(vaultGet('secret://user/seq', opts(root)).version, 2);
  vaultSet('secret://user/seq', 'two', undefined, opts(root));
  assert.equal(vaultGet('secret://user/seq', opts(root)).version, 2);
});

test('store: the lock directory is released after mutations and never appears as a scope', () => {
  const root = freshRoot();
  vaultSet('secret://user/a', 'v', undefined, opts(root));
  vaultSet('secret://user/b', 'v', undefined, opts(root));
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.deepEqual(
    dirs.sort((a, b) => a.localeCompare(b)),
    ['user'],
  );
  assert.deepEqual([...new Set(vaultList(undefined, opts(root)).map((entry) => entry.scope))], ['user']);
});

test('store: secret files keep 0600 permissions', () => {
  const root = freshRoot();
  vaultSet('secret://user/perm', 'v', undefined, opts(root));
  const mode = statSync(join(root, 'user', 'perm.json')).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
  chmodSync(join(root, 'user', 'perm.json'), 0o600);
});

test('store: a record with empty ciphertext reads as an empty secret, not as corruption', () => {
  const root = freshRoot();
  const masterKey = Buffer.alloc(32, 0x44);
  process.env.HW_VAULT_MASTER_KEY = masterKey.toString('base64');
  clearCustodyCache(root);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    cipher.setAAD(Buffer.from('secret://user/empty'));
    const ciphertext = cipher.final();
    mkdirSync(join(root, 'user'), { recursive: true });
    writeFileSync(
      join(root, 'user', 'empty.json'),
      JSON.stringify({
        format: 1,
        version: 1,
        created: '2026-10-16T00:00:00.000Z',
        updated: '2026-10-16T00:00:00.000Z',
        note: '',
        fingerprint: createHmac('sha256', masterKey).update('', 'utf8').digest('hex').slice(0, 16),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }),
      'utf8',
    );
    assert.equal(vaultGet('secret://user/empty', opts(root)).value, '');
    assert.equal(vaultList(undefined, opts(root)).length, 1);
    // The record heals: a normal set over it works.
    const healed = vaultSet('secret://user/empty', 'now-real', undefined, opts(root));
    assert.equal(healed.status, 'set');
    assert.equal(vaultGet('secret://user/empty', opts(root)).value, 'now-real');
  } finally {
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache(root);
  }
});

test('store: a different-but-resolvable key refuses to overwrite an existing record', () => {
  const root = freshRoot();
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x22).toString('base64');
  clearCustodyCache(root);
  try {
    vaultSet('secret://user/guarded', 'original', undefined, opts(root));
    // A stray different env key (agent env injection) must not silently
    // re-key the record — that would destroy the last copy under the
    // original key (no version history).
    process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64');
    clearCustodyCache(root);
    let caught: unknown;
    assert.throws(
      () => vaultSet('secret://user/guarded', 'rotated', undefined, opts(root)),
      (error: unknown) => {
        caught = error;
        return true;
      },
    );
    assert.equal(vaultErrorCode(caught), 'VAULT_MASTER_KEY_MISMATCH');
    // The original value survives under the original key.
    process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x22).toString('base64');
    clearCustodyCache(root);
    assert.equal(vaultGet('secret://user/guarded', opts(root)).value, 'original');
  } finally {
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache(root);
  }
});
