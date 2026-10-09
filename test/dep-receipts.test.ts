import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  readReceipt,
  receiptDir,
  removeReceipt,
  withDepLock,
  writeReceipt,
  type DepReceipt,
} from '../plugins/huaweicloud-core/src/dep-receipts.ts';

// Unit 3 receipts contracts, driven through the public functions against a
// temp receipt dir: round-trip, attribution-shape validation, atomic
// temp+rename writes, removal, and the PID-stale-tolerant lockfile.

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dep-receipts-'));
}

function hcloudReceipt(overrides: Partial<DepReceipt> = {}): DepReceipt {
  return {
    binary: 'hcloud',
    provisioner: 'devkit',
    path: '/tmp/fake-hcloud',
    installedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

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

test('receiptDir rides the HUAWEICLOUD_HOME convention', () => {
  const home = tempDir();
  const saved = process.env.HUAWEICLOUD_HOME;
  try {
    process.env.HUAWEICLOUD_HOME = home;
    assert.equal(receiptDir(), join(home, '.config', 'huaweicloud', 'deps'));
    delete process.env.HUAWEICLOUD_HOME;
    // Unset: the real home convention (homedir(), which follows HOME on unix).
    assert.equal(receiptDir(home), join(home, '.config', 'huaweicloud', 'deps'));
  } finally {
    if (saved === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- the lockfile ----

test('lock: a stale holder (dead pid) is taken over, never waited out', async () => {
  const dir = tempDir();
  try {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const { pid } = child;
    assert.ok(pid, 'spawned child has a pid');
    // Reap the child so the pid is verifiably dead.
    await new Promise<void>((resolve) => child.on('exit', resolve));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lock'), `${pid}\n`, 'utf8');
    const started = Date.now();
    let ran = false;
    withDepLock(() => {
      ran = true;
    }, dir);
    assert.equal(ran, true, 'withDepLock ran despite the stale lock');
    assert.ok(Date.now() - started < 2000, 'a stale lock must not block for the takeover window');
    assert.equal(existsSync(join(dir, 'lock')), false, 'the taken-over lock is released on exit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: a stale takeover renames the contender aside instead of deleting it', async () => {
  const dir = tempDir();
  try {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const { pid } = child;
    assert.ok(pid, 'spawned child has a pid');
    await new Promise<void>((resolve) => child.on('exit', resolve));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lock'), `${pid}\n`, 'utf8');
    let ran = false;
    withDepLock(() => {
      ran = true;
    }, dir);
    assert.equal(ran, true, 'the stale lock is taken over');
    assert.equal(existsSync(join(dir, 'lock')), false, 'no lock file remains');
    const artifacts = readdirSync(dir).filter((name) => name.startsWith('lock.stale.'));
    assert.ok(artifacts.length >= 1, 'the takeover renamed the stale lock aside (rename path, not rmSync)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: a live holder is not stolen within the takeover window', () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    // The lock names THIS process: a live holder mid-critical-section.
    writeFileSync(join(dir, 'lock'), `${process.pid}\n`, 'utf8');
    const windowMs = 600;
    const started = Date.now();
    let ran = false;
    withDepLock(
      () => {
        ran = true;
      },
      dir,
      windowMs,
    );
    const elapsed = Date.now() - started;
    assert.equal(ran, true, 'the lock is acquired only after the window');
    assert.ok(elapsed >= 500, `a live holder must be waited out, not stolen (${elapsed}ms)`);
    assert.equal(existsSync(join(dir, 'lock')), false, 'the lock is released after the takeover');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: a live foreign holder is waited out, then taken over after it dies', async () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    const lockFile = join(dir, 'lock');
    // The real holder is a grandchild that writes the lock with its own pid
    // and lives 1500ms. The helper spawned here reaps it synchronously the
    // moment it exits (spawnSync), so the pid flips verifiably dead while
    // this test's event loop is blocked inside withDepLock — a direct child
    // would stay a zombie instead (the blocked loop never reaps), and the
    // takeover would only ever fire via the deadline path.
    const inner = `require('fs').writeFileSync(${JSON.stringify(lockFile)}, process.pid + '\\n'); setTimeout(() => {}, 1500)`;
    const helperScript = `require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}]); setTimeout(() => {}, 500)`;
    const child = spawn(process.execPath, ['-e', helperScript]);
    assert.ok(child.pid, 'spawned helper has a pid');
    // Wait until the lock names a holder that is verifiably alive RIGHT NOW,
    // so the acquire below starts inside the live window.
    let holder = 0;
    const waitDeadline = Date.now() + 10_000;
    while (Date.now() < waitDeadline) {
      if (existsSync(lockFile)) {
        const pid = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== child.pid) {
          try {
            process.kill(pid, 0);
            holder = pid;
            break;
          } catch {}
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(holder > 0, 'the holder never wrote a live lock');
    const started = Date.now();
    let ran = false;
    withDepLock(() => {
      ran = true;
    }, dir);
    const elapsed = Date.now() - started;
    assert.equal(ran, true);
    assert.ok(elapsed >= 400, `expected to wait for the live holder, took ${elapsed}ms`);
    assert.ok(
      elapsed < 10_000,
      `the takeover must come from the dead-pid check, not the 90s deadline (took ${elapsed}ms)`,
    );
    assert.equal(existsSync(lockFile), false, 'the lock is released after the critical section');
    child.kill();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: same-process re-entry recurses instead of deadlocking', () => {
  const dir = tempDir();
  try {
    let inner = false;
    withDepLock(() => {
      withDepLock(() => {
        inner = true;
      }, dir);
    }, dir);
    assert.equal(inner, true);
    assert.equal(existsSync(join(dir, 'lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The verified-claim regression pin: two real contender processes against a
// pre-seeded dead lock must never hold the critical section at the same
// time. Before the verification, a waiter that read the dead pid could lose
// the interleave to another taker (which renamed the dead lock aside and
// wx-wrote its own live lock) and then rename that LIVE lock aside — both
// contenders "held" and their sections overlapped. Each contender records
// its enter/leave timestamps to its own file; the sections must not overlap.
test('lock: two contenders against a dead lock never overlap critical sections', async () => {
  const receiptsModule = fileURLToPath(new URL('../plugins/huaweicloud-core/src/dep-receipts.ts', import.meta.url));
  const contenderScript = `
const mod = await import(process.argv[1]);
const fs = await import('node:fs');
const [dir, timingsFile, sentinel, readyFile] = process.argv.slice(2);
fs.writeFileSync(readyFile, 'ready');
// Busy-wait so both contenders leave the barrier within microseconds: the
// takeover race (read the dead pid → rival completes its own takeover →
// rename) only interleaves when both are in acquireLock at the same moment.
while (!fs.existsSync(sentinel)) {}
mod.withDepLock(() => {
  const start = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  fs.writeFileSync(timingsFile, JSON.stringify({ start, end: Date.now() }));
}, dir, 15000);
`;
  const rounds = 12;
  const overlapped: string[] = [];
  for (let round = 0; round < rounds; round++) {
    const dir = tempDir();
    try {
      const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
      const deadPid = dead.pid;
      assert.ok(deadPid, 'spawned child has a pid');
      await new Promise<void>((resolve) => dead.on('exit', resolve));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'lock'), `${deadPid}\n`, 'utf8');
      const sentinel = join(dir, 'go');
      const timingsFiles = [join(dir, 'a.json'), join(dir, 'b.json')];
      const readyFiles = [join(dir, 'ready-a'), join(dir, 'ready-b')];
      const contenders = timingsFiles.map((timingsFile, i) =>
        spawn(
          process.execPath,
          ['--input-type=module', '-e', contenderScript, receiptsModule, dir, timingsFile, sentinel, readyFiles[i]],
          { stdio: 'pipe' },
        ),
      );
      const readyDeadline = Date.now() + 10_000;
      while (Date.now() < readyDeadline && !(existsSync(readyFiles[0]) && existsSync(readyFiles[1]))) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(existsSync(readyFiles[0]) && existsSync(readyFiles[1]), 'a contender never reached the barrier');
      writeFileSync(sentinel, 'go', 'utf8');
      const codes = await Promise.all(
        contenders.map((child) => new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))),
      );
      assert.deepEqual(codes, [0, 0], `round ${round}: both contenders exited cleanly`);
      const sections = timingsFiles.map((file) => {
        assert.ok(existsSync(file), `round ${round}: no timings file at ${file}`);
        return JSON.parse(readFileSync(file, 'utf8')) as { start: number; end: number };
      });
      const [a, b] = sections;
      if (a.start < b.end && b.start < a.end) {
        overlapped.push(`round ${round}: a=[${a.start},${a.end}] b=[${b.start},${b.end}]`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(
    overlapped,
    [],
    `critical sections overlapped (the live lock was stolen):\n${overlapped.join('\n')}`,
  );
});

test(
  'lock: an unreaped zombie holder is taken over, not waited out',
  { skip: process.platform !== 'linux' },
  async () => {
    const dir = tempDir();
    try {
      mkdirSync(dir, { recursive: true });
      const lockFile = join(dir, 'lock');
      // The holder writes the lock with its own pid and exits at a fixed
      // offset. This test process is blocked inside withDepLock when that
      // happens, so it can never reap the child: kill(pid, 0) keeps succeeding
      // against the zombie while /proc/<pid>/stat shows state Z. Without the
      // /proc check the lock reads as live and the takeover waits out the
      // whole window.
      const holder = spawn(process.execPath, [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(lockFile)}, process.pid + '\\n'); setTimeout(() => process.exit(0), 1500)`,
      ]);
      assert.ok(holder.pid, 'spawned holder has a pid');
      let sawLiveHolder = false;
      const waitDeadline = Date.now() + 10_000;
      while (Date.now() < waitDeadline) {
        if (existsSync(lockFile)) {
          try {
            process.kill(holder.pid!, 0);
            sawLiveHolder = true;
            break;
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(sawLiveHolder, 'the holder never wrote a live lock');
      const started = Date.now();
      let ran = false;
      withDepLock(
        () => {
          ran = true;
        },
        dir,
        5000,
      );
      const elapsed = Date.now() - started;
      assert.equal(ran, true, 'the zombie-held lock is taken over');
      assert.ok(elapsed < 4000, `the zombie holder must not be waited out (took ${elapsed}ms of the 5000ms window)`);
      assert.equal(existsSync(lockFile), false, 'the lock is released after the critical section');
      holder.kill();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
