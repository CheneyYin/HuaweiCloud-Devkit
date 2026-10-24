// The CodeArts agent module, extracted from setup-cli.ts: user- and
// project-level mcp_settings.json registration and the skill-tracker hook.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  codeartsMcpSettingsFile,
  codeartsPluginsDir,
  codeartsProjectMcpSettingsFile,
  codeartsProjectSkillsDir,
  codeartsSkillsDir,
} from '../targets.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { ensureMcpServersConfig, printMcpConfigStatus, removeMcpServerEntry } from '../mcp-config-io.ts';
import {
  PACKAGE_ROOT,
  copyServerPayload,
  deployWord,
  installRuntimeDeps,
  payloadStatusLines,
  removeIfExists,
  type DeployMode,
} from '../install-payload.ts';

function registerCodeartsMcp(configPath: string, agentKey = 'codearts'): void {
  const mcpPath = join(codeartsPluginsDir(), 'dist', 'mcp-server.js').replace(/\\/g, '/');
  const env: Record<string, string> = { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' };
  const hcloudBin = findHcloudBin();
  if (hcloudBin) env.HCLOUD_BIN = hcloudBin.replace(/\\/g, '/');
  ensureMcpServersConfig({ configPath, mcpPath, agentKey, label: 'CodeArts', env, enabledByDefault: true });
}

export async function deployCodeArts(mode: DeployMode): Promise<void> {
  const pluginSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'hooks', 'skill-tracker.js');
  const pluginDest = codeartsPluginsDir();

  copyServerPayload(pluginDest);

  const codeartsHookDir = join(homedir(), '.codeartsdoer', 'plugins');
  mkdirSync(codeartsHookDir, { recursive: true });
  copyFileSync(pluginSrc, join(codeartsHookDir, 'skill-tracker.js'));

  console.log(`  Plugin${deployWord(mode)} -> ${codeartsHookDir}`);

  registerCodeartsMcp(codeartsMcpSettingsFile());
  registerCodeartsMcp(codeartsProjectMcpSettingsFile());

  installRuntimeDeps(pluginDest);
}

export function uninstallCodeArts(removeOwnedSkills: (dir: string) => number): void {
  let removed = 0;
  for (const skillsDir of [codeartsSkillsDir(), codeartsProjectSkillsDir()]) {
    removed += removeOwnedSkills(skillsDir);
  }
  if (removed > 0) console.log(`  Removed ${removed} skills`);

  const hookFile = join(homedir(), '.codeartsdoer', 'plugins', 'skill-tracker.js');
  if (existsSync(hookFile)) {
    removeIfExists(hookFile);
    console.log('  Removed plugin hook');
  }

  if (removeIfExists(codeartsPluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
  removeMcpServerEntry(codeartsMcpSettingsFile(), 'mcpServers', 'args', 'codearts');
  removeMcpServerEntry(codeartsProjectMcpSettingsFile(), 'mcpServers', 'args', 'codearts');
}

export function codeartsStatus(): void {
  payloadStatusLines(codeartsPluginsDir());
  printMcpConfigStatus(codeartsMcpSettingsFile());
}
