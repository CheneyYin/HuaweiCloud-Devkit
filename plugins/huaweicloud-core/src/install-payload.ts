import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { asText } from './lib/as-text.ts';
import { listSkillDirs } from './lib/skill-tree.ts';
import { mcpServerInstalled } from './payload-files.ts';
import { pkgVersion, sleepSync } from './payload-utils.ts';

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

// The native-disclosure placement family (the rows shape, the managed and
// scanned dir derivations, the per-target dispatch, the per-dir sync).
export {
  nativeSyncDirs,
  nativeSkillDirs,
  syncNativeSkillsForTarget,
  syncNativeCoreSkills,
  type NativeSyncRow,
} from './payload-native-sync.ts';

// The native-disclosure cleanup family (the pre-install reconcile and the
// receipt-gated uninstall removals).
export { cleanupNativeDirs, removeHuaweiCommandsFrom, removeOwnedSkillsFrom } from './payload-native-clean.ts';

function spawnErrorCode(res: SpawnSyncReturns<unknown>): string | undefined {
  const error = res.error;
  if (!error || !('code' in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : undefined;
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
