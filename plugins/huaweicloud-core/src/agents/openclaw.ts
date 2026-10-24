// The OpenClaw agent module, extracted from setup-cli.ts: the ~/.agents
// commands + plugin-dir deploy with the codex-discoverable .mcp.json shape
// (shared with Codex Desktop through agents/codex.ts).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { openclawPluginsDir, openclawSkillsDir } from '../targets.ts';
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
import { backupDeltaFromMcpServersFile } from '../mcp-config-io.ts';
import { writeMcpJsonAndCodexManifest } from './codex.ts';

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
