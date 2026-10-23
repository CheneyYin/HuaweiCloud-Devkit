import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { xdgConfigHome } from './auth/agent-registration.ts';

// Where every supported agent target lives: one pure-path function family
// shared by the installer's deploy/uninstall/status/doctor flows. The
// officeace family stays in setup-cli.ts — its dirs derive from registry
// probing, not path computation.

// Every opencode surface (payload dir, skills, commands, config file,
// status/doctor probes) derives from this root. It follows XDG_CONFIG_HOME
// so the installer writes where opencode reads — the shared resolution and
// its rationale live in xdgConfigHome() (auth/agent-registration.ts).
export function configRoot(target = 'opencode'): string {
  return join(xdgConfigHome(), target);
}

export function opencodeSkillsDir(): string {
  return join(configRoot('opencode'), 'skills');
}
export function opencodeCommandsDir(): string {
  return join(configRoot('opencode'), 'commands');
}
export function opencodePluginsDir(): string {
  return join(configRoot('opencode'), 'huaweicloud-plugins');
}
// The jsonc-then-json file preference lives with its xdgConfigHome resolver
// in auth/agent-registration.ts (the detection side); the path family
// re-exports it so install-side callers have one import surface.
export { opencodeConfigFile } from './auth/agent-registration.ts';

export function codexDesktopPluginsDir(): string {
  return join(homedir(), 'plugins', 'huaweicloud-devkit');
}

export function codexMarketplacePath(): string {
  return join(homedir(), '.agents', 'plugins', 'marketplace.json');
}

// OpenClaw paths (separate from Codex Desktop)
export function openclawSkillsDir(): string {
  return join(homedir(), '.agents', 'skills');
}
export function openclawPluginsDir(): string {
  return join(homedir(), '.agents', 'huaweicloud-plugins');
}

export function codeartsSkillsDir(): string {
  return join(homedir(), '.codeartsdoer', 'skills');
}
function codeartsMcpSettingsDir(): string {
  return join(homedir(), '.codeartsdoer', 'mcp');
}
export function codeartsMcpSettingsFile(): string {
  return join(codeartsMcpSettingsDir(), 'mcp_settings.json');
}
export function codeartsProjectDir(): string {
  return join(process.cwd(), '.codeartsdoer');
}
export function codeartsProjectSkillsDir(): string {
  return join(codeartsProjectDir(), 'skills');
}
export function codeartsProjectMcpSettingsFile(): string {
  return join(codeartsProjectDir(), 'mcp', 'mcp_settings.json');
}
export function codeartsPluginsDir(): string {
  return join(homedir(), '.codeartsdoer', 'huaweicloud-plugins');
}

// CodeArts Work (CodeArts Space) — user-level only
export function codeartsWorkSkillsDir(): string {
  return join(homedir(), '.codeartswork', 'skills');
}
export function codeartsWorkMcpSettingsFile(): string {
  // Post platform migration the marketplace presets the plugin under ~/.codearts
  // (new layout); legacy ~/.codeartswork is kept as fallback while still in
  // service. Default to the new dir when it exists, otherwise legacy.
  const newDir = join(homedir(), '.codearts', 'mcp');
  const legacy = join(homedir(), '.codeartswork', 'mcp', 'mcp_settings.json');
  return existsSync(newDir) ? join(newDir, 'mcp_settings.json') : legacy;
}
export function codeartsWorkPluginsDir(): string {
  return join(homedir(), '.codeartswork', 'huaweicloud-plugins');
}

export function workbuddySkillsDir(): string {
  return join(homedir(), '.workbuddy', 'skills');
}
export function workbuddyMcpConfigFile(): string {
  return join(homedir(), '.workbuddy', 'mcp.json');
}
export function workbuddyPluginsDir(): string {
  return join(homedir(), '.workbuddy', 'huaweicloud-plugins');
}

export function atomcodeHome(): string {
  return process.env.ATOMCODE_HOME || join(homedir(), '.atomcode');
}
export function atomcodeSkillsDir(): string {
  return join(atomcodeHome(), 'skills');
}
export function atomcodeMcpConfigFile(): string {
  return join(atomcodeHome(), 'mcp.json');
}
export function atomcodePluginsDir(): string {
  return join(atomcodeHome(), 'huaweicloud-plugins');
}

export function dshRoot(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
export function dshSkillsDir(): string {
  return join(dshRoot(), 'skills');
}
export function dshProfileDir(): string {
  return join(dshRoot(), 'profiles', 'web');
}
export function dshPatchFile(): string {
  return join(dshProfileDir(), 'cordis.patch.yml');
}
export function dshPluginsDir(): string {
  return join(dshRoot(), 'huaweicloud-plugins');
}

// Home directory resolution precedence:
// 1. HERMES_HOME env var — explicit override, highest priority
// 2. homedir() fallback — respects USERPROFILE (Windows) / HOME (Unix)
// Default: ~/.hermes (i.e., join(homedir(), '.hermes'))
// No --home CLI option exists; home redirection is via env vars only.
// This matches the pattern used by other agents (ATOMCODE_HOME, DSH_HOME, etc.)
export function hermesHomeDir(): string {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  return join(homedir(), '.hermes');
}

export function hermesSkillsDir(): string {
  return join(hermesHomeDir(), 'skills');
}

export function hermesPluginsDir(): string {
  return join(hermesHomeDir(), 'huaweicloud-plugins');
}

export function hermesPythonPluginsDir(): string {
  return join(hermesHomeDir(), 'plugins');
}

export function hermesSafetyPluginDir(): string {
  return join(hermesPythonPluginsDir(), 'huaweicloud-safety');
}

export function hermesConfigFile(): string {
  return join(hermesHomeDir(), 'config.yaml');
}
