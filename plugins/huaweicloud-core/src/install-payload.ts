import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asText } from './lib/as-text.ts';
import {
  isCoreNameShape,
  marketplacePayloadTree,
  nativeReceiptPath,
  readNativeReceipt,
  sweepReceiptTmpFiles,
  writeNativeReceipt,
} from './lib/native-receipt.ts';
import { parseCoreSkillNames, parseSkillManifest } from './lib/skill-manifest.ts';
import { listSkillDirs } from './lib/skill-tree.ts';

// The installer's payload machinery: the file operations every per-agent
// deploy shares, the server payload (dist + safety + skills) placement, and
// the native core-skill disclosure seam. The table-consuming orchestration
// (nativeSkillDirs and friends) takes the PAYLOAD_TARGETS rows as a
// parameter so this module stays a leaf — the dispatch layer owns the table.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');

// The installed package's version — one read for the whole setup-cli graph
// (the banner, the generated plugin-dir package.json, and doctor's
// X-HW-Client-Version comparisons). Missing or corrupt package.json keeps
// the 0.0.0 default.
export const pkgVersion: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, '..', '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function spawnErrorCode(res: SpawnSyncReturns<unknown>): string | undefined {
  const error = res.error;
  if (!error || !('code' in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : undefined;
}

export function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // main-thread restriction or unavailable Atomics - fall back to a busy wait
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // spin
    }
  }
}

export function copyFileVerified(src: string, dest: string): void {
  const expected = statSync(src).size;
  for (let attempt = 1; attempt <= 3; attempt++) {
    copyFileSync(src, dest);
    let actual = -1;
    try {
      actual = statSync(dest).size;
    } catch {
      // destination missing - fall through to retry
    }
    if (actual === expected) return;
    if (attempt < 3) sleepSync(150);
  }
  throw new Error(
    `copyDir verification failed after 3 attempts: ${src} -> ${dest} (expected ${expected} bytes). ` +
      `The destination file may be locked by another process (e.g. a running agent session using the installed MCP server). ` +
      `Close it and re-run the install.`,
  );
}

export function mcpServerInstalled(baseDir: string): boolean {
  return existsSync(join(baseDir, 'dist', 'mcp-server.js')) || existsSync(join(baseDir, 'src', 'mcp-server.mjs'));
}

export function copyDir(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      copyFileVerified(s, d);
    }
  }
}

// The payload every per-agent plugin dir must carry: the MCP server (dist/),
// the safety policy, and the skills tree. Skills are server data disclosed
// through the MCP tools (list_packs / pack_info / list_skills /
// retrieve_skill / search_docs) — the stdio server instructions state the
// tree's location (skillRoot) at initialize, and list_skills carries it too
// for direct reads; the core
// meta-skills are ADDITIONALLY disclosed natively by syncNativeCoreSkills,
// so every install and update path must place the tree next to the server
// it deploys (the native sync rides the same PAYLOAD_TARGETS table from
// the dispatch layer).
export function copyServerPayload(pluginDest: string, opts: { skipDist?: boolean } = {}): void {
  if (!opts.skipDist) {
    copyDir(join(PLUGIN_ROOT, 'dist'), join(pluginDest, 'dist'));
    console.log(`  MCP Server -> ${join(pluginDest, 'dist')}`);
  }
  copyDir(join(PLUGIN_ROOT, 'safety'), join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  // A missing source tree must abort, not silently skip: copyDir's
  // existsSync guard would no-op the copy while this function still prints
  // a success line, and the installed server would then advertise skills it
  // cannot serve. Same loudness as a missing dist/.
  if (!existsSync(skillsSrc)) {
    throw new Error(
      `skills tree missing at ${skillsSrc} — the payload cannot ship without it. ` +
        'From a git checkout run: npm run build; from a broken install run: npx huaweicloud-devkit install',
    );
  }
  copyDir(skillsSrc, join(pluginDest, 'skills'));
  // The plugin dir is wholly devkit-owned: prune retired skill names so a
  // departed directory can never keep serving stale, ungated content through
  // retrieve_skill/search_docs (unclaimed dirs bypass pack enablement).
  const stale = pruneStale(join(pluginDest, 'skills'), skillsSrc);
  console.log(
    `  Skills (server data; MCP catalog + stdio skillRoot instructions) -> ${join(pluginDest, 'skills')}${stale > 0 ? ` (removed ${stale} stale)` : ''}`,
  );
  // The .installed marker means "a server payload was placed here — restart
  // the agent to activate it". It tracks PAYLOAD PLACEMENT, not overall
  // deploy success: a deploy that fails after this point (e.g.
  // installRuntimeDeps on a network failure) still swapped the on-disk
  // payload, and the restart banner is exactly what doctor should print.
  // A payload placed with skipDist ships no server, so it writes no marker —
  // nothing will ever run from that dir to consume one (the running server
  // deletes the marker at boot, mcp-server.ts).
  if (!opts.skipDist) {
    writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
  }
}

// Remove huawei* entries in targetDir that no longer exist in sourceDir (stale files from an older version).
export function pruneStale(targetDir: string, sourceDir: string): number {
  if (!existsSync(targetDir) || !existsSync(sourceDir)) return 0;
  const sourceNames = new Set(readdirSync(sourceDir));
  let removed = 0;
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('huawei')) continue;
    if (!sourceNames.has(entry.name)) {
      if (removeIfExists(join(targetDir, entry.name))) removed++;
    }
  }
  return removed;
}

export function removeIfExists(p: string): boolean {
  if (existsSync(p)) {
    try {
      // Retry transient EBUSY/EPERM/ENOTEMPTY (locked files on Windows) before
      // giving up — uninstall should not leave a skill behind just because a
      // handle was momentarily open (#556).
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (error) {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not remove ${p}: ${errorMessage(error)}`);
      return false;
    }
  }
  return false;
}

// Devkit-owned skill names. The shipped skills/ tree is the ownership
// manifest: a name is deletable only when the current tree still ships it,
// so a user-authored skill that merely shares the huawei* prefix survives
// every cleanup. Deliberately RAW directories (not the guard-side
// dir-or-symlink-with-SKILL.md listing in src/lib/skill-tree.ts): purge
// ownership wants the inclusive reading — a hollow claimed dir still owns
// its native copies.
export function devkitOwnedSkillNames(): Set<string> {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  if (!existsSync(skillsSrc)) return new Set();
  try {
    return new Set(
      readdirSync(skillsSrc, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name),
    );
  } catch {
    return new Set();
  }
}

// The expected skill roster, read from the shipped .manifest.json file rather
// than from the candidate directory listing. Doctor must not compare a
// directory against itself, so the roster of record is the file the build
// wrote beside the tree; parsing lives in src/lib/skill-manifest.ts (pure,
// unit-tested). An absent or unreadable manifest yields [] and the caller
// fails loud.
export function shippedSkillRoster(): string[] {
  const manifestPath = join(PLUGIN_ROOT, 'skills', '.manifest.json');
  if (!existsSync(manifestPath)) return [];
  return parseSkillManifest(readFileSync(manifestPath, 'utf8'));
}

// The core-pack skill names that may be disclosed natively, derived from the
// shipped manifest's packOf map (parseCoreSkillNames in the zod-free lib) —
// because this module must not import the zod-dependent packs registry.
// Null covers every unusable shape (missing tree, missing manifest,
// unparsable, no core entries): doctor warns, install/update throw via
// coreSkillNames. The loudness is load-bearing — an empty core set derived
// silently would invert the narrowed cleanup into deleting the very copies
// the sync owns.
export function tryCoreSkillNames(): Set<string> | null {
  const manifestPath = join(PLUGIN_ROOT, 'skills', '.manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return parseCoreSkillNames(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

export function coreSkillNames(): Set<string> {
  const core = tryCoreSkillNames();
  if (core === null) {
    throw new Error(
      `skills tree or manifest at ${join(PLUGIN_ROOT, 'skills')} lacks usable core-pack info ` +
        '(missing tree, missing .manifest.json, unparsable, or no core-pack entries) — the native core-skill sync refuses to guess. ' +
        'From a git checkout run: npm run build; from a broken install run: npx huaweicloud-devkit install',
    );
  }
  return core;
}

// The core roster a payload tree's own manifest discloses — the honest
// freshness roster for doctor, so a newer doctor CLI never demands a core
// skill the installed payload never shipped. Null when the payload
// manifest is absent or unusable.
export function payloadCoreNames(payloadTree: string): Set<string> | null {
  try {
    return parseCoreSkillNames(readFileSync(join(payloadTree, '.manifest.json'), 'utf8'));
  } catch {
    return null;
  }
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
