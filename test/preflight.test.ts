import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { fixtureDir } from './fixture-dir.ts';
import {
  _setPreinstallSpawnForTests,
  acquireInstallLock,
  maybePreinstallKooCli,
  openKooCliInstallLog,
  releaseInstallLock,
  resolvePreinstallCliEntry,
} from '../plugins/huaweicloud-core/src/preflight.ts';
import { kooCliInstallLockPath, kooCliInstallLogPath } from '../plugins/huaweicloud-core/src/lib/koocli-paths.ts';
import { findHcloudBin } from '../plugins/huaweicloud-core/src/hcloud-probe.ts';

// The preinstall paths honor HUAWEICLOUD_HOME (read at CALL time), so every
// test redirects the lock/log into a registered fixture dir — no real
// ~/.config/huaweicloud is ever touched, and no background install is ever
// spawned (the skip env is set process-wide; a real spawn would also fail
// the entry-missing branch in a fixture tree).
process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL ??= '1';

function withFixtureHome(fn: () => void): void {
  const home = fixtureDir('preflight-home-');
  const prev = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    fn();
  } finally {
    process.env.HUAWEICLOUD_HOME = prev;
  }
}

test('lock and log paths honor HUAWEICLOUD_HOME under .config/huaweicloud', () => {
  withFixtureHome(() => {
    assert.match(kooCliInstallLogPath(), /\.config[\\/]+huaweicloud[\\/]+logs[\\/]+koocli-install\.log$/);
    assert.match(kooCliInstallLockPath(), /\.config[\\/]+huaweicloud[\\/]+\.koocli-install\.lock$/);
    assert.ok(kooCliInstallLogPath().startsWith(process.env.HUAWEICLOUD_HOME!));
  });
});

test('acquireInstallLock is exclusive; release re-enables acquisition', () => {
  withFixtureHome(() => {
    const first = acquireInstallLock();
    assert.equal(first.acquired, true);
    const second = acquireInstallLock();
    assert.equal(second.acquired, false);
    assert.match(second.reason ?? '', /another process is installing/);
    releaseInstallLock();
    const third = acquireInstallLock();
    assert.equal(third.acquired, true);
    releaseInstallLock();
  });
});

test('a stale lock (past TTL) is reclaimed, a fresh lock is not', () => {
  withFixtureHome(() => {
    // A timestamp 20 minutes old (TTL is 15) reads as stale.
    mkdirSync(dirname(kooCliInstallLockPath()), { recursive: true });
    writeFileSync(kooCliInstallLockPath(), String(Date.now() - 20 * 60 * 1000), 'utf8');
    const reclaimed = acquireInstallLock();
    assert.equal(reclaimed.acquired, true);
    releaseInstallLock();
    // A fresh timestamp reads as a live installer — yield.
    writeFileSync(kooCliInstallLockPath(), String(Date.now()), 'utf8');
    const yielded = acquireInstallLock();
    assert.equal(yielded.acquired, false);
    assert.match(yielded.reason ?? '', /another process is installing/);
    releaseInstallLock();
  });
});

test('the install log is opened as a ready fd with 0600 and append semantics', () => {
  withFixtureHome(() => {
    const fd = openKooCliInstallLog();
    // Numeric fd — spawn stdio requires a ready fd; a lazily-opened
    // WriteStream throws ERR_INVALID_ARG_VALUE before the child starts.
    assert.equal(typeof fd, 'number');
    writeSync(fd, 'line\n');
    closeSync(fd);
    const mode = statSync(kooCliInstallLogPath()).mode & 0o777;
    // POSIX-only: Windows reports a writable file as 0o666 — no chmod to
    // enforce 0600 there.
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600, `log mode ${mode.toString(8)} must be 0600`);
    }
    assert.equal(readFileSync(kooCliInstallLogPath(), 'utf8'), 'line\n');
    const again = openKooCliInstallLog();
    writeSync(again, 'second\n');
    closeSync(again);
    assert.equal(readFileSync(kooCliInstallLogPath(), 'utf8'), 'line\nsecond\n');
  });
});

test('maybePreinstallKooCli is disabled by the skip env (documented intent)', () => {
  withFixtureHome(() => {
    const prev = process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL;
    process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';
    try {
      const result = maybePreinstallKooCli({ force: true });
      assert.equal(result.launched, false);
      assert.equal(result.reason, 'disabled_by_env');
      assert.ok(!existsSync(kooCliInstallLockPath()), 'skip env must not even take the lock');
    } finally {
      process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = prev;
    }
  });
});

// The preinstall-level yield (live lock → {launched:false}) is only
// reachable when findHcloudBin() misses — on dev boxes with a real hcloud
// in ~/.local/bin the probe short-circuits to 'already installed' first.
// The lock-level yield itself is pinned above; skip this on such boxes.
const realHcloudPresent = findHcloudBin() !== null;

test('maybePreinstallKooCli yields to an in-flight installer (lock-level)', { skip: realHcloudPresent }, () => {
  withFixtureHome(() => {
    const prev = process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL;
    process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = undefined as unknown as string;
    try {
      // KooCLI absent on this machine, and a live lock in place: the
      // preinstall must yield without spawning.
      mkdirSync(dirname(kooCliInstallLockPath()), { recursive: true });
      writeFileSync(kooCliInstallLockPath(), String(Date.now()), 'utf8');
      const result = maybePreinstallKooCli({ force: true });
      assert.equal(result.launched, false);
      assert.match(result.reason, /another process is installing/);
    } finally {
      process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = prev;
      releaseInstallLock();
    }
  });
});

test('maybePreinstallKooCli reports already-installed when hcloud resolves', () => {
  // A fake hcloud on HCLOUD_BIN (resolveDependencyCommand's env tier) —
  // the probe consults it before the lock is ever taken.
  const binDir = fixtureDir('preflight-bin-');
  const fake = `${binDir}/hcloud`;
  writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prevBin = process.env.HCLOUD_BIN;
  const prevSkip = process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL;
  process.env.HCLOUD_BIN = fake;
  process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = undefined as unknown as string;
  try {
    assert.equal(findHcloudBin(), fake);
    const result = maybePreinstallKooCli({ force: true });
    assert.equal(result.launched, false);
    assert.equal(result.reason, 'already installed');
  } finally {
    process.env.HCLOUD_BIN = prevBin;
    process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = prevSkip;
  }
});

test('the preinstall entry resolves to a setup-cli sibling that exists', () => {
  // In the repo the compiled dist sibling exists after a build; in a raw
  // type-stripped run the .ts fallback does. Either way the resolved
  // entry must actually exist — a missing entry is the preflight's own
  // loud-failure branch.
  const entry = resolvePreinstallCliEntry();
  assert.match(entry, /setup-cli\.(ts|js)$/);
  assert.ok(existsSync(entry), `entry must exist: ${entry}`);
});

test('the preinstall path bypasses provisionDependencies by design (explicit CI path precedent)', () => {
  // dep install <id> deliberately bypasses the TTY-gated policy loop; the
  // preinstall joins that precedent — it spawns `install-hcloud` directly
  // and must never route through provisionDependencies (non-TTY refuses
  // downloads there). Source-level pin: the spawn arg and the absence of
  // the provisioning import.
  const source = readFileSync(new URL('../plugins/huaweicloud-core/src/preflight.ts', import.meta.url), 'utf8');
  assert.match(source, /\[entryPath, 'install-hcloud'\]/);
  assert.doesNotMatch(source, /provisionDependencies/);
  assert.doesNotMatch(source, /from '\.\/dep\//);
});

// The forced spawn path is only reachable when findHcloudBin() misses —
// on dev boxes with a real hcloud the probe short-circuits first.
test(
  'forced preinstall spawns the detached child, releases the lock, and cools down on a fruitless close',
  { skip: realHcloudPresent },
  () => {
    withFixtureHome(() => {
      const prevSkip = process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL;
      process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = undefined as unknown as string;
      let closed = false;
      const children: Array<{ closed: () => void }> = [];
      _setPreinstallSpawnForTests((_cmd, args, opts) => {
        assert.deepEqual(args.slice(1), ['install-hcloud']);
        assert.equal(opts.detached, true);
        assert.ok(Array.isArray(opts.stdio) && typeof opts.stdio[1] === 'number', 'stdio must carry ready numeric fds');
        const child = {
          on(event: string, cb: (arg?: unknown) => void) {
            if (event === 'close')
              children.push({
                closed: () => {
                  closed = true;
                  cb();
                },
              });
            return child;
          },
          unref() {},
        };
        return child as never;
      });
      try {
        const result = maybePreinstallKooCli({ force: true });
        assert.equal(result.launched, true);
        assert.ok(existsSync(kooCliInstallLockPath()), 'lock held while the child runs');
        // Simulate the child closing WITHOUT producing hcloud.
        children[0]!.closed();
        assert.ok(closed);
        assert.ok(!existsSync(kooCliInstallLockPath()), 'lock released on close');
        // Fruitless close → cooldown marker blocks the next attempt.
        const second = maybePreinstallKooCli({ force: true });
        assert.equal(second.launched, false);
        assert.match(second.reason, /cooldown/);
        // one-shot flag also blocks without force
        const third = maybePreinstallKooCli();
        assert.equal(third.launched, false);
      } finally {
        _setPreinstallSpawnForTests(null);
        process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = prevSkip;
        releaseInstallLock();
      }
    });
  },
);

test('a reclaimed holder cannot release the new owner live lock (ownership check)', () => {
  withFixtureHome(() => {
    mkdirSync(dirname(kooCliInstallLockPath()), { recursive: true });
    // Holder A's lock, then a TTL reclaim by holder B.
    writeFileSync(kooCliInstallLockPath(), String(Date.now() - 20 * 60 * 1000), 'utf8');
    const reclaimed = acquireInstallLock();
    assert.equal(reclaimed.acquired, true);
    const newBody = readFileSync(kooCliInstallLockPath(), 'utf8').trim();
    // A's stale release attempt (old timestamp) must not delete B's lock.
    releaseInstallLock(kooCliInstallLockPath(), Date.now() - 20 * 60 * 1000);
    assert.ok(existsSync(kooCliInstallLockPath()), 'foreign-timestamp release must be a no-op');
    assert.equal(readFileSync(kooCliInstallLockPath(), 'utf8').trim(), newBody);
    // B's own release removes it.
    releaseInstallLock(kooCliInstallLockPath(), Number(newBody));
    assert.ok(!existsSync(kooCliInstallLockPath()));
  });
});

test('an unparseable (corrupted) lock body is reclaimed as stale', () => {
  withFixtureHome(() => {
    mkdirSync(dirname(kooCliInstallLockPath()), { recursive: true });
    writeFileSync(kooCliInstallLockPath(), 'not-a-timestamp', 'utf8');
    const result = acquireInstallLock();
    assert.equal(result.acquired, true, 'corrupted lock must be reclaimable, never a permanent wedge');
    releaseInstallLock();
  });
});

test('the preinstall child entry is a plain path and actually boots (real child exec)', () => {
  // main shipped `node file:///...` as the child argv[1] — a stillborn
  // spawn the CJS loader rejects. Pin BOTH: the resolved entry is a plain
  // absolute path, and a REAL child process boots it end-to-end (the
  // `version` subcommand exercises the CLI entry without any download).
  const entry = resolvePreinstallCliEntry();
  assert.ok(!entry.startsWith('file:'), 'child argv[1] must be a plain path, not a URL');
  assert.ok(entry.endsWith('setup-cli.js') || entry.endsWith('setup-cli.ts'));
  const run = spawnSync(process.execPath, [entry, 'version'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, `child must boot: ${run.stderr}`);
  assert.match(run.stdout, /HuaweiCloud DevKit CLI/);
});
