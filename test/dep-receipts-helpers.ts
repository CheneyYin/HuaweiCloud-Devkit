// Shared fixtures for the dep receipts and lock tests, extracted from
// dep-receipts.test.ts.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DepReceipt } from '../plugins/huaweicloud-core/src/dep/receipts.ts';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dep-receipts-'));
}

export function hcloudReceipt(overrides: Partial<DepReceipt> = {}): DepReceipt {
  return {
    binary: 'hcloud',
    provisioner: 'devkit',
    path: '/tmp/fake-hcloud',
    installedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

export function seedLock(dir: string, pid: number): void {
  mkdirSync(join(dir, 'lock'), { recursive: true });
  writeFileSync(join(dir, 'lock', 'pid'), `${pid}\n`, 'utf8');
}
