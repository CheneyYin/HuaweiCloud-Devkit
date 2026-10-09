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
// Receipt mutations and the uninstall decision serialize on a lock in the
// receipt dir: a DIRECTORY claimed with mkdir (atomic, EEXIST means held)
// carrying the holder's pid. A lock is taken over only when its pid is
// verifiably dead (or wedged past a window exceeding the longest critical
// section), so a live holder's lock is never removed and no rename ever
// opens a free-path window — see the lock section below for the full design
// and the residual. Concurrent install+uninstall converges: worst case the
// install re-places the binary after an uninstall completed.
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
// The lock. Sync critical sections only: the uninstall decision and the
// receipt mutations are plain fs operations, so the guard is a plain sync
// function. Same-process re-entry (an uninstall body calling removeReceipt)
// recurses instead of deadlocking on its own lock.
//
// DESIGN: the lock is a DIRECTORY claimed with mkdir (O_EXCL semantics —
// EEXIST means someone holds it), carrying a pid file written by the holder
// AFTER the claim, into the holder's own directory, where no other process
// can observe a half-written state as stealable. A path FILE plus rename
// takeover was tried three times (unconditional rm, verified-claim rename,
// link-based restore with a post-claim re-read) and kept failing the
// two-contender mutual-exclusion test at ~25% of rounds: every rename of a
// possibly-live lock opens a free-path window in which a third claim
// overlaps the displaced holder, and the create→write gap lets a taker
// judge a just-created lock as unattributed and steal it while the creator
// is still writing. The directory design removes the class structurally:
//
//   - acquiring = mkdir; the only writer of the pid file is the holder, and
//     it writes into its OWN directory (no cross-process half-state);
//   - a lock is taken over ONLY when its pid file names a process that is
//     verifiably dead (a dead owner can never be inside its section or
//     release later) or when the takeover window expired on a wedged holder
//     (documented residual: a >90s "live" holder is assumed wedged; the
//     critical sections cap at ~60s);
//   - an EMPTY lock directory (holder between mkdir and its pid write —
//     microseconds) is unknown, never stealable: waiters poll past it;
//   - release removes the directory only while the pid file still names
//     this process, so a wedged holder releasing after a takeover cannot
//     delete the new holder's lock.
//
// Residual: pid reuse could make a dead holder's pid look alive — that only
// DELAYS a takeover past the window (bounded, converges); it can never
// cause a double hold.
// ---------------------------------------------------------------------------

const LOCK_DIR_NAME = 'lock';
const LOCK_PID_FILE = 'pid';
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

function lockDirPath(dir: string): string {
  return join(dir, LOCK_DIR_NAME);
}

function isPidAlive(pid: number): boolean {
  // kill(pid, 0) succeeds against an unreaped zombie: the holder exited but
  // its parent never waited, so the pid stays allocated and the kernel still
  // answers the signal probe. A crashed holder's lock must not be treated as
  // live for the whole takeover window, so on Linux /proc/<pid>/stat is the
  // truth (state Z means the process can never run again) and kill(pid, 0) is
  // only the fallback for other platforms and read failures.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm is parenthesized and may itself contain ')' or spaces, so the
      // state is the first field after the LAST closing paren.
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      return state !== 'Z';
    } catch {
      // Unreadable /proc (reaped pid, or an exotic mount): fall through.
    }
  }
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

// The holder's pid, read from the pid file inside its lock directory. null
// means the directory is empty (the holder is between mkdir and its pid
// write) or unreadable — unknown, which callers treat as "keep waiting",
// never as stealable.
function readHolderPid(dir: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(join(lockDirPath(dir), LOCK_PID_FILE), 'utf8').trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function acquireLock(dir: string, takeoverMs: number = LOCK_TAKEOVER_MS): void {
  mkdirSync(dir, { recursive: true });
  const lock = lockDirPath(dir);
  const deadline = Date.now() + takeoverMs;
  for (;;) {
    try {
      mkdirSync(lock);
      // Written into our OWN directory after the atomic claim: no other
      // process ever sees this file half-written, and no other process ever
      // writes it. The mkdir alone is the claim; the pid file is the
      // attribution takeovers judge on.
      writeFileSync(join(lock, LOCK_PID_FILE), `${process.pid}\n`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readHolderPid(dir);
    // An empty directory (holder mid-create, microseconds) is unknown and
    // never stealable — wait it out; a crashed creator's empty dir is
    // reclaimed only past the takeover window below.
    if (holder !== null && isPidAlive(holder) && Date.now() < deadline) {
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    if (holder === null && Date.now() < deadline) {
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    // Verified removal — the judgment above may be STALE: another taker can
    // have replaced the lock between our read and this point, and removing
    // its fresh claim would let two processes hold at once. Re-read
    // immediately before removing, and only remove when the pid still names
    // the SAME verifiably-dead holder (or the directory is still empty past
    // the window): while the dead holder's directory stands, no new claim
    // can exist — claims need the path absent — so a re-read that still
    // matches is safe to act on. A changed pid means the lock is someone
    // else's now: keep waiting.
    if (readHolderPid(dir) !== holder) {
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    rmSync(lock, { recursive: true, force: true });
  }
}

// Remove the lock only while its pid file still names this process: a
// wedged holder whose lock was taken over must not delete the new holder's.
function releaseLock(dir: string): void {
  if (readHolderPid(dir) === process.pid) rmSync(lockDirPath(dir), { recursive: true, force: true });
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
