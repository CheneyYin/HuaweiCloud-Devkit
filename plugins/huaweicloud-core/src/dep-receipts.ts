import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEPENDENCIES, type DependencyId } from './lib/dependency-model.ts';

// Install receipts: the uninstall half's ground truth for "this devkit placed
// that binary". A receipt exists only for a binary this devkit installed and
// verified, so `dep uninstall` can remove exactly what it placed and never a
// user-managed binary. The receipt directory rides the repo's shared home
// convention (HUAWEICLOUD_HOME || homedir() → ~/.config/huaweicloud/), the
// same rule as mcp-config-backup.ts, update-check.ts, and officeace-paths.ts.
//
// Receipts are single-phase on purpose: the receipt is written ONLY after the
// installing run verified the binary landed. A pending/two-phase scheme (mark
// intent, install, confirm) was reviewed and rejected: a receipt that
// survives a crash cannot distinguish devkit's half-install from the user's
// own install, and devkit must never claim what it did not place. Crash
// recovery needs no reconciliation — a crashed install left no receipt, so a
// later uninstall simply refuses and points at the documented escape hatch.
//
// Receipt mutations and the uninstall decision serialize on a lockfile in the
// receipt dir: PID-based holder detection with process-liveness checks, so a
// stale lock (holder crashed) is taken over instead of blocking forever, and
// the lock is removed when the critical section ends. Concurrent
// install+uninstall converges: worst case the install re-places the binary
// after an uninstall completed.
//
// Every function takes the receipt dir as an optional parameter (defaulting
// to the real convention) so tests run against a temp directory — the same
// injectability pattern as mcp-config-backup.ts's base parameter.

export interface DepReceipt {
  binary: DependencyId;
  provisioner: 'devkit';
  /** Gateway installs record the tier that placed them (tier-aware uninstall). */
  tier?: 'uv' | 'pipx' | 'pip3';
  /** The path devkit placed (hcloud); gateway installs record the tier instead. */
  path?: string;
  installedAt: string;
}

export function receiptDir(base: string = process.env.HUAWEICLOUD_HOME || homedir()): string {
  return join(base, '.config', 'huaweicloud', 'deps');
}

function receiptPath(id: DependencyId, dir: string): string {
  return join(dir, `${id}.json`);
}

// A record that does not attribute the binary to this devkit (wrong id,
// foreign provisioner, missing timestamp) reads as absent: uninstall then
// refuses rather than deleting something it cannot claim.
export function readReceipt(id: DependencyId, dir: string = receiptDir()): DepReceipt | null {
  const file = receiptPath(id, dir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.binary !== id || record.provisioner !== 'devkit' || typeof record.installedAt !== 'string') {
      return null;
    }
    const receipt: DepReceipt = { binary: id, provisioner: 'devkit', installedAt: record.installedAt };
    if (record.tier === 'uv' || record.tier === 'pipx' || record.tier === 'pip3') receipt.tier = record.tier;
    if (typeof record.path === 'string' && record.path.length > 0) receipt.path = record.path;
    return receipt;
  } catch {
    return null;
  }
}

// Atomic write (temp file + rename, the update-check.ts skip-state pattern):
// a reader never observes a half-written receipt, and a crash mid-write
// leaves only a stray .tmp, never a corrupt <id>.json.
export function writeReceipt(receipt: DepReceipt, dir: string = receiptDir()): void {
  if (DEPENDENCIES[receipt.binary]?.kind === 'sandbox-resident') {
    throw new Error(`${receipt.binary} is sandbox-resident; the host never manages it, so it cannot carry a receipt`);
  }
  withDepLock(() => {
    mkdirSync(dir, { recursive: true });
    const file = receiptPath(receipt.binary, dir);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  }, dir);
}

export function removeReceipt(id: DependencyId, dir: string = receiptDir()): void {
  withDepLock(() => {
    rmSync(receiptPath(id, dir), { force: true });
  }, dir);
}

// ---------------------------------------------------------------------------
// The lockfile. Sync critical sections only: the uninstall decision and the
// receipt mutations are plain fs operations, so the guard is a plain sync
// function. Same-process re-entry (an uninstall body calling removeReceipt)
// recurses instead of deadlocking on its own lock.
// ---------------------------------------------------------------------------

const LOCK_FILE = 'lock';
const LOCK_POLL_MS = 50;
// A live holder doing real work is waited out; a holder wedged past this
// window is taken over anyway — the guard must never block forever. The
// window must exceed the longest critical section (the tier uninstall's
// 60s spawnSync) plus resolution margin, or a legitimate holder still
// inside its section gets its lock taken over mid-flight.
const LOCK_TAKEOVER_MS = 90_000;

const lockDepth = new Map<string, number>();
const heldDirs = new Set<string>();
let exitCleanupInstalled = false;

function lockPath(dir: string): string {
  return join(dir, LOCK_FILE);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user. ESRCH: dead.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readHolderPid(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function acquireLock(dir: string, takeoverMs: number = LOCK_TAKEOVER_MS): void {
  mkdirSync(dir, { recursive: true });
  const file = lockPath(dir);
  const deadline = Date.now() + takeoverMs;
  for (;;) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readHolderPid(file);
    if (holder !== null && isPidAlive(holder) && Date.now() < deadline) {
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    // Stale (dead or unparsable holder) or wedged past the takeover window.
    // The takeover is an atomic rename, never an rmSync: an unconditional
    // delete let two expired waiters remove each other's LIVE lock and both
    // hold. rename(2) claims the contender's file; ENOENT means another
    // taker won the same race — loop straight back to the wx attempt. The
    // renamed file is left as a <lock>.stale.<pid>.<ts> orphan on purpose:
    // nothing ever reads it as a lock (only the exact `lock` path is), and
    // it records that a takeover happened.
    const stale = `${file}.stale.${process.pid}.${Date.now()}`;
    try {
      renameSync(file, stale);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

// Remove the lock only while it still names this process: another taker may
// have already replaced it after our takeover window expired.
function releaseLock(dir: string): void {
  const file = lockPath(dir);
  if (readHolderPid(file) === process.pid) rmSync(file, { force: true });
}

function installExitCleanup(): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  // finally blocks do not run through process.exit(); this is the safety net.
  process.on('exit', () => {
    for (const dir of heldDirs) releaseLock(dir);
  });
}

export function withDepLock<T>(fn: () => T, dir: string = receiptDir(), takeoverMs: number = LOCK_TAKEOVER_MS): T {
  const depth = lockDepth.get(dir) ?? 0;
  if (depth > 0) {
    lockDepth.set(dir, depth + 1);
    try {
      return fn();
    } finally {
      lockDepth.set(dir, depth - 1);
    }
  }
  acquireLock(dir, takeoverMs);
  installExitCleanup();
  heldDirs.add(dir);
  lockDepth.set(dir, 1);
  try {
    return fn();
  } finally {
    lockDepth.set(dir, 0);
    releaseLock(dir);
    heldDirs.delete(dir);
  }
}
