import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import {
  NATIVE_RECEIPT_NAME,
  nativeReceiptPath,
  readNativeReceipt,
  writeNativeReceipt,
} from '../plugins/huaweicloud-core/src/lib/native-receipt.ts';
import { fixtureDir } from './fixture-dir.ts';

// The receipt state machine is shared by the setup CLI and the DSH
// postinstall (the compiled dist copy); these units pin the boundary both
// writers rely on.
test('readNativeReceipt: absent dir and absent file read as null', () => {
  const absent = fixtureDir('hwc-receipt-absent-');
  assert.equal(readNativeReceipt(absent), null);
  const dir = fixtureDir('hwc-receipt-empty-');
  mkdirSync(dir, { recursive: true });
  assert.equal(readNativeReceipt(dir), null);
});

test('readNativeReceipt: valid receipt reads as ok with shape-validated names', () => {
  const dir = fixtureDir('hwc-receipt-ok-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    nativeReceiptPath(dir),
    JSON.stringify({ names: ['huaweicloud-core', 'steal-me', 42, 'huaweicloud-safety'] }),
  );
  const read = readNativeReceipt(dir);
  assert.ok(read?.kind === 'ok');
  assert.deepEqual(
    [...read.receipt.names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ['huaweicloud-core', 'huaweicloud-safety'],
    'only core-name-shaped entries earn delete rights',
  );
});

test('readNativeReceipt: torn JSON and shape-broken names are corrupt, never ok-empty', () => {
  const shapes = ['{"names": [torn', '{"names": null}', '{}', '["names"]', 'null'];
  for (const [i, shape] of shapes.entries()) {
    const dir = fixtureDir(`hwc-receipt-broken-${i}-`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(nativeReceiptPath(dir), shape);
    assert.deepEqual(readNativeReceipt(dir), { kind: 'corrupt' }, `shape: ${shape}`);
  }
});

test('readNativeReceipt: layout and packageRoot pass through with type validation', () => {
  const dir = fixtureDir('hwc-receipt-layout-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    nativeReceiptPath(dir),
    JSON.stringify({ names: ['huaweicloud-core'], layout: 'package-root', packageRoot: '/x/y', extra: true }),
  );
  const read = readNativeReceipt(dir);
  assert.ok(read?.kind === 'ok');
  assert.equal(read.receipt.layout, 'package-root');
  assert.equal(read.receipt.packageRoot, '/x/y');
  writeFileSync(nativeReceiptPath(dir), JSON.stringify({ names: [], layout: 7, packageRoot: 42 }));
  const wrongTypes = readNativeReceipt(dir);
  assert.ok(wrongTypes?.kind === 'ok');
  assert.equal(wrongTypes.receipt.layout, undefined);
  assert.equal(wrongTypes.receipt.packageRoot, undefined);
  // A relative packageRoot would steer doctor's comparator from an
  // attacker-controlled base: dropped, never trusted.
  writeFileSync(
    nativeReceiptPath(dir),
    JSON.stringify({ names: ['huaweicloud-core'], layout: 'package-root', packageRoot: 'relative/pkg' }),
  );
  const relative = readNativeReceipt(dir);
  assert.ok(relative?.kind === 'ok');
  assert.equal(relative.receipt.packageRoot, undefined, 'a relative packageRoot is dropped');
});

test('writeNativeReceipt: atomic rename leaves no temp file behind', () => {
  const dir = fixtureDir('hwc-receipt-write-');
  mkdirSync(dir, { recursive: true });
  writeNativeReceipt(dir, { names: ['huaweicloud-core'], layout: 'plugin-dir' });
  assert.deepEqual(readdirSync(dir), [NATIVE_RECEIPT_NAME]);
  assert.deepEqual(JSON.parse(readFileSync(nativeReceiptPath(dir), 'utf8')), {
    names: ['huaweicloud-core'],
    layout: 'plugin-dir',
  });
});
