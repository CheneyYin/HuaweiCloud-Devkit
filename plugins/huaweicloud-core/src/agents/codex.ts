// The Codex agent module, extracted from setup-cli.ts: the codex CLI
// marketplace/plugin lifecycle (including the pre-fix telemetry-sibling
// healing), the Codex Desktop plugin-dir deploy with its personal-marketplace
// registration, and the shared .mcp.json + .codex-plugin manifest writer
// (also used by OpenClaw's deploy).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { codexDesktopPluginsDir, codexMarketplacePath } from '../targets.ts';
import { resolvePacksFlag } from '../packs-policy.ts';
import { codexPluginProbe, getCodexPluginName, getMarketplaceName } from '../codex-probe.ts';
import { asRecord } from '../lib/as-record.ts';
import {
  PACKAGE_ROOT,
  PLUGIN_ROOT,
  copyDir,
  copyServerPayload,
  deployWord,
  installRuntimeDeps,
  mcpServerInstalled,
  payloadStatusLines,
  pruneStale,
  removeHuaweiCommandsFrom,
  removeIfExists,
  type DeployMode,
} from '../install-payload.ts';
import { backupDeltaFromMcpServersFile, writeMcpServersFile } from '../mcp-config-io.ts';

export function hasCodexCLI(): boolean {
  const r = spawnSync('codex --version', [], { shell: true, windowsHide: true, stdio: 'pipe', timeout: 5000 });
  if (r.status === 0 && r.stdout && r.stdout.toString().includes('codex')) return true;
  // WindowsApps codex.exe may fail with "Access is denied"
  // Fallback: check if codex exists on PATH via where.exe
  if (process.platform === 'win32') {
    const w = spawnSync('where.exe', ['codex'], { windowsHide: true, stdio: 'pipe', timeout: 5000 });
    if (w.status === 0 && w.stdout.toString().trim()) return true;
  }
  return false;
}

// Pre-resolvePluginDir payloads wrote their telemetry stamps to the codex
// plugin cache's version PARENT (see resolvePluginDir in telemetry.ts): the
// stray 'telemetry' sibling then wins codex's version-dir scan — `codex
// plugin list` reports version "telemetry" and no session loads the plugin's
// manifest or .mcp.json. Only entries this allowlist proves ours are swept;
// anything else is left untouched with a warning that names the consequence.
const CODEX_TELEMETRY_STAMP_FILES = new Set([
  'install-stamp',
  'install-counter',
  'dau-stamp',
  'first-use-stamp',
  'hook-events.jsonl',
  'hook-events.jsonl.processing',
  'telemetry-debug.log',
]);

function sweepCodexCacheTelemetrySibling(): void {
  const stray = join(
    process.env.CODEX_HOME || join(homedir(), '.codex'),
    'plugins',
    'cache',
    getMarketplaceName(),
    getCodexPluginName(),
    'telemetry',
  );
  if (!existsSync(stray)) return;
  try {
    const entries = readdirSync(stray);
    // An EMPTY dir is swept unconditionally: it is ours by location (this
    // path is scoped to our own marketplace/plugin cache namespace, where
    // codex only ever creates version-named dirs; an empty dir there has
    // no content to lose and poisons codex's version scan exactly like a
    // full one). entries.every is vacuously true for it — and that shape is
    // reachable from a crashed prior sweep (rmSync deleting entries, then
    // killed before the dir), so requiring non-emptiness would permanently
    // disable the healing for that cache.
    const provablyOurs = entries.every(
      (name) => CODEX_TELEMETRY_STAMP_FILES.has(name) && statSync(join(stray, name)).isFile(),
    );
    if (!provablyOurs) {
      console.log(
        `  \x1b[33mPre-fix telemetry sibling present but not provably ours — codex cannot load the plugin while it exists.\x1b[0m`,
      );
      console.log(`  \x1b[33mInspect and remove it manually: rm -rf "${stray}"\x1b[0m`);
      return;
    }
    rmSync(stray, { recursive: true, force: true });
    console.log(`  Healed pre-fix telemetry sibling: ${stray}`);
  } catch {
    // unreadable content is not provably ours; leave it and say what that means
    console.log(
      `  \x1b[33mPre-fix telemetry sibling present but unreadable — codex cannot load the plugin while it exists.\x1b[0m`,
    );
    console.log(`  \x1b[33mInspect and remove it manually: rm -rf "${stray}"\x1b[0m`);
  }
}

// One spawn+print shape for every `codex plugin …` / `codex plugin
// marketplace …` call: output (stdout, else stderr) is echoed either way so
// the transcript shows what the CLI answered even on failure.
function runCodexCliCommand(command: string): SpawnSyncReturns<string> {
  const r = spawnSync(command, [], { shell: true, windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
  console.log(`  ${r.stdout ? r.stdout.toString().trim() : r.stderr.toString().trim()}`);
  return r;
}

export function installCodex(): boolean {
  // --packs has no write path here: the codex CLI owns this target's MCP
  // config. Say so once and continue; the install itself is unaffected.
  if (resolvePacksFlag().kind !== 'unset') {
    console.log('  \x1b[33mcodex target is managed by codex CLI; set DEVKIT_PACKS in its MCP config manually\x1b[0m');
  }
  const marketplaceRoot = PACKAGE_ROOT;
  const pluginName = getCodexPluginName();
  const marketplaceName = getMarketplaceName();

  console.log(`  Registering Codex marketplace: ${marketplaceRoot}`);
  let r1 = runCodexCliCommand(`codex plugin marketplace add "${marketplaceRoot}"`);

  if (r1.status !== 0 && /already added.*different source/i.test((r1.stderr || '').toString())) {
    // A same-name marketplace registered from another source (an npm-cache
    // install being replaced by a local checkout, or the reverse) blocks the
    // add. Re-registering over it is the install intent, so remove the stale
    // registration and retry once. The plugin removal is best-effort (the
    // marketplace remove is the load-bearing step; a plugin that was never
    // installed under this name must not block the transition), and the
    // retry copies a fresh payload into the cache either way.
    console.log(`  Marketplace already registered from a different source; re-registering`);
    runCodexCliCommand(`codex plugin remove "${pluginName}@${marketplaceName}"`);
    runCodexCliCommand(`codex plugin marketplace remove "${marketplaceName}"`);
    r1 = runCodexCliCommand(`codex plugin marketplace add "${marketplaceRoot}"`);
  }

  if (r1.status !== 0 && /Access is denied/i.test((r1.stderr || '').toString())) {
    console.log(`  \x1b[33mWindowsApps codex.exe permission denied.\x1b[0m`);
    console.log(`  \x1b[33mUse: npx huaweicloud-devkit install --target codex-desktop\x1b[0m`);
    return false;
  }
  if (r1.status !== 0) {
    console.log(`  \x1b[31mCodex marketplace registration failed.\x1b[0m`);
    return false;
  }

  // Heal any pre-fix telemetry sibling before `codex plugin add` so the add
  // operates on a sane cache; the fixed payload never recreates it.
  sweepCodexCacheTelemetrySibling();

  console.log(`  Installing plugin: ${pluginName}@${marketplaceName}`);
  const r2 = runCodexCliCommand(`codex plugin add "${pluginName}@${marketplaceName}"`);

  if (r2.status !== 0 && /Access is denied/i.test((r2.stderr || '').toString())) {
    console.log(`  \x1b[33mWindowsApps codex.exe permission denied.\x1b[0m`);
    console.log(`  \x1b[33mUse: npx huaweicloud-devkit install --target codex-desktop\x1b[0m`);
    return false;
  }
  if (r2.status !== 0) {
    console.log(`  \x1b[31mCodex plugin installation failed.\x1b[0m`);
    return false;
  }

  return true;
}

export function uninstallCodex(): void {
  const pluginName = getCodexPluginName();
  const marketplaceName = getMarketplaceName();
  for (const name of new Set([pluginName, 'huaweicloud-core'])) {
    console.log(`  Removing Codex plugin: ${name}@${marketplaceName}`);
    const r = spawnSync(`codex plugin remove "${name}@${marketplaceName}"`, [], {
      shell: true,
      windowsHide: true,
      stdio: 'pipe',
    });
    console.log(`  ${r.stdout ? r.stdout.toString().trim() : r.stderr.toString().trim()}`);
  }

  for (const name of new Set([marketplaceName, 'HuaweiCloud-Devkit'])) {
    console.log(`  Removing Codex marketplace: ${name}`);
    const r2 = spawnSync(`codex plugin marketplace remove "${name}"`, [], {
      shell: true,
      windowsHide: true,
      stdio: 'pipe',
    });
    console.log(`  ${r2.stdout ? r2.stdout.toString().trim() : r2.stderr.toString().trim()}`);
    // `codex plugin remove` strips the version subtrees but leaves the
    // marketplace-keyed cache dir behind (live-verified on codex-cli
    // 0.162.1: only the empty shell survives the CLI's own cleanup); the
    // registration was ours, so its cache shell is ours to remove. Gated on
    // the remove having exited 0 — if the CLI refused (or was unable) to
    // remove the marketplace, the registration is still live and deleting
    // its cache would break a still-registered plugin. CODEX_HOME mirrors
    // the CLI's own home resolution so the cleanup follows whatever root
    // the spawned `codex plugin` commands above actually used.
    if (r2.status === 0) {
      const cacheDir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins', 'cache', name);
      if (removeIfExists(cacheDir)) {
        console.log(`  Codex plugin cache cleaned: ${name}`);
      }
    }
  }
}

export function codexStatus(): boolean {
  const probe = codexPluginProbe();
  return probe.ok && probe.installed;
}

export function ensureCodexMarketplaceEntry(): void {
  const mpPath = codexMarketplacePath();
  // The canonical plugin name: status (codexDesktopStatus), install, and
  // uninstall all derive from the same reader, so a marketplace.json rename
  // moves all three together.
  const pluginName = getCodexPluginName();
  const entry = {
    name: pluginName,
    source: { source: 'local', path: './plugins/huaweicloud-devkit' },
    policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' },
    category: 'Cloud',
  };

  let marketplace: Record<string, unknown> | null = null;
  if (existsSync(mpPath)) {
    try {
      marketplace = asRecord(JSON.parse(readFileSync(mpPath, 'utf8')));
    } catch {
      marketplace = null;
    }
  }

  if (!marketplace || !marketplace.name || !Array.isArray(marketplace.plugins)) {
    marketplace = {
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: [],
    };
  }

  const plugins: unknown[] = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const existingIdx = plugins.findIndex((p) => asRecord(p).name === pluginName);
  let changed = false;
  if (existingIdx >= 0) {
    const existing = asRecord(plugins[existingIdx]);
    if (
      asRecord(existing.source).path !== entry.source.path ||
      asRecord(existing.policy).installation !== entry.policy.installation ||
      asRecord(existing.policy).authentication !== entry.policy.authentication
    ) {
      plugins[existingIdx] = entry;
      changed = true;
    }
  } else {
    plugins.push(entry);
    changed = true;
  }

  if (changed) {
    marketplace.plugins = plugins;
    mkdirSync(dirname(mpPath), { recursive: true });
    writeFileSync(mpPath, JSON.stringify(marketplace, null, 2) + '\n');
    console.log(`  Marketplace updated: ${mpPath}`);
  } else {
    console.log(`  Marketplace unchanged: ${mpPath}`);
  }
}

export function removeCodexMarketplaceEntry(): void {
  const mpPath = codexMarketplacePath();
  if (!existsSync(mpPath)) return;
  let marketplace: Record<string, unknown>;
  try {
    marketplace = asRecord(JSON.parse(readFileSync(mpPath, 'utf8')));
  } catch {
    return;
  }
  if (!marketplace.plugins) return;
  const pluginName = getCodexPluginName();
  const plugins: unknown[] = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const before = plugins.length;
  const filtered = plugins.filter((p) => asRecord(p).name !== pluginName);
  if (filtered.length === before) return;
  marketplace.plugins = filtered;
  writeFileSync(mpPath, JSON.stringify(marketplace, null, 2) + '\n');
  console.log('  Marketplace entry removed');
}

// openclaw and codex-desktop both ship a .mcp.json plus the .codex-plugin
// manifest into their plugin dir — the codex-discoverable plugin-dir shape;
// the agentKey spells the delta-backup bucket in writeMcpServersFile.
export function writeMcpJsonAndCodexManifest(pluginDest: string, agentKey: string, mode: DeployMode): void {
  const mcpServerAbsPath = join(pluginDest, 'dist', 'mcp-server.js').replace(/\\/g, '/');
  writeMcpServersFile(pluginDest, mcpServerAbsPath, agentKey);
  const codexPluginSrc = join(PLUGIN_ROOT, '.codex-plugin');
  if (existsSync(codexPluginSrc)) {
    copyDir(codexPluginSrc, join(pluginDest, '.codex-plugin'));
    console.log(`  Plugin Manifest${deployWord(mode)} -> ${join(pluginDest, '.codex-plugin')}`);
  }
}

export function codexSectionStatus(): void {
  if (!hasCodexCLI()) {
    console.log('  \x1b[33mCodex CLI not found.\x1b[0m');
  } else {
    console.log(`  Plugin: ${codexStatus() ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  }
}

// Codex Desktop serves the payload from its own plugin dir plus a
// marketplace registration under ~/.agents/plugins/marketplace.json —
// status reports both surfaces (previously the one target cmdStatus did
// not cover at all; the release smoke had to skip its status check).
export function codexDesktopStatus(): void {
  payloadStatusLines(codexDesktopPluginsDir());
  const mpPath = codexMarketplacePath();
  if (existsSync(mpPath)) {
    try {
      const marketplace = asRecord(JSON.parse(readFileSync(mpPath, 'utf8')));
      const plugins: unknown[] = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
      // The canonical plugin name — the same derived value
      // ensureCodexMarketplaceEntry writes and removeCodexMarketplaceEntry
      // filters on (all three ride getCodexPluginName).
      const registered = plugins.some((p) => asRecord(p).name === getCodexPluginName());
      console.log(`  Marketplace: ${registered ? '\x1b[32mRegistered\x1b[0m' : '\x1b[31mNot registered\x1b[0m'}`);
    } catch {
      console.log(`  Marketplace: \x1b[31mInvalid\x1b[0m`);
    }
  } else {
    console.log(`  Marketplace: \x1b[31mNot registered\x1b[0m`);
  }
}

// Codex Desktop deploy: commands, assets, and the marketplace entry. Install
// mode additionally cleans the pre-marketplace-era install locations — update
// runs on machines already past that era.
export async function deployCodexDesktop(mode: DeployMode): Promise<void> {
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const pluginDest = codexDesktopPluginsDir();

  mkdirSync(pluginDest, { recursive: true });
  copyDir(commandsSrc, join(pluginDest, 'commands'));
  const staleCommands = mode === 'update' ? pruneStale(join(pluginDest, 'commands'), commandsSrc) : 0;
  console.log(
    `  Commands${deployWord(mode)} -> ${join(pluginDest, 'commands')}${staleCommands > 0 ? ` (removed ${staleCommands} stale)` : ''}`,
  );
  copyServerPayload(pluginDest);

  // Copy assets (icons, logos) for Codex Desktop plugin UI
  const codexAssetsSrc = join(PLUGIN_ROOT, 'assets');
  if (existsSync(codexAssetsSrc)) {
    copyDir(codexAssetsSrc, join(pluginDest, 'assets'));
    console.log(`  Assets${deployWord(mode)} -> ${join(pluginDest, 'assets')}`);
  }

  writeMcpJsonAndCodexManifest(pluginDest, 'codex-desktop', mode);

  // Register in personal marketplace (Codex discovers plugins from ~/.agents/plugins/marketplace.json)
  ensureCodexMarketplaceEntry();

  if (mode === 'install') {
    console.log('  \x1b[33m请到插件 → 个人 → HuaweiCloud DevKit → 安装\x1b[0m');

    // Clean up old install locations from pre-marketplace era. Neither
    // ~/.agents/skills nor ~/.agents/commands is removed wholesale: OpenClaw
    // installs share both, and user-authored content must survive —
    // devkit-owned skill names are reconciled precisely by
    // cleanupNativeDirs() at the command level. The plugin dir itself IS
    // OpenClaw's live install location (openclawPluginsDir is the same
    // path), so the cleanup fires only when no server payload lives there —
    // a live OpenClaw install must survive a codex-desktop install. Known
    // trade-off: a genuine pre-marketplace devkit install in that dir also
    // carried a payload and is now indistinguishable from a live OpenClaw
    // install, so it is deliberately left in place (destroying it is
    // irreversible; doctor's stale-tree check flags hollow trees); a
    // payload-less dir is unambiguous residue and still goes.
    const legacyPluginsDir = join(homedir(), '.agents', 'huaweicloud-plugins');
    if (existsSync(legacyPluginsDir) && !mcpServerInstalled(legacyPluginsDir)) {
      removeIfExists(legacyPluginsDir);
      console.log('  Cleaned old install location');
    }
  }

  installRuntimeDeps(pluginDest);
}

export function uninstallCodexDesktop(): void {
  const pluginDest = codexDesktopPluginsDir();
  // The whole plugin dir (server + safety + skills) is removed below; the
  // skills inside it are server data, not native agent skills.
  const cmdRemoved = removeHuaweiCommandsFrom(join(pluginDest, 'commands'));
  if (cmdRemoved > 0) console.log(`  Removed ${cmdRemoved} commands`);

  backupDeltaFromMcpServersFile(pluginDest, 'codex-desktop');
  if (removeIfExists(pluginDest)) {
    console.log('  Removed MCP server and safety policy');
  }
  removeCodexMarketplaceEntry();

  // Clean up Codex plugin cache
  const cacheDir = join(homedir(), '.codex', 'plugins', 'cache', 'personal', 'huaweicloud-devkit');
  if (removeIfExists(cacheDir)) {
    console.log('  Codex plugin cache cleaned');
  }

  // Clean up old config.toml section from pre-marketplace era
  const configPath = join(homedir(), '.codex', 'config.toml');
  if (existsSync(configPath)) {
    const lines = readFileSync(configPath, 'utf8').split(/\r?\n/);
    const out: string[] = [];
    let skip = false;
    for (const line of lines) {
      if (/^\[mcp_servers\.huaweicloud-devkit(\]|\.)/.test(line)) {
        skip = true;
        continue;
      }
      if (skip && line.startsWith('[')) skip = false;
      if (!skip) out.push(line);
    }
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    writeFileSync(configPath, out.join('\n') + (out.length > 0 ? '\n' : ''));
  }
}
