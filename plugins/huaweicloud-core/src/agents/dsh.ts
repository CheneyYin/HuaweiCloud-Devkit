// The DSH agent module, split for the complex-file bar: this file keeps the
// dsh-mcp-client package detection/install and the deploy/uninstall/status
// lifecycle; the cordis.patch.yml managed-block family (with its pre-2.0
// src/mcp-server.mjs migration) lives in agents/dsh-patch.ts.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { dshPluginsDir, dshProfileDir, dshRoot, dshSkillsDir } from '../targets.ts';
import { asText } from '../lib/as-text.ts';
import { asRecord } from '../lib/as-record.ts';
import {
  PACKAGE_ROOT,
  copyServerPayload,
  deployWord,
  installRuntimeDeps,
  mcpServerInstalled,
  removeIfExists,
  removeSkillsDirIfEmpty,
  serverSkillCount,
  type DeployMode,
} from '../install-payload.ts';
import { dshPatchConfigured, ensureDshMcpPatch, removeDshMcpPatch } from './dsh-patch.ts';

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
