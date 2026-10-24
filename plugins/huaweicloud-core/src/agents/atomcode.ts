// The AtomCode agent module, extracted from setup-cli.ts: hooks.json
// pre_tool_call telemetry wiring and mcp config registration.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomcodeHome, atomcodeMcpConfigFile, atomcodePluginsDir, atomcodeSkillsDir } from '../targets.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { ensureMcpServersConfig, printMcpConfigStatus, removeMcpServerEntry } from '../mcp-config-io.ts';
import { asRecord } from '../lib/as-record.ts';
import {
  PACKAGE_ROOT,
  copyServerPayload,
  installRuntimeDeps,
  payloadStatusLines,
  removeIfExists,
  type DeployMode,
} from '../install-payload.ts';

// ── AtomCode hooks deployment ────────────────────────────────

function deployAtomcodeHooks(): void {
  const hooksDestDir = join(atomcodePluginsDir(), 'hooks');
  const hooksSrc = join(PACKAGE_ROOT, 'integrations', 'atomcode', 'hooks', 'huaweicloud-telemetry.js');

  // 1. Copy hook script
  if (existsSync(hooksSrc)) {
    mkdirSync(hooksDestDir, { recursive: true });
    copyFileSync(hooksSrc, join(hooksDestDir, 'huaweicloud-telemetry.js'));
    console.log(`  Hook -> ${join(hooksDestDir, 'huaweicloud-telemetry.js')}`);
  }

  // 2. Merge pre_tool_use hook into ~/.atomcode/hooks.json
  const hooksConfigPath = join(atomcodeHome(), 'hooks.json');
  const nodeBin = process.execPath;
  const hookCmd = `${nodeBin} ${join(atomcodePluginsDir(), 'hooks', 'huaweicloud-telemetry.js').replace(/\\/g, '/')}`;

  let hooksConfig: Record<string, unknown> = {};
  if (existsSync(hooksConfigPath)) {
    try {
      hooksConfig = asRecord(JSON.parse(readFileSync(hooksConfigPath, 'utf8')));
    } catch {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not parse ${hooksConfigPath}; hook config not merged.`);
      hooksConfig = {};
    }
  }

  const hooksMap: Record<string, unknown> = asRecord(hooksConfig.hooks);
  hooksConfig.hooks = hooksMap;
  hooksMap['hw-telemetry'] = {
    event: 'pre_tool_use',
    command: hookCmd,
    timeout_ms: 2000,
  };

  mkdirSync(atomcodeHome(), { recursive: true });
  writeFileSync(hooksConfigPath, JSON.stringify(hooksConfig, null, 2) + '\n');
  console.log(`  Hook config -> ${hooksConfigPath}`);
}

function removeAtomcodeHooks(): void {
  // Remove hook script
  removeIfExists(join(atomcodePluginsDir(), 'hooks', 'huaweicloud-telemetry.js'));

  // Remove hw-telemetry entry from hooks.json
  const hooksConfigPath = join(atomcodeHome(), 'hooks.json');
  if (existsSync(hooksConfigPath)) {
    let hooksConfig: Record<string, unknown>;
    try {
      hooksConfig = asRecord(JSON.parse(readFileSync(hooksConfigPath, 'utf8')));
    } catch {
      return;
    }
    const hooksMap = asRecord(hooksConfig.hooks);
    if (hooksMap['hw-telemetry']) {
      delete hooksMap['hw-telemetry'];
      hooksConfig.hooks = hooksMap;
      if (Object.keys(hooksMap).length === 0) delete hooksConfig.hooks;
      writeFileSync(hooksConfigPath, JSON.stringify(hooksConfig, null, 2) + '\n');
      console.log(`  Hook config cleaned: ${hooksConfigPath}`);
    }
  }
}

function ensureAtomcodeMcpConfig(): boolean {
  const env: Record<string, string> = { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local', AGENT_HARNESS: 'atomcode' };
  const hcloudBin = findHcloudBin();
  if (hcloudBin) env.HCLOUD_BIN = hcloudBin.replace(/\\/g, '/');
  return ensureMcpServersConfig({
    configPath: atomcodeMcpConfigFile(),
    mcpPath: join(atomcodePluginsDir(), 'dist', 'mcp-server.js').replace(/\\/g, '/'),
    agentKey: 'atomcode',
    label: 'AtomCode',
    env,
  });
}

export async function deployAtomCode(_mode: DeployMode): Promise<void> {
  const pluginDest = atomcodePluginsDir();

  copyServerPayload(pluginDest);
  ensureAtomcodeMcpConfig();
  deployAtomcodeHooks();

  installRuntimeDeps(pluginDest);
}

export function uninstallAtomCode(removeOwnedSkills: (dir: string) => number): void {
  const removed = removeOwnedSkills(atomcodeSkillsDir());
  if (removed > 0) console.log(`  Removed ${removed} skills`);

  removeAtomcodeHooks();

  if (removeIfExists(atomcodePluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }

  removeMcpServerEntry(atomcodeMcpConfigFile(), 'mcpServers', 'args', 'atomcode');
}

export function atomcodeStatus(): void {
  payloadStatusLines(atomcodePluginsDir());
  printMcpConfigStatus(atomcodeMcpConfigFile());
}
