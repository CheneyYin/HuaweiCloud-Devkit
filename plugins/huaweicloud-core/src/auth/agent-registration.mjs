import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const SUPPORTED_AGENT_TARGETS = ['opencode', 'codex', 'codex-desktop', 'codearts', 'workbuddy', 'dsh', 'officeace'];

function baseHome() {
  return process.env.HUAWEICLOUD_HOME || homedir();
}

function opencodeConfigFile() {
  const jsonc = join(baseHome(), '.config', 'opencode', 'opencode.jsonc');
  if (existsSync(jsonc)) return jsonc;
  return join(baseHome(), '.config', 'opencode', 'opencode.json');
}

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function opencodeRegistered() {
  const path = opencodeConfigFile();
  const cfg = readJsonSafe(path);
  return Boolean(cfg?.mcp?.['huaweicloud-devkit']);
}

function codexDesktopRegistered() {
  const path = join(baseHome(), '.codex', 'config.toml');
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes('[mcp_servers.huaweicloud-devkit]');
  } catch {
    return false;
  }
}

function codexCliRegistered() {
  try {
    const r = spawnSync('codex', ['plugin', 'list'], {
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
      timeout: 10000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    return out.includes('huaweicloud-core');
  } catch {
    return false;
  }
}

function codeartsRegistered() {
  const paths = [
    join(baseHome(), '.codeartsdoer', 'mcp', 'mcp_settings.json'),
    join(process.cwd(), '.codeartsdoer', 'mcp', 'mcp_settings.json'),
  ];
  return paths.some((path) => {
    const cfg = readJsonSafe(path);
    return Boolean(cfg?.mcpServers?.['huaweicloud-devkit']);
  });
}

function workbuddyRegistered() {
  const cfg = readJsonSafe(join(baseHome(), '.workbuddy', 'mcp.json'));
  return Boolean(cfg?.mcpServers?.['huaweicloud-devkit']);
}

function dshRoot() {
  return process.env.DSH_HOME || join(baseHome(), '.dsh');
}

function dshRegistered() {
  const patchPath = join(dshRoot(), 'profiles', 'web', 'cordis.patch.yml');
  if (!existsSync(patchPath)) return false;
  try {
    const patch = readFileSync(patchPath, 'utf8');
    return (
      patch.includes('id: mcp-huaweicloud') &&
      patch.includes('@deepseek-ai/dsh-mcp-client') &&
      patch.includes('serverName: huaweicloud')
    );
  } catch {
    return false;
  }
}

function officeaceCapabilitiesDir() {
  if (process.env.OFFICEACE_HOME) return process.env.OFFICEACE_HOME;
  const dotDir = join(baseHome(), '.office-claw');
  const dotCapFile = join(dotDir, 'capabilities.json');
  if (existsSync(dotCapFile)) return dotDir;
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, 'C:\\Program Files', 'D:\\Program Files']) {
      if (!base) continue;
      const dir = join(base, 'OfficeAce', '.office-claw');
      if (existsSync(join(dir, 'capabilities.json'))) return dir;
    }
  }
  return dotDir;
}

function officeaceRegistered() {
  const capFile = join(officeaceCapabilitiesDir(), 'capabilities.json');
  const cfg = readJsonSafe(capFile);
  if (!cfg?.capabilities) return false;
  const hasMcp = cfg.capabilities.some(
    (c) => c.id === 'huaweicloud-devkit' && c.type === 'mcp',
  );
  const hasSkills = cfg.capabilities.some(
    (c) => c.id === 'huaweicloud-core' && c.type === 'skill',
  );
  return hasMcp || hasSkills;
}

export function getAgentRegistrationStatuses(target = 'all') {
  const requested = target === 'all' ? SUPPORTED_AGENT_TARGETS : [target];
  const result = { target, agents: {} };
  for (const agent of requested) {
    let configured = false;
    if (agent === 'opencode') configured = opencodeRegistered();
    if (agent === 'codex-desktop') configured = codexDesktopRegistered();
    if (agent === 'codex') configured = codexCliRegistered();
    if (agent === 'codearts') configured = codeartsRegistered();
    if (agent === 'workbuddy') configured = workbuddyRegistered();
    if (agent === 'dsh') configured = dshRegistered();
    if (agent === 'officeace') configured = officeaceRegistered();
    result.agents[agent] = { configured };
  }
  return result;
}
