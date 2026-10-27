// The OpenClaw agent module, extracted from setup-cli.ts: the ~/.agents
// commands + plugin-dir deploy with the codex-discoverable .mcp.json shape
// (shared with Codex Desktop through agents/codex-desktop.ts).

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { openclawPluginsDir, openclawSkillsDir } from '../targets.ts';
import { asRecord } from '../lib/as-record.ts';
import {
  PACKAGE_ROOT,
  copyDir,
  copyServerPayload,
  deployWord,
  installRuntimeDeps,
  payloadStatusLines,
  pruneStale,
  removeHuaweiCommandsFrom,
  removeIfExists,
  type DeployMode,
} from '../install-payload.ts';
import { backupDeltaFromMcpServersFile, writeMcpJsonAndCodexManifest } from '../mcp-config-io.ts';

// Doctor: the OpenClaw MCP-configured candidate — the plugin dir's .mcp.json
// (written by the same writeMcpServersFile the codex-desktop flow uses;
// mcpServers key).
export function openclawDoctorMcpConfigured(): string | null {
  const openclawCfg = join(openclawPluginsDir(), '.mcp.json');
  if (!existsSync(openclawCfg)) return null;
  try {
    const cfg = asRecord(JSON.parse(readFileSync(openclawCfg, 'utf8')));
    if (cfg.mcpServers && asRecord(cfg.mcpServers)['huaweicloud-devkit']) return 'OpenClaw';
  } catch {
    // corrupt OpenClaw config exhausts the candidates — the check reports its advice
  }
  return null;
}

export async function deployOpenClaw(mode: DeployMode): Promise<void> {
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const pluginDest = openclawPluginsDir();

  mkdirSync(pluginDest, { recursive: true });
  const commandsDir = join(homedir(), '.agents', 'commands');
  copyDir(commandsSrc, commandsDir);
  const staleCommands = mode === 'update' ? pruneStale(commandsDir, commandsSrc) : 0;
  console.log(
    `  Commands${deployWord(mode)} -> ${commandsDir}${staleCommands > 0 ? ` (removed ${staleCommands} stale)` : ''}`,
  );
  copyServerPayload(pluginDest);

  writeMcpJsonAndCodexManifest(pluginDest, 'openclaw', mode);

  installRuntimeDeps(pluginDest);
}

export function uninstallOpenClaw(removeOwnedSkills: (dir: string) => number): void {
  const removed = removeOwnedSkills(openclawSkillsDir());
  if (removed > 0) console.log(`  Removed ${removed} skills`);

  const cmdRemoved = removeHuaweiCommandsFrom(join(homedir(), '.agents', 'commands'));
  if (cmdRemoved > 0) console.log(`  Removed ${cmdRemoved} commands`);

  backupDeltaFromMcpServersFile(openclawPluginsDir(), 'openclaw');
  if (removeIfExists(openclawPluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
}

export function openclawStatus(): void {
  payloadStatusLines(openclawPluginsDir());
}
