import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  isCoreNameShape,
  marketplacePayloadTree,
  nativeReceiptPath,
  readNativeReceipt,
  sweepReceiptTmpFiles,
} from './lib/native-receipt.ts';
import { removeIfExists } from './payload-files.ts';
import { nativeSkillDirs, nativeSyncDirs, type NativeSyncRow } from './payload-native-sync.ts';
import { coreSkillNames, devkitOwnedSkillNames } from './payload-roster.ts';

// The native-disclosure cleanup family (the install-payload.ts internals
// split): the pre-install reconcile over every agent-native dir, and the
// receipt-gated uninstall removals (owned skills + the huawei-prefixed
// command-file sweep).

// Reconcile every agent-native dir before install/update steps run. A dir
// without a receipt is residue (pre-MCP copies or hand-placed): every owned
// name in it goes. A dir a sync row owns AND carries a receipt (even a torn
// one — the file's existence proves devkit placement) is managed: names the
// receipt no longer justifies (renamed or retired core skills, stray
// service copies) go, and the core names stay until this run's sync — or
// that target's next update — refreshes them. Deleting an installed agent's
// disclosure because a different agent was installed this run would trade a
// short staleness window (doctor flags it) for a silent capability loss.
// Receipt-remembered names earn delete rights only in a managed dir; in a
// foreign dir (officeace, a hand-copied tree) a receipt is not devkit's
// ownership memory, so owned names there are residue no matter what a
// hand-carried receipt claims.
export function cleanupNativeDirs(rows: readonly NativeSyncRow[], foreignScanDirs: readonly string[]): number {
  const core = coreSkillNames();
  const owned = devkitOwnedSkillNames();
  const syncDirs = nativeSyncDirs(rows);
  let removed = 0;
  for (const dir of nativeSkillDirs(rows, foreignScanDirs)) {
    if (!existsSync(dir)) continue;
    const receipt = readNativeReceipt(dir);
    if (receipt?.kind === 'corrupt') {
      console.log(
        `  \x1b[33m[WARN]\x1b[0m unreadable native receipt in ${dir} — core copies kept; the next install or update for this agent rewrites it`,
      );
    }
    const remembered = receipt?.kind === 'ok' ? new Set(receipt.receipt.names) : new Set<string>();
    const managed = syncDirs.has(dir) && receipt !== null;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const keep = managed && core.has(entry.name);
        if (!keep && (owned.has(entry.name) || (managed && remembered.has(entry.name)))) {
          if (removeIfExists(join(dir, entry.name))) removed++;
        }
      }
    } catch {
      // unreadable dir cannot confirm stale copies — the other dirs still get scanned
    }
  }
  return removed;
}

// Remove devkit-owned skill names from one agent-native dir (uninstall path).
// Same ownership precision as the cleanup: user skills sharing the huawei*
// prefix survive, and receipt-remembered names carry delete rights only in
// a dir a sync row owns (a receipt in a foreign dir is not devkit's
// ownership memory there). The receipt is read FIRST — its remembered names
// are the only record of retired core skills (names the current tree no
// longer ships), so consuming it must precede destroying it — and the
// receipt file goes last, whenever the dir exists at all (even a missing
// skills tree must not leave an ownership claim behind). A receipt that
// records the DSH marketplace layout names another maintainer and protects
// the copies ONLY while that maintainer is verifiably alive (the recorded
// package root still carries a payload tree — doctor's own liveness
// probe); npm removes the profile package without running any devkit
// script, and a dead maintainer's copies are residue, not disclosure.
// Crashed receipt writes leave pid-suffixed tmp files no other actor
// reclaims — they are unambiguously devkit crash residue (never
// maintainer-owned content) and go first, before any attribution return.
// A corrupt receipt cannot yield remembered names; its possible
// retired-name leftovers are listed in a warning instead of deleted (they
// may be user content in the huaweiicloud- namespace, which must survive).
// The huawei-prefixed command-file sweep shared by the OpenClaw and Codex
// Desktop uninstalls (~/.agents/commands and <plugin>/commands): every
// command file this devkit deployed carries the huawei prefix, and no
// receipt or roster exists for them — the prefix IS the ownership record.
export function removeHuaweiCommandsFrom(dir: string): number {
  let removed = 0;
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('huawei')) {
        if (removeIfExists(join(dir, entry.name))) removed++;
      }
    }
  }
  return removed;
}

export function removeOwnedSkillsFrom(dir: string, syncDirs: Set<string>, marketplaceNativeDir: string): number {
  if (!existsSync(dir)) return 0;
  // Crash residue is never maintainer-owned content: the sweep runs before
  // any attribution return, age-gated so a concurrent live writer's
  // in-flight tmp is never taken.
  sweepReceiptTmpFiles(dir);
  const owned = devkitOwnedSkillNames();
  const receipt = readNativeReceipt(dir);
  // Dir-gated to the writer: only the marketplace postinstall writes
  // package-root receipts, and it writes exclusively the one native dir the
  // caller names (the DSH marketplace layout's dir, passed by the dispatch
  // layer so this module stays target-agnostic) — a package-root receipt
  // anywhere else is hand-copied and earns nothing, the same invariant
  // doctor enforces. Liveness: the postinstall died with the package when
  // npm removed it; a root that no longer carries the payload tree (or was
  // never recorded) cannot protect anything — fall through to normal
  // removal. Multiple DSH profiles share the dir with per-profile roots
  // (last writer wins): the probe sees only the recorded root, a known
  // limitation.
  if (receipt?.kind === 'ok' && receipt.receipt.layout === 'package-root' && dir === marketplaceNativeDir) {
    const live =
      receipt.receipt.packageRoot !== undefined && existsSync(marketplacePayloadTree(receipt.receipt.packageRoot));
    if (live) {
      console.log(
        `  \x1b[33m[WARN]\x1b[0m native core skills in ${dir} belong to the DSH profile's huaweicloud-devkit package` +
          `${receipt.receipt.packageRoot ? ` (${receipt.receipt.packageRoot})` : ''} — remove or upgrade the package there; nothing removed here`,
      );
      return 0;
    }
    console.log(
      `  \x1b[33m[WARN]\x1b[0m native core skills in ${dir} were marketplace-owned, but the recorded package maintainer is gone — removing them`,
    );
  }
  const remembered = receipt?.kind === 'ok' && syncDirs.has(dir) ? new Set(receipt.receipt.names) : new Set<string>();
  let removed = 0;
  try {
    if (receipt?.kind === 'corrupt') {
      const leftovers = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && isCoreNameShape(e.name) && !owned.has(e.name))
        .map((e) => e.name);
      console.log(
        `  \x1b[33m[WARN]\x1b[0m unreadable native receipt in ${dir}` +
          `${leftovers.length > 0 ? ` — possible devkit leftover(s) left in place: ${leftovers.join(', ')}` : ''}`,
      );
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (owned.has(entry.name) || remembered.has(entry.name))) {
        if (removeIfExists(join(dir, entry.name))) removed++;
      }
    }
    removeIfExists(nativeReceiptPath(dir));
  } catch {
    // best-effort purge: an unreadable dir is skipped, removal continues elsewhere
  }
  return removed;
}
