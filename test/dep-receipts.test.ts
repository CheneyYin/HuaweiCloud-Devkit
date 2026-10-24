import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { hcloudReceipt, tempDir } from './dep-receipts-helpers.ts';
import { readReceipt, removeReceipt, writeReceipt, type DepReceipt } from '../plugins/huaweicloud-core/src/dep/receipts.ts';

test('receipts: write then read round-trips the receipt', () => {
  const dir = tempDir();
  try {
    const receipt = hcloudReceipt({ path: '/opt/hcloud', installedAt: '2026-01-02T03:04:05.000Z' });
    writeReceipt(receipt, dir);
    assert.deepEqual(readReceipt('hcloud', dir), receipt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipts: gateway tier survives the round-trip', () => {
  const dir = tempDir();
  try {
    const receipt: DepReceipt = {
      binary: 'open-mcp-gateway',
      provisioner: 'devkit',
      tier: 'pipx',
      installedAt: '2026-01-02T03:04:05.000Z',
    };
    writeReceipt(receipt, dir);
    assert.deepEqual(readReceipt('open-mcp-gateway', dir), receipt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipts: a write lands as one whole file, leaving no temp residue', () => {
  const dir = tempDir();
  try {
    writeReceipt(hcloudReceipt({ path: '/first' }), dir);
    writeReceipt(hcloudReceipt({ path: '/second' }), dir);
    // The lock is released when the critical section ends, so the dir holds
    // exactly the receipt file — a leftover .tmp or lock would mean the
    // temp+rename shape regressed to an in-place write.
    assert.deepEqual(readdirSync(dir), ['hcloud.json']);
    assert.equal(readReceipt('hcloud', dir)?.path, '/second');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipts: a crashed temp file never reads as a receipt', () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hcloud.json.99999.123456.tmp'), '{"binary":"hcloud","provisioner":"devk', 'utf8');
    assert.equal(readReceipt('hcloud', dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipts: read returns null for missing, corrupt, or foreign records', () => {
  const dir = tempDir();
  try {
    assert.equal(readReceipt('hcloud', dir), null);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hcloud.json'), '{not json', 'utf8');
    assert.equal(readReceipt('hcloud', dir), null);
    writeFileSync(
      join(dir, 'hcloud.json'),
      JSON.stringify({ binary: 'hcloud', provisioner: 'user', installedAt: 'x' }),
      'utf8',
    );
    assert.equal(readReceipt('hcloud', dir), null, 'a foreign provisioner is not devkit attribution');
    writeFileSync(
      join(dir, 'hcloud.json'),
      JSON.stringify({ binary: 'open-mcp-gateway', provisioner: 'devkit', installedAt: 'x' }),
      'utf8',
    );
    assert.equal(readReceipt('hcloud', dir), null, 'a receipt naming another binary is not hcloud attribution');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipts: remove deletes the receipt and tolerates a missing one', () => {
  const dir = tempDir();
  try {
    writeReceipt(hcloudReceipt(), dir);
    removeReceipt('hcloud', dir);
    assert.equal(readReceipt('hcloud', dir), null);
    removeReceipt('hcloud', dir);
    assert.equal(existsSync(join(dir, 'hcloud.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipts: devbridge can never carry a receipt', () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => writeReceipt({ binary: 'devbridge', provisioner: 'devkit', installedAt: 'x' }, dir),
      /sandbox-resident/,
    );
    assert.equal(readReceipt('devbridge', dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
