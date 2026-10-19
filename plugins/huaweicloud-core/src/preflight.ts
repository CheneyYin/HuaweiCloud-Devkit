import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findHcloudBin } from './hcloud-probe.ts';
import { kooCliInstallLockPath, kooCliInstallLogPath } from './lib/koocli-paths.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cross-process install lock so concurrent MCP processes / sessions don't all
// spawn `install-hcloud` at cold start. A stale lock (older than TTL) is
// reclaimed; a live lock makes this process yield to the in-flight installer.
// The TTL reclaim has a known read-rm race window against a live-but-slow
// installer (machine suspend mid-download is the realistic trigger): worst
// case a second installer starts, and the installer's own per-run scratch
// dir tolerates concurrent runs — accepted heuristic, bounded by the
// failure cooldown below. Release is ownership-checked (the on-disk body
// must still be THIS holder's timestamp), so a reclaimed lock's old owner
// cannot delete the new owner's live lock.
const INSTALL_LOCK_TTL_MS = 15 * 60 * 1000;
const INSTALL_LOG_MAX_BYTES = 1024 * 1024;
// After an install attempt that closed WITHOUT producing an hcloud binary
// (stock macOS without passwordless sudo exits this way after printing
// manual instructions), back off for a day instead of re-downloading the
// pinned tarball on every session cold start.
const INSTALL_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function failureMarkerPath(): string {
  return join(dirname(kooCliInstallLockPath()), '.koocli-install.failed');
}

function lockIsStale(body: string): boolean {
  const ts = Number(body.trim());
  // Unparseable content (partial write / foreign writer) is treated as
  // stale: a corrupted lock must not disable the preinstall forever.
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > INSTALL_LOCK_TTL_MS;
}

// Atomically acquire the cross-process install lock (exclusive create). Reclaims
// a stale lock. Returns { acquired: true } or { acquired: false, reason }.
export function acquireInstallLock(lockPath: string = kooCliInstallLockPath()): { acquired: boolean; reason?: string } {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    let replace = false;
    try {
      replace = lockIsStale(String(readFileSync(lockPath, 'utf8')));
    } catch {
      // best-effort: a missing lock is simply acquired below
    }
    if (replace) {
      try {
        rmSync(lockPath, { force: true });
      } catch (error) {
        return { acquired: false, reason: `stale lock cleanup failed: ${(error as Error).message}` };
      }
    }
    writeFileSync(lockPath, String(Date.now()), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { acquired: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      acquired: false,
      reason: err.code === 'EEXIST' ? 'another process is installing' : `lock error: ${err.message}`,
    };
  }
}

// Release the lock ONLY when the on-disk body still matches this holder's
// timestamp — a holder whose lock was TTL-reclaimed must not delete the
// new owner's live lock.
export function releaseInstallLock(lockPath: string = kooCliInstallLockPath(), ownedTs?: number): void {
  try {
    if (ownedTs !== undefined) {
      const body = String(readFileSync(lockPath, 'utf8')).trim();
      if (body !== String(ownedTs)) return;
    }
    rmSync(lockPath, { force: true });
  } catch {
    // best-effort: a stuck lock file ages out via the TTL reclaim
  }
}

// Open the install log SYNCHRONOUSLY as a numeric fd — spawn's stdio
// entries must carry a ready fd (a lazily-opened WriteStream throws
// ERR_INVALID_ARG_VALUE before the child ever starts). Rotates (resets)
// once the file exceeds INSTALL_LOG_MAX_BYTES; 0600 so the path holds no
// sensitive mount-down rights for others.
export function openKooCliInstallLog(logPath: string = kooCliInstallLogPath()): number {
  try {
    const st = existsSync(logPath) ? statSync(logPath) : null;
    if (st && st.size > INSTALL_LOG_MAX_BYTES) rmSync(logPath, { force: true });
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // best-effort: rotation failure falls back to append
  }
  return openSync(logPath, 'a', 0o600);
}

// Entry that dispatches `install-hcloud` into the compiled CLI sibling,
// exactly like bin/setup.cjs — but resolved as a sibling (dist/setup-cli.js)
// so it works in copied install trees where the repo-top bin/ directory is
// absent. In dev (type-stripped) runs the .ts sibling is the fallback; the
// esbuild bundle preserves import.meta.url semantics, so dist/mcp-server.js
// resolves dist/setup-cli.js — copyServerPayload ships the whole dist/ tree.
export function resolvePreinstallCliEntry(): string {
  const compiled = join(__dirname, 'setup-cli.js');
  if (existsSync(compiled)) return compiled;
  return join(__dirname, 'setup-cli.ts');
}

// Test seam: the detached spawn is otherwise untestable without a REAL
// download. Null in production.
interface PreinstallChild {
  on(event: 'error', listener: (err: Error) => void): PreinstallChild;
  on(event: 'close', listener: (code: number | null) => void): PreinstallChild;
  unref(): void;
}
type PreinstallSpawn = (
  command: string,
  args: string[],
  options: { stdio: unknown[]; detached: boolean; windowsHide: boolean },
) => PreinstallChild;
let spawnForTests: PreinstallSpawn | null = null;

export function _setPreinstallSpawnForTests(fn: PreinstallSpawn | null): void {
  spawnForTests = fn;
}

let installStarted = false;

// Starts a one-shot background install of KooCLI when it is missing. Never
// throws and never blocks: on failure the child's output is captured in the
// log file and the session continues normally (the friendly not_found hint
// points at the log). Called ONLY on the stdio transport — the stateless
// remote runs one process per HTTP request and must not churn the lock or
// trigger unattended downloads from an unauthenticated face.
//
// Trust boundary (P4): this runs `install-hcloud` unattended, i.e. it
// downloads and executes the official HTTPS installer without checksum
// verification. Only enable on trusted networks / over HTTPS; do not bypass
// with proxies you don't control. Opt out with HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL=1.
export function maybePreinstallKooCli({ force = false } = {}): { launched: boolean; reason: string } {
  if (installStarted && !force) return { launched: false, reason: 'already_launched' };
  if (process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL === '1') {
    return { launched: false, reason: 'disabled_by_env' };
  }
  if (findHcloudBin()) {
    return { launched: false, reason: 'already installed' };
  }
  // Failure cooldown: a previous attempt that closed without producing the
  // binary (stock macOS without sudo exits 0 after printing manual
  // instructions) must not re-download on every session start.
  try {
    if (existsSync(failureMarkerPath())) {
      const ts = Number(String(readFileSync(failureMarkerPath(), 'utf8')).trim());
      if (Number.isFinite(ts) && Date.now() - ts < INSTALL_FAILURE_COOLDOWN_MS) {
        return { launched: false, reason: 'cooldown after an unsuccessful install attempt' };
      }
    }
  } catch {
    // best-effort: an unreadable marker does not block the install
  }

  const lock = acquireInstallLock();
  if (!lock.acquired) {
    return { launched: false, reason: lock.reason ?? 'lock unavailable' };
  }
  // The lock body written by THIS acquisition is the ownership token for
  // the compare-and-delete release — read it back from disk (a fresh
  // Date.now() could differ by a tick). Guarded: maybePreinstallKooCli
  // must never throw (a vanished lock degrades to an unowned release).
  let ownedTs: number | undefined;
  try {
    ownedTs = Number(String(readFileSync(kooCliInstallLockPath(), 'utf8')).trim());
    if (!Number.isFinite(ownedTs)) ownedTs = undefined;
  } catch {
    ownedTs = undefined;
  }
  const releaseOwned = () => releaseInstallLock(kooCliInstallLockPath(), ownedTs);

  installStarted = true;
  const entryPath = resolvePreinstallCliEntry();
  if (!existsSync(entryPath)) {
    releaseOwned();
    console.error(`[preflight] install entry missing: ${entryPath}`);
    return { launched: false, reason: `install entry missing: ${entryPath}` };
  }
  // argv[1] must be a plain path: `node file:///...` is NOT a valid child
  // main entry (the CJS loader path-resolves it against cwd and dies) —
  // main shipped exactly that stillborn spawn. file: URLs are only legal
  // for in-process import() (the bin/setup.cjs precedent).
  const logPath = kooCliInstallLogPath();
  let logFd: number;
  try {
    logFd = openKooCliInstallLog(logPath);
  } catch (error) {
    releaseOwned();
    return { launched: false, reason: `install log unavailable: ${(error as Error).message}` };
  }
  const finalize = (spawnError?: Error) => {
    try {
      if (spawnError) appendFileSync(logFd, `[preflight] spawn failed: ${spawnError.message}\n`);
    } catch {
      // best-effort: log write failures must never mask the release
    }
    try {
      closeSync(logFd);
    } catch {
      // best-effort: the child holds its own dup of the fd
    }
    releaseOwned();
    // Cooldown marker: an attempt that closed without producing hcloud
    // backs off for a day (the probe re-runs cheaply here).
    if (!findHcloudBin()) {
      try {
        writeFileSync(failureMarkerPath(), String(Date.now()), { encoding: 'utf8', mode: 0o600 });
      } catch {
        // best-effort: a missing marker only costs a re-attempt
      }
    }
  };
  try {
    // Numeric fds — a lazily-opened stream here throws before the child
    // starts (ERR_INVALID_ARG_VALUE).
    const child = (spawnForTests ?? spawn)(process.execPath, [entryPath, 'install-hcloud'], {
      stdio: ['ignore', logFd, logFd],
      detached: true,
      windowsHide: true,
    });
    child.unref();
    child.on('error', (err: Error) => finalize(err));
    child.on('close', () => finalize());
  } catch (error) {
    finalize(error as Error);
    return { launched: false, reason: `spawn failed: ${(error as Error).message}` };
  }
  return { launched: true, reason: 'background install started' };
}
