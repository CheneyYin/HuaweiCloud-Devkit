import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { asText } from './lib/as-text.ts';
import {
  isCoreNameShape,
  marketplacePayloadTree,
  nativeReceiptPath,
  readNativeReceipt,
  sweepReceiptTmpFiles,
  writeNativeReceipt,
} from './lib/native-receipt.ts';
import { listSkillDirs } from './lib/skill-tree.ts';
import { copyDir, mcpServerInstalled, removeIfExists } from './payload-files.ts';
import { coreSkillNames, devkitOwnedSkillNames } from './payload-roster.ts';
import { errorMessage, pkgVersion, PLUGIN_ROOT, sleepSync } from './payload-utils.ts';

// The installer's payload machinery: the file operations every per-agent
// deploy shares, the server payload (dist + safety + skills) placement, and
// the native core-skill disclosure seam. The table-consuming orchestration
// (nativeSkillDirs and friends) takes the PAYLOAD_TARGETS rows as a
// parameter so this module stays a leaf — the dispatch layer owns the table.
//
// Stable public face of the payload family (the safety-policy precedent):
// same exported names, same import path, same behavior. The internals live
// in the src/payload-* siblings; this module re-exports them.

// The layout roots + version + small shared utils (the one-climb root-level
// derivation, the deploy word, the error/sleep helpers).
export {
  PLUGIN_ROOT,
  PACKAGE_ROOT,
  pkgVersion,
  errorMessage,
  sleepSync,
  deployWord,
  type DeployMode,
} from './payload-utils.ts';

// The verified file operations (the retrying size-checked copy, the
// recursive dir copy, the stale-name prune, the #556 retrying removal).
export { copyFileVerified, mcpServerInstalled, copyDir, pruneStale, removeIfExists } from './payload-files.ts';

// The server-payload placement (the #758 agent-rules injection, the loud
// missing-source aborts, the `.installed` restart marker).
export { copyServerPayload } from './payload-placement.ts';

// The skills-roster readers (the ownership manifest, the expected roster,
// the core-pack name sets).
export {
  devkitOwnedSkillNames,
  shippedSkillRoster,
  tryCoreSkillNames,
  coreSkillNames,
  payloadCoreNames,
} from './payload-roster.ts';

function spawnErrorCode(res: SpawnSyncReturns<unknown>): string | undefined {
  const error = res.error;
  if (!error || !('code' in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : undefined;
}

// Place the core-pack skills into one agent-native dir and converge it:
// remove-then-copy per name (an overlay copy would keep files a newer tree
// retired), delete owned-but-not-core names and receipt names the current
// core set no longer claims, keep user skills, rewrite the receipt. Warn and
// continue on write failure — the native layer is disclosure, the MCP server
// remains the functional path, and doctor re-checks the result.
export function syncNativeCoreSkills(dir: string): void {
  const core = coreSkillNames();
  const owned = devkitOwnedSkillNames();
  const receipt = readNativeReceipt(dir);
  if (receipt?.kind === 'corrupt') {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m unreadable native receipt in ${dir} — this sync rewrites it; if it repeats, re-run install`,
    );
  }
  const remembered = receipt?.kind === 'ok' ? new Set(receipt.receipt.names) : new Set<string>();
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  // A manifest may claim core skills a partial tree does not ship; copyDir
  // would silently skip them while the receipt still claimed all names.
  // Place what exists, warn loudly about the rest, and record only what was
  // actually placed.
  const placeable = [...core].filter((name) => existsSync(join(skillsSrc, name)));
  const missing = [...core].filter((name) => !existsSync(join(skillsSrc, name)));
  if (missing.length > 0) {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m core skill(s) claimed by the manifest but missing from the tree: ${missing.join(', ')} — from a git checkout run: npm run build`,
    );
  }
  if (placeable.length === 0) {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m no core skills placeable into ${dir} — MCP disclosure remains authoritative; re-run install`,
    );
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of placeable) {
      rmSync(join(dir, name), { recursive: true, force: true });
      copyDir(join(skillsSrc, name), join(dir, name));
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const devkitClaimed = owned.has(entry.name) || remembered.has(entry.name);
      if (devkitClaimed && !core.has(entry.name)) {
        removeIfExists(join(dir, entry.name));
      }
    }
    writeNativeReceipt(dir, {
      names: [...placeable].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      layout: 'plugin-dir',
    });
    console.log(`  Core skills (native disclosure) -> ${dir}`);
  } catch (error) {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m native core skills not synced to ${dir}: ${errorMessage(error)} — ` +
        'MCP disclosure remains authoritative; re-run install',
    );
  }
}

// Skills status reads the server-data tree inside the plugin dir, mirroring
// where copyServerPayload places it. The listing is the shared SKILL.md-
// aware one (src/lib/skill-tree.ts) — the same membership the boot guard
// uses, so a hollow claimed dir (name present, SKILL.md missing) counts as
// missing here exactly as it does at boot.
export function serverSkillDirNames(pluginDir: string): string[] {
  return listSkillDirs(join(pluginDir, 'skills'));
}

export function serverSkillCount(pluginDir: string): number {
  return serverSkillDirNames(pluginDir).length;
}

export function installRuntimeDeps(pluginsDir: string): void {
  const pkgJson = {
    name: 'huaweicloud-devkit',
    version: pkgVersion,
    type: 'module',
    dependencies: { undici: '^8.10.0' },
  };
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, 'package.json'), JSON.stringify(pkgJson, null, 2));
  const spawnOpts: SpawnSyncOptions = {
    cwd: pluginsDir,
    shell: true,
    windowsHide: true,
    stdio: 'pipe',
    timeout: 120000,
  };
  let r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], spawnOpts);
  const isRetryable = (res: SpawnSyncReturns<unknown>): boolean => {
    if (res.status === 0) return false;
    const stderr = asText(res.stderr || '');
    return spawnErrorCode(res) === 'EPERM' || spawnErrorCode(res) === 'EBUSY' || /EPERM|EBUSY/.test(stderr);
  };
  if (r.status !== 0 && isRetryable(r)) {
    console.log(`  \x1b[33m[WARN]\x1b[0m npm install hit file-lock error, retrying in 2s...`);
    sleepSync(2000);
    r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], spawnOpts);
  }
  if (r.status !== 0 && !isRetryable(r)) {
    console.log(`  \x1b[33m[RETRY]\x1b[0m npm install failed (exit ${r.status}), retrying in 3s...`);
    sleepSync(3000);
    r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], spawnOpts);
  }
  const undiciDir = join(pluginsDir, 'node_modules', 'undici');
  if (r.status === 0 && existsSync(undiciDir)) {
    console.log(`  Runtime deps installed -> ${join(pluginsDir, 'node_modules')}`);
  } else {
    const errCode = spawnErrorCode(r);
    const err = (r.stderr || '').toString().trim().split(/\r?\n/).slice(-2).join(' ');
    const hint = errCode === 'ENOENT' ? ' (npm not found — ensure Node.js/npm is in PATH)' : '';
    const msg = `npm install failed in ${pluginsDir}${err ? `: ${err}` : ''}${hint}`;
    console.log(`  \x1b[31m[ERROR]\x1b[0m ${msg}`);
    console.log('  Manual fix: cd %s && npm install', pluginsDir);
    if (!existsSync(undiciDir)) {
      console.log(`  \x1b[31m[ERROR]\x1b[0m undici is NOT installed. MCP server will fail to start.`);
      console.log(`  Run manually: cd "${pluginsDir}" && npm install undici@^8.10.0`);
    }
    throw new Error(msg);
  }
}

// The rows the table-consuming seam consumes: PAYLOAD_TARGETS' shape minus
// the fields the seam never reads.
export interface NativeSyncRow {
  id: string;
  nativeSkills?: () => string[];
}

// The dirs a PAYLOAD_TARGETS sync row owns — the managed set for receipt
// semantics (remembered names carry delete rights only here) and doctor's
// stale-scan exemption. Deliberately narrower than nativeSkillDirs():
// officeace's dir is scanned as a foreign surface, never managed.
export function nativeSyncDirs(rows: readonly NativeSyncRow[]): Set<string> {
  return new Set(rows.flatMap((t) => (t.nativeSkills ? t.nativeSkills() : [])));
}

// Agent-native skill directories: the surfaces agents load into their own
// system prompt. Derived from the rows' nativeSkills plus the caller's
// foreign scan dirs (officeace's dir is scanned only as a foreign surface —
// its registration face is capabilities.json, removed in 4a030c0 — never
// synced), so a future row cannot gain placement and miss the
// cleanup/doctor scan, the same single-table rule the payload checks follow.
// The codex-desktop plugin dir's skills/ is deliberately absent: that is
// server data, not a native dir.
export function nativeSkillDirs(rows: readonly NativeSyncRow[], foreignScanDirs: readonly string[]): string[] {
  return [...new Set([...rows.flatMap((t) => (t.nativeSkills ? t.nativeSkills() : [])), ...foreignScanDirs])];
}

// The native-disclosure seam: the install step table and the update
// dispatch both route through PAYLOAD_TARGETS, so a target that places
// payload refreshes its native core skills here — a target that does not
// never touches them, and a future row cannot appear in one path and miss
// the other.
export function syncNativeSkillsForTarget(rows: readonly NativeSyncRow[], target: string): void {
  const row = rows.find((t) => t.id === target);
  if (!row?.nativeSkills) return;
  for (const dir of row.nativeSkills()) syncNativeCoreSkills(dir);
}

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

// The payload triple every directory-based status section reports: server
// bundle, safety policy, skills tree. dshStatus and hermesStatus keep
// inline variants because their hook lines interleave with the triple.
export function payloadStatusLines(pluginDir: string): void {
  console.log(
    `  MCP Server: ${mcpServerInstalled(pluginDir) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  const skillCount = serverSkillCount(pluginDir);
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
}

// Remove the skills dir itself when the owned-skill removal emptied it (the
// dsh/officeace/hermes uninstalls) — an empty leftover dir is residue.
export function removeSkillsDirIfEmpty(skillsDir: string, removed: number): void {
  if (removed === 0) return;
  try {
    if (existsSync(skillsDir) && readdirSync(skillsDir).length === 0) {
      rmSync(skillsDir, { recursive: true, force: true });
      console.log(`  Removed empty skills directory: ${skillsDir}`);
    }
  } catch {
    // best-effort cleanup: an empty skills dir left behind is harmless
  }
}
