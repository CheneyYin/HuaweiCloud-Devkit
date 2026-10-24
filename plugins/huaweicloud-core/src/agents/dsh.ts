// The DSH agent module, extracted from setup-cli.ts: the cordis.patch.yml
// managed MCP block (with its pre-2.0 src/mcp-server.mjs migration), the
// dsh-mcp-client package detection/install, and the deploy/uninstall/status
// lifecycle.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { dshPatchFile, dshPluginsDir, dshProfileDir, dshRoot, dshSkillsDir } from '../targets.ts';
import { packsCarryValue, readDevkitPacksFromYaml } from '../packs-policy.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { asText } from '../lib/as-text.ts';
import { asRecord } from '../lib/as-record.ts';
import {
  PACKAGE_ROOT,
  PLUGIN_ROOT,
  copyServerPayload,
  deployWord,
  installRuntimeDeps,
  mcpServerInstalled,
  removeIfExists,
  removeSkillsDirIfEmpty,
  serverSkillCount,
  type DeployMode,
} from '../install-payload.ts';

export const DSH_MCP_PATCH_START = '# HuaweiCloud DevKit DSH integration start';
export const DSH_MCP_PATCH_END = '# HuaweiCloud DevKit DSH integration end';

export function dshMcpServerPath(): string {
  return join(dshPluginsDir(), 'dist', 'mcp-server.js').replace(/\\/g, '/');
}

export function dshPatchBlock(devkitPacks: string | null): string {
  const hcloudBin = findHcloudBin();
  const envLines: string[] = ['          HUAWEICLOUD_AGENT_TOOLKIT_MODE: local'];
  if (hcloudBin) {
    envLines.push(`          HCLOUD_BIN: '${hcloudBin.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  }
  if (devkitPacks !== null) {
    envLines.push(`          DEVKIT_PACKS: '${devkitPacks.replace(/'/g, "''")}'`);
  }
  return [
    DSH_MCP_PATCH_START,
    '- insert:',
    '    - id: huaweicloud-devkit',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: huaweicloud',
    '        transport: stdio',
    '        command: node',
    '        args:',
    `          - '${dshMcpServerPath().replace(/'/g, "''")}'`,
    '        env:',
    ...envLines,
    '        failOnStartupError: false',
    '    - id: huaweicloud-hook',
    `      name: '../../huaweicloud-plugins/hook-plugin.mjs'`,
    DSH_MCP_PATCH_END,
  ].join('\n');
}

function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function removeManagedDshPatchBlock(content: unknown): string {
  const pattern = new RegExp(
    `\\n?${escapeRegExp(DSH_MCP_PATCH_START)}[\\s\\S]*?${escapeRegExp(DSH_MCP_PATCH_END)}\\s*`,
    'g',
  );
  return asText(content || '')
    .replace(pattern, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function dshPatchHasOnlyCommentsOrEmptyList(content: unknown): boolean {
  const meaningful = asText(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return meaningful.length === 0 || (meaningful.length === 1 && meaningful[0] === '[]');
}

function ensureDshMcpPatch(): boolean {
  const patchFile = dshPatchFile();
  let existing = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
  // Resolve the packs policy before any cleanup rewrites the patch: the
  // current DEVKIT_PACKS value lives inside the managed block that
  // removeManagedDshPatchBlock strips below.
  const dshPacks = packsCarryValue('DSH', readDevkitPacksFromYaml(patchFile));

  // Clean up any legacy managed block from pre-bundle versions.
  const cleaned = removeManagedDshPatchBlock(existing);
  if (cleaned !== existing) {
    writeFileSync(patchFile, cleaned);
    console.log(`  DSH patch legacy block cleaned: ${patchFile}`);
    existing = cleaned;
  }

  // Pre-2.0 installs rewrote the bundled patch to an absolute
  // src/mcp-server.mjs path (see bin/dsh-postinstall.cjs history). That file
  // no longer ships, so rewrite it to this install's dist location before the
  // "already configured" short-circuit below, or the server would silently
  // point at nothing.
  const distServerPath = join(PLUGIN_ROOT, 'dist', 'mcp-server.js').replace(/\\/g, '/');
  const migrated = cleaned.replace(/([^\s'"]*)\/plugins\/huaweicloud-core\/src\/mcp-server\.mjs/g, distServerPath);
  if (migrated !== cleaned) {
    writeFileSync(patchFile, migrated);
    console.log(`  DSH patch MCP path migrated to dist: ${patchFile}`);
    existing = migrated;
  }

  // If the bundled cordis.patch.yml already provides the MCP config, skip
  // writing a managed block to avoid duplicate entries.
  if (cleaned.includes('@deepseek-ai/dsh-mcp-client') && cleaned.includes('serverName: huaweicloud')) {
    console.log(`  DSH patch already configured via bundle: ${patchFile}`);
    return false;
  }

  // Fallback for standalone usage: write a managed block when no bundle.
  const block = dshPatchBlock(dshPacks);
  let next: string;
  if (dshPatchHasOnlyCommentsOrEmptyList(cleaned)) {
    const prefix = cleaned
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '[]')
      .join('\n')
      .trimEnd();
    next = `${prefix ? `${prefix}\n` : ''}${block}\n`;
  } else {
    next = `${cleaned}\n\n${block}\n`;
  }
  if (existing.replace(/\r\n/g, '\n') === next) {
    console.log(`  DSH patch unchanged: ${patchFile}`);
    return false;
  }
  mkdirSync(dirname(patchFile), { recursive: true });
  writeFileSync(patchFile, next);
  console.log(`  DSH patch updated: ${patchFile}`);
  return true;
}

function removeDshMcpPatch(): boolean {
  const patchFile = dshPatchFile();
  if (!existsSync(patchFile)) return false;
  const existing = readFileSync(patchFile, 'utf8');
  const cleaned = removeManagedDshPatchBlock(existing);
  if (cleaned === existing.trimEnd()) return false;
  const prefix = cleaned
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '[]')
    .join('\n')
    .trimEnd();
  const next = dshPatchHasOnlyCommentsOrEmptyList(cleaned) ? `${prefix ? `${prefix}\n` : ''}[]\n` : `${cleaned}\n`;
  writeFileSync(patchFile, next);
  console.log(`  DSH patch cleaned: ${patchFile}`);
  return true;
}

export function dshPatchConfigured(): boolean {
  const patchFile = dshPatchFile();
  if (!existsSync(patchFile)) return false;
  try {
    const patch = readFileSync(patchFile, 'utf8');
    return (
      (patch.includes('id: huaweicloud-devkit') || patch.includes('id: mcp-huaweicloud')) &&
      patch.includes('@deepseek-ai/dsh-mcp-client') &&
      patch.includes('serverName: huaweicloud') &&
      patch.includes('id: huaweicloud-hook')
    );
  } catch {
    return false;
  }
}

function commandAvailable(command: string, args: string[] = ['--version']): boolean {
  try {
    const r = spawnSync(command, args, { shell: false, windowsHide: true, stdio: 'pipe', timeout: 10000 });
    if (r.status === 0) return true;
  } catch {
    // spawn failure falls through — where.exe on win32, else not available
  }
  if (process.platform === 'win32') {
    try {
      const w = spawnSync('where.exe', [command], { windowsHide: true, stdio: 'pipe', timeout: 10000 });
      return w.status === 0 && w.stdout.toString().trim().length > 0;
    } catch {
      // where.exe failure means the command is simply not available
    }
  }
  return false;
}

function dshMcpClientAvailable(): boolean {
  const modulePath = join('node_modules', '@deepseek-ai', 'dsh-mcp-client', 'package.json');
  const candidates = [
    join(dshProfileDir(), modulePath),
    join(dshRoot(), 'profiles', modulePath),
    join(dshRoot(), modulePath),
  ];
  if (candidates.some((p) => existsSync(p))) return true;
  const pkgPath = join(dshProfileDir(), 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = asRecord(JSON.parse(readFileSync(pkgPath, 'utf8')));
    return Boolean(
      asRecord(pkg.dependencies)['@deepseek-ai/dsh-mcp-client'] ||
      asRecord(pkg.devDependencies)['@deepseek-ai/dsh-mcp-client'],
    );
  } catch {
    return false;
  }
}

function tryInstallDshMcpClient(): boolean {
  if (process.env.HUAWEICLOUD_DEVKIT_SKIP_DSH_PLUGIN_INSTALL === '1') {
    console.log('  DSH MCP client install skipped by environment');
    return false;
  }
  if (dshMcpClientAvailable()) {
    console.log('  DSH MCP client package detected');
    return true;
  }
  if (commandAvailable('dsh')) {
    const r = spawnSync('dsh', ['plugin', '--profile', 'web', 'add', '@deepseek-ai/dsh-mcp-client'], {
      env: { ...process.env, DSH_HOME: dshRoot() },
      windowsHide: true,
      stdio: 'pipe',
      timeout: 60000,
    });
    if (r.status === 0) {
      console.log('  DSH MCP client package installed via dsh');
      return true;
    }
    const err = `${asText(r.stderr || '')}${asText(r.stdout || '')}`.trim().split(/\r?\n/).slice(-2).join(' ');
    console.log(`  \x1b[33m[WARN]\x1b[0m DSH MCP client auto-install failed${err ? `: ${err}` : ''}`);
  }
  if (commandAvailable('pnpm') && existsSync(join(dshProfileDir(), 'package.json'))) {
    const r = spawnSync('pnpm', ['--dir', dshProfileDir(), 'add', '@deepseek-ai/dsh-mcp-client'], {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 60000,
    });
    if (r.status === 0) {
      console.log('  DSH MCP client package installed via pnpm');
      return true;
    }
  }
  console.log('  \x1b[33m[WARN]\x1b[0m DSH MCP client package not detected.');
  console.log('  Manual: npx @deepseek-ai/dsh plugin --profile web add @deepseek-ai/dsh-mcp-client');
  console.log('  If pnpm is missing, run: corepack enable pnpm');
  return false;
}

export async function deployDsh(mode: DeployMode): Promise<void> {
  const pluginDest = dshPluginsDir();
  const hookSrc = join(PACKAGE_ROOT, 'integrations', 'dsh', 'hook-plugin.mjs');

  mkdirSync(pluginDest, { recursive: true });
  copyServerPayload(pluginDest);
  copyFileSync(hookSrc, join(pluginDest, 'hook-plugin.mjs'));
  console.log(`  Hook Plugin${deployWord(mode)} -> ${join(pluginDest, 'hook-plugin.mjs')}`);
  ensureDshMcpPatch();
  tryInstallDshMcpClient();
  installRuntimeDeps(pluginDest);
}

export function uninstallDsh(removeOwnedSkills: (dir: string) => number): void {
  const skillsDir = dshSkillsDir();
  const oldHookFile = join(dshRoot(), 'plugins', 'skill-tracker.js');
  const removed = removeOwnedSkills(skillsDir);
  if (removed > 0) console.log(`  Removed ${removed} skills`);
  removeSkillsDirIfEmpty(skillsDir, removed);
  if (removeIfExists(dshPluginsDir())) {
    console.log('  Removed MCP server, safety policy, and hook plugin');
  }
  // Remove old-style hook file from pre-hook-plugin era
  if (removeIfExists(oldHookFile)) {
    console.log('  Removed legacy hook');
  }
  removeDshMcpPatch();
}

export function dshStatus(): void {
  const pluginDir = dshPluginsDir();
  console.log(
    `  MCP Server: ${mcpServerInstalled(pluginDir) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Hook Plugin: ${existsSync(join(pluginDir, 'hook-plugin.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  const skillCount = serverSkillCount(pluginDir);
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(`  DSH patch: ${dshPatchConfigured() ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
  console.log(
    `  DSH MCP client package: ${dshMcpClientAvailable() ? '\x1b[32mDetected\x1b[0m' : '\x1b[33mCheck DSH profile\x1b[0m'}`,
  );
}
