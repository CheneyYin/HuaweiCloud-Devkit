import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { seedLock, tempDir } from './dep-receipts-helpers.ts';
import { withDepLock } from '../plugins/huaweicloud-core/src/dep/receipts.ts';

test('lock: a stale holder (dead pid) is taken over, never waited out', async () => {
  const dir = tempDir();
  try {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const { pid } = child;
    assert.ok(pid, 'spawned child has a pid');
    // Reap the child so the pid is verifiably dead.
    await new Promise<void>((resolve) => child.on('exit', resolve));
    mkdirSync(dir, { recursive: true });
    seedLock(dir, pid);
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

test('lock: a dead holder takeover removes the lock directory and leaves nothing behind', async () => {
  const dir = tempDir();
  try {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const { pid } = child;
    assert.ok(pid, 'spawned child has a pid');
    await new Promise<void>((resolve) => child.on('exit', resolve));
    mkdirSync(dir, { recursive: true });
    seedLock(dir, pid);
    let ran = false;
    withDepLock(() => {
      ran = true;
    }, dir);
    assert.equal(ran, true, 'the stale lock is taken over');
    // The directory design has no rename artifacts by construction: the only
    // thing a takeover removes is the dead holder's directory itself.
    assert.deepEqual(readdirSync(dir), [], 'no lock directory and no artifacts remain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: a live holder is not stolen within the takeover window', () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    // The lock names THIS process: a live holder mid-critical-section.
    seedLock(dir, process.pid);
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
    const pidFile = join(dir, 'lock', 'pid');
    const lockDir = join(dir, 'lock');
    // The real holder is a grandchild that writes the lock with its own pid
    // and lives 1500ms. The helper spawned here reaps it synchronously the
    // moment it exits (spawnSync), so the pid flips verifiably dead while
    // this test's event loop is blocked inside withDepLock — a direct child
    // would stay a zombie instead (the blocked loop never reaps), and the
    // takeover would only ever fire via the deadline path.
    const inner = `require('fs').mkdirSync(${JSON.stringify(join(dir, 'lock'))}, {recursive: true}); require('fs').writeFileSync(${JSON.stringify(join(dir, 'lock', 'pid'))}, process.pid + '\\n'); setTimeout(() => {}, 1500)`;
    const helperScript = `require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}]); setTimeout(() => {}, 500)`;
    const child = spawn(process.execPath, ['-e', helperScript]);
    assert.ok(child.pid, 'spawned helper has a pid');
    // Wait until the lock names a holder that is verifiably alive RIGHT NOW,
    // so the acquire below starts inside the live window.
    let holder = 0;
    const waitDeadline = Date.now() + 10_000;
    while (Date.now() < waitDeadline) {
      if (existsSync(pidFile)) {
        const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== child.pid) {
          try {
            process.kill(pid, 0);
            holder = pid;
            break;
          } catch {
            // pid not alive yet: keep polling for the live holder window
          }
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
    assert.equal(existsSync(lockDir), false, 'the lock is released after the critical section');
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

// The mutual-exclusion pin: two real contender processes against a
// pre-seeded dead lock must never hold the critical section at the same
// time. History: the file+rename designs failed ~25% of rounds; the
// directory design with plain rmSync removal flaked ~30% on
// tmpfs/loaded-box runs (mechanism: both contenders pass the re-read
// against the same dead lock, and the slower mutation lands after the
// faster one's fresh claim and steals it — live-reproduced round-11).
// The fix is the self-validating rename: the takeover moves the lock to
// a stash and re-reads the stash's pid; only a stash still naming the
// judged-dead holder honors the win, and a stolen live claim is restored.
// Each contender records its enter/leave timestamps; the sections must
// not overlap.
