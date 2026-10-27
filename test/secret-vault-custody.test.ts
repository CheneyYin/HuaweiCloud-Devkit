import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fakeKeychainSpawn, freshRoot, opts, vaultErrorCode } from './secret-vault-helpers.ts';
import {
  clearCustodyCache,
  custodyReport,
  ensureMasterKey,
  resolveMasterKey,
  VaultCustodyError,
} from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { vaultGet, vaultSet, VaultError } from '../plugins/huaweicloud-core/src/lib/secret-vault/store.ts';

test('custody: env tier resolves a strict 32-byte key and rejects everything else', () => {
  const root = freshRoot();
  const previous = process.env.HW_VAULT_MASTER_KEY;
  try {
    const key = Buffer.alloc(32, 7);
    process.env.HW_VAULT_MASTER_KEY = key.toString('base64');
    const resolved = resolveMasterKey(opts(root));
    assert.equal(resolved?.tier, 'env');
    assert.equal(resolved?.key.equals(key), true);
    clearCustodyCache(root);
    process.env.HW_VAULT_MASTER_KEY = key.toString('hex');
    assert.equal(resolveMasterKey(opts(root))?.tier, 'env');
    clearCustodyCache(root);
    const invalid = ['not-a-key', Buffer.alloc(16, 1).toString('base64')];
    for (const value of invalid) {
      process.env.HW_VAULT_MASTER_KEY = value;
      let caught: unknown;
      assert.throws(
        () => resolveMasterKey(opts(root)),
        (error: unknown) => {
          caught = error;
          return true;
        },
      );
      assert.equal(vaultErrorCode(caught), 'HW_VAULT_MASTER_KEY_INVALID');
      clearCustodyCache(root);
    }
  } finally {
    if (previous === undefined) delete process.env.HW_VAULT_MASTER_KEY;
    else process.env.HW_VAULT_MASTER_KEY = previous;
    clearCustodyCache(root);
  }
});

test('custody: bootstrap converges on the keychain tier and adopts a pre-existing key', () => {
  const root = freshRoot();
  const stored: { b64?: string } = { b64: Buffer.alloc(32, 9).toString('base64') };
  const spawn = fakeKeychainSpawn(stored);
  const resolved = ensureMasterKey({ root, spawnImpl: spawn });
  assert.equal(resolved.tier, 'keychain');
  assert.equal(resolved.key.equals(Buffer.alloc(32, 9)), true);
  vaultSet('secret://user/kc', 'value-kc', undefined, { root, spawnImpl: spawn });
  const direct = resolveMasterKey({ root, spawnImpl: spawn });
  assert.equal(direct?.tier, 'keychain');
  assert.equal(vaultGet('secret://user/kc', { root, spawnImpl: spawn }).value, 'value-kc');
  assert.equal(existsSync(join(root, '.master-key')), false);
});

test('custody: bootstrap writes the keyfile tier when no keychain tool exists', () => {
  const root = freshRoot();
  const resolved = ensureMasterKey(opts(root));
  assert.equal(resolved.tier, 'keyfile');
  assert.equal(existsSync(join(root, '.master-key')), true);
  assert.deepEqual(custodyReport(opts(root)), { initialized: true, tier: 'keyfile' });
});

test('custody: report is honest before initialization', () => {
  const root = freshRoot();
  assert.deepEqual(custodyReport(opts(root)), { initialized: false, tier: null });
});

test('custody: a readable-but-wrong keychain decode is an error, not a silent tier skip', () => {
  const root = freshRoot();
  const stored: { b64?: string } = { b64: Buffer.alloc(8, 3).toString('base64') };
  const spawn = fakeKeychainSpawn(stored);
  let caught: unknown;
  assert.throws(
    () => resolveMasterKey({ root, spawnImpl: spawn }),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_CUSTODY_READ_FAILED');
});

test('custody: a failing backend with EXISTING records is an error, never an absent tier', () => {
  const root = freshRoot();
  const stored: { b64?: string } = { b64: Buffer.alloc(32, 5).toString('base64') };
  const healthy = fakeKeychainSpawn(stored);
  // Seed one record under the healthy backend first.
  vaultSet('secret://user/precious', 'v', undefined, { root, spawnImpl: healthy });
  clearCustodyCache(root);
  // Now the backend starts failing (daemon down / no D-Bus session).
  const spawn = fakeKeychainSpawn(stored, 'Error calling StartServiceByName for org.freedesktop.secrets');
  let caught: unknown;
  assert.throws(
    () => resolveMasterKey({ root, spawnImpl: spawn }),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(caught), 'VAULT_CUSTODY_READ_FAILED');
  // A failing tier with records to protect must not silently fall through to
  // a keyfile bootstrap: a second master key would orphan every secret.
  let setCaught: unknown;
  assert.throws(
    () => vaultSet('secret://user/x', 'v', undefined, { root, spawnImpl: spawn }),
    (error: unknown) => {
      setCaught = error;
      return true;
    },
  );
  assert.equal(vaultErrorCode(setCaught), 'VAULT_CUSTODY_READ_FAILED');
  assert.equal(existsSync(join(root, '.master-key')), false);
});

test('custody: a failing backend on a FRESH vault falls back to the keyfile tier', () => {
  const root = freshRoot();
  const stored: { b64?: string } = {};
  const spawn = fakeKeychainSpawn(stored, 'Error calling StartServiceByName for org.freedesktop.secrets');
  // No records exist: nothing can be orphaned by a fresh key, and
  // secret-tool-on-PATH-without-a-daemon is a common headless shape that
  // must not dead-end the first `secret set`.
  const result = vaultSet('secret://user/first', 'v', undefined, { root, spawnImpl: spawn });
  assert.equal(result.status, 'set');
  assert.equal(existsSync(join(root, '.master-key')), true);
  assert.equal(vaultGet('secret://user/first', { root, spawnImpl: spawn }).value, 'v');
});

test('custody: a LOST key over existing records refuses to mint a new one', () => {
  const root = freshRoot();
  // Seed under the env tier (no keyfile is written for env-tier keys).
  process.env.HW_VAULT_MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64');
  clearCustodyCache(root);
  try {
    vaultSet('secret://user/precious', 'v', undefined, opts(root));
    // Every tier now absent (env dropped, no keychain item, no keyfile).
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache(root);
    let caught: unknown;
    assert.throws(
      () => vaultSet('secret://user/new', 'v2', undefined, opts(root)),
      (error: unknown) => {
        caught = error;
        return true;
      },
    );
    assert.equal(vaultErrorCode(caught), 'VAULT_MASTER_KEY_LOST');
    // The existing record is untouched — no new key was minted over it.
    assert.equal(existsSync(join(root, '.master-key')), false);
  } finally {
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache(root);
  }
});

test('custody: VaultCustodyError is a VaultError (one catch family for consumers)', () => {
  const error = new VaultCustodyError('VAULT_CUSTODY_READ_FAILED', 'x');
  assert.ok(error instanceof VaultError);
  assert.equal(error.code, 'VAULT_CUSTODY_READ_FAILED');
});
