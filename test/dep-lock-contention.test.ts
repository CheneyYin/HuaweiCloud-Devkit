import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { seedLock, tempDir } from './dep-receipts-helpers.ts';
import { receiptDir, withDepLock } from '../plugins/huaweicloud-core/src/dep/receipts.ts';

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

// ---- the lock ----

// The lock is a directory (mkdir = atomic claim) with a pid file inside.
test('lock: two contenders against a dead lock never overlap critical sections', async () => {
  // The contenders import this module from argv: a file:// URL, not a
  // native path — POSIX tolerates absolute-path import specifiers, win32
  // does not, and the URL form is the one portable specifier.
  const receiptsModule = pathToFileURL(
    fileURLToPath(new URL('../plugins/huaweicloud-core/src/dep/receipts.ts', import.meta.url)),
  ).href;
  const contenderScript = `
const mod = await import(process.argv[1]);
const fs = await import('node:fs');
const [dir, timingsFile, sentinel, readyFile] = process.argv.slice(2);
fs.writeFileSync(readyFile, 'ready');
// Busy-wait so both contenders leave the barrier within microseconds: both
// hit the seeded dead lock at the same moment, maximizing takeover pressure.
while (!fs.existsSync(sentinel)) {}
const acquireStarted = Date.now();
mod.withDepLock(() => {
  const start = Date.now();
  const waitedForLock = start - acquireStarted;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  fs.writeFileSync(timingsFile, JSON.stringify({ start, end: Date.now(), waitedForLock }));
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
      seedLock(dir, deadPid);
      const sentinel = join(dir, 'go');
      const timingsFiles = [join(dir, 'a.json'), join(dir, 'b.json')];
      const readyFiles = [join(dir, 'ready-a'), join(dir, 'ready-b')];
      const contenders = timingsFiles.map((timingsFile, i) => {
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', contenderScript, receiptsModule, dir, timingsFile, sentinel, readyFiles[i]],
          { stdio: 'pipe' },
        );
        // The round-9 CI flake arrived as a bare exit 1 with its stderr
        // discarded — a lock failure must be diagnosable from the
        // assertion alone, not from a re-run with re-wiring.
        let stderrText = '';
        if (child.stderr) {
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk: string) => {
            stderrText += chunk;
          });
        }
        return { child, stderrText: () => stderrText };
      });
      const readyDeadline = Date.now() + 10_000;
      while (Date.now() < readyDeadline && !(existsSync(readyFiles[0]) && existsSync(readyFiles[1]))) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(existsSync(readyFiles[0]) && existsSync(readyFiles[1]), 'a contender never reached the barrier');
      writeFileSync(sentinel, 'go', 'utf8');
      const codes = await Promise.all(
        contenders.map(
          ({ child }) => new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code))),
        ),
      );
      assert.deepEqual(
        codes,
        [0, 0],
        `round ${round}: both contenders exited cleanly\n${contenders
          .map((c, i) => `--- contender ${i} (exit ${codes[i]}) stderr ---\n${c.stderrText().trim() || '(empty)'}`)
          .join('\n')}`,
      );
      const sections = timingsFiles.map((file) => {
        assert.ok(existsSync(file), `round ${round}: no timings file at ${file}`);
        return JSON.parse(readFileSync(file, 'utf8')) as { start: number; end: number; waitedForLock: number };
      });
      const [a, b] = sections;
      if (a.start < b.end && b.start < a.end) {
        overlapped.push(
          `round ${round}: a.waited=${a.waitedForLock} | b.waited=${b.waitedForLock} (filesystem: see the test header)`,
        );
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

// Round-11's live reproduction: a contender whose mutation lands AFTER
// the winner's fresh claim must NOT steal it. The bare rename closed
// only the rename-vs-rename window; rename-against-fresh-mkdir stole the
// live lock (both held, ~291ms, silent). The self-validating stash read
// restores the stolen claim. This test forces the interleaving directly:
// the slow contender sleeps between its re-read and its rename — the
// stall the round-11 probe injected artificially, here deterministic.

test("lock: a stalled contender does not steal the winner's fresh claim", async () => {
  // file:// URL for the same win32-import-specifier reason as the
  // two-contenders test above.
  const receiptsModule = pathToFileURL(
    fileURLToPath(new URL('../plugins/huaweicloud-core/src/dep/receipts.ts', import.meta.url)),
  ).href;
  const fastScript = `
const mod = await import(process.argv[1]);
const fs = await import('node:fs');
const [dir, timingsFile, sentinel] = process.argv.slice(2);
while (!fs.existsSync(sentinel)) {}
mod.withDepLock(() => {
  const start = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  fs.writeFileSync(timingsFile, JSON.stringify({ start, end: Date.now() }));
}, dir, 15000);
`;
  const slowScript = `
const mod = await import(process.argv[1]);
const fs = await import('node:fs');
const [dir, timingsFile, sentinel, stallMs] = process.argv.slice(2);
while (!fs.existsSync(sentinel)) {}
// The deterministic stand-in for preemption between the passed re-read
// and the rename: the FAST contender completes its full takeover and
// enters its section while we are stalled here.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(stallMs));
mod.withDepLock(() => {
  const start = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  fs.writeFileSync(timingsFile, JSON.stringify({ start, end: Date.now() }));
}, dir, 15000);
`;
  const dir = tempDir();
  try {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid;
    await new Promise<void>((resolve) => dead.on('exit', resolve));
    mkdirSync(dir, { recursive: true });
    seedLock(dir, deadPid!);
    const sentinel = join(dir, 'go');
    const fastTimings = join(dir, 'fast.json');
    const slowTimings = join(dir, 'slow.json');
    const fast = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      fastScript,
      receiptsModule,
      dir,
      fastTimings,
      sentinel,
    ]);
    const slow = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      slowScript,
      receiptsModule,
      dir,
      slowTimings,
      sentinel,
      '250',
    ]);
    const captureStderr = (child: ReturnType<typeof spawn>): (() => string) => {
      let text = '';
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          text += chunk;
        });
      }
      return () => text;
    };
    const fastStderr = captureStderr(fast);
    const slowStderr = captureStderr(slow);
    writeFileSync(sentinel, 'go', 'utf8');
    const codes = await Promise.all(
      [fast, slow].map((child) => new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))),
    );
    assert.deepEqual(
      codes,
      [0, 0],
      `both contenders exited cleanly\n--- fast (exit ${codes[0]}) stderr ---\n${fastStderr().trim() || '(empty)'}\n--- slow (exit ${codes[1]}) stderr ---\n${slowStderr().trim() || '(empty)'}`,
    );
    const [fastSection, slowSection] = [fastTimings, slowTimings].map((file) => {
      assert.ok(existsSync(file), `no timings at ${file}`);
      return JSON.parse(readFileSync(file, 'utf8')) as { start: number; end: number };
    });
    const overlapped = fastSection.start < slowSection.end && slowSection.start < fastSection.end;
    assert.equal(
      overlapped,
      false,
      `the stalled contender stole the live lock: fast=${JSON.stringify(fastSection)} slow=${JSON.stringify(slowSection)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'lock: an unreaped zombie holder is taken over, not waited out',
  { skip: process.platform !== 'linux' },
  async () => {
    const dir = tempDir();
    try {
      mkdirSync(dir, { recursive: true });
      const lockDir = join(dir, 'lock');
      const pidFile = join(lockDir, 'pid');
      // The holder claims the lock with its own pid and exits at a fixed
      // offset. This test process is blocked inside withDepLock when that
      // happens, so it can never reap the child: kill(pid, 0) keeps succeeding
      // against the zombie while /proc/<pid>/stat shows state Z. Without the
      // /proc check the lock reads as live and the takeover waits out the
      // whole window.
      const holder = spawn(process.execPath, [
        '-e',
        `require('fs').mkdirSync(${JSON.stringify(lockDir)}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n'); setTimeout(() => process.exit(0), 1500)`,
      ]);
      assert.ok(holder.pid, 'spawned holder has a pid');
      let sawLiveHolder = false;
      const waitDeadline = Date.now() + 10_000;
      while (Date.now() < waitDeadline) {
        if (existsSync(pidFile)) {
          try {
            process.kill(holder.pid!, 0);
            sawLiveHolder = true;
            break;
          } catch {
            // holder not alive yet: keep polling for the live holder window
          }
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
      assert.equal(existsSync(lockDir), false, 'the lock is released after the critical section');
      holder.kill();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
