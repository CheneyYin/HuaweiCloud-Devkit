// The Hermes agent module, extracted from setup-cli.ts: the config.yaml
// mcp_servers/hooks blocks, the shell-hooks allowlist, the Python safety-hook
// plugin, the MCP Python SDK provisioning, and the deploy/uninstall/status
// lifecycle.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  hermesConfigFile,
  hermesHomeDir,
  hermesPluginsDir,
  hermesPythonPluginsDir,
  hermesSafetyPluginDir,
  hermesSkillsDir,
} from '../targets.ts';
import { readDevkitPacksFromYaml, packsCarryValue } from '../packs-policy.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { saveAgentDelta, takeAgentDelta } from '../mcp-config-backup.ts';
import { asRecord } from '../lib/as-record.ts';
import {
  PLUGIN_ROOT,
  copyDir,
  copyServerPayload,
  deployWord,
  errorMessage,
  installRuntimeDeps,
  mcpServerInstalled,
  pkgVersion,
  removeIfExists,
  removeSkillsDirIfEmpty,
  serverSkillCount,
  type DeployMode,
} from '../install-payload.ts';

// ── Hermes Agent ──

// Returns true when the config file was written, false when it was already correct.
function ensureHermesMcpConfig(): boolean {
  // Resolve the packs policy before any block rewrite: the current
  // DEVKIT_PACKS value lives inside the block writeHermesMcpConfig rewrites.
  return writeHermesMcpConfig(packsCarryValue('Hermes Agent', readDevkitPacksFromYaml(hermesConfigFile())));
}

// The Hermes MCP block render path, parameterized with the DEVKIT_PACKS value
// to carry. Install/update resolve the value through the --packs policy; the
// `packs` command passes the operator's set-math result. User-added args
// inside the block survive the rewrite exactly as install preserves them.
export function writeHermesMcpConfig(devkitPacks: string | null): boolean {
  const configPath = hermesConfigFile();
  const mcpPath = join(hermesPluginsDir(), 'dist', 'mcp-server.js').replace(/\\/g, '/');
  const hcloudBin = findHcloudBin();

  const blockLines: string[] = [
    'mcp_servers:',
    '  huaweicloud-devkit:',
    '    command: "node"',
    `    args: ["${mcpPath}"]`,
    '    env:',
    '      HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"',
  ];
  if (hcloudBin) {
    blockLines.push(`      HCLOUD_BIN: "${hcloudBin.replace(/\\/g, '/')}"`);
  }
  const hermesPacksLine = devkitPacks !== null ? `      DEVKIT_PACKS: "${devkitPacks.replace(/"/g, '\\"')}"` : null;
  if (hermesPacksLine !== null) blockLines.push(hermesPacksLine);

  let existing = '';
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, 'utf8');
    } catch {
      // unreadable config is treated as absent — the block is written fresh
    }
    if (existing.includes('mcp_servers:') && existing.includes('huaweicloud-devkit')) {
      // Preserve user's extra args (e.g. --hdkitservice-endpoint) when rewriting the block (issue #615).
      const argsMatch = existing.match(/^\s*huaweicloud-devkit\s*:[\s\S]*?^\s*args:\s*\[[^\]]*\]\s*$/m);
      const extrasMatch = argsMatch ? argsMatch[0].match(/args:\s*\[".*?"(.*)\]/) : null;
      const extras = extrasMatch && extrasMatch[1]!.trim() ? extrasMatch[1]!.replace(/,\s*$/, '') : '';
      const packsLineOk =
        hermesPacksLine === null ? !/^\s*DEVKIT_PACKS:/m.test(existing) : existing.includes(hermesPacksLine);
      if (existing.includes(`args: ["${mcpPath}"${extras}]`) && packsLineOk) {
        console.log(`  MCP config unchanged: ${configPath}`);
        return false;
      }
      if (extras) blockLines[3] = `    args: ["${mcpPath}"${extras}]`;
      removeHermesMcpConfigBlock();
      existing = '';
      if (existsSync(configPath)) {
        try {
          existing = readFileSync(configPath, 'utf8');
        } catch {
          // unreadable re-read means the block becomes the whole file
        }
      }
    }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  // Restore user args saved by a previous uninstall (issue #615).
  const hermesDelta = takeAgentDelta('hermes');
  if (hermesDelta && Array.isArray(hermesDelta.argsExtra) && hermesDelta.argsExtra.length > 0) {
    const extras = hermesDelta.argsExtra.map((a) => `"${String(a)}"`).join(', ');
    blockLines[3] = `    args: ["${mcpPath}", ${extras}]`;
  }
  const newBlock = blockLines.join('\n');
  const newContent = existing ? `${existing.trimEnd()}\n\n${newBlock}\n` : `${newBlock}\n`;
  writeFileSync(configPath, newContent);
  console.log(`  MCP config updated: ${configPath}`);
  return true;
}

function removeHermesMcpConfigBlock(): void {
  const configPath = hermesConfigFile();
  if (!existsSync(configPath)) return;
  const lines = readFileSync(configPath, 'utf8').split(/\r?\n/);
  const out: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (/^\s*huaweicloud-devkit\s*:/.test(line)) {
      skip = true;
      continue;
    }
    if (skip) {
      // Continue skipping indented lines (the server config block)
      if (/^\s{2,}/.test(line) && line.trim() !== '') continue;
      // Stop skipping at a top-level key or empty line
      skip = false;
    }
    // If we just skipped the only server under mcp_servers, remove the key too
    if (line.trim() === 'mcp_servers:') {
      continue; // skip the mcp_servers key for now, re-add if other servers exist
    }
    out.push(line);
  }
  // Reconstruct: add mcp_servers back if there are other servers
  const cleaned = out.join('\n').trimEnd();
  writeFileSync(configPath, cleaned ? `${cleaned}\n` : '');
  console.log('  MCP config cleaned');
}

function hermesHookScript(): string {
  return join(hermesPluginsDir(), 'hooks', 'huaweicloud-safety.py').replace(/\\/g, '/');
}

function hermesHookCommand(): string {
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  return `${pythonBin} ${hermesHookScript()}`;
}

function hermesTelemetryHookScript(): string {
  return join(hermesPluginsDir(), 'hooks', 'huaweicloud-telemetry.py').replace(/\\/g, '/');
}

function hermesTelemetryHookCommand(): string {
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  return `${pythonBin} ${hermesTelemetryHookScript()}`;
}

function ensureHermesHooksConfig(): boolean {
  const configPath = hermesConfigFile();
  const hookCommand = hermesHookCommand();
  const telemetryHookCommand = hermesTelemetryHookCommand();

  const blockLines: string[] = [
    'hooks:',
    '  pre_tool_call:',
    '    - matcher: "terminal"',
    `      command: "${hookCommand}"`,
    '      timeout: 5',
    '      fail_closed: true',
    '    - matcher: "skill_view|skills_list|skill_manage|terminal"',
    `      command: "${telemetryHookCommand}"`,
    '      timeout: 5',
    '      fail_closed: false',
  ];
  const block = blockLines.join('\n');

  let existing = '';
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, 'utf8');
    } catch {
      // unreadable config is treated as absent — the hooks block is written fresh
    }
    if (
      existing.includes('hooks:') &&
      existing.includes(`command: "${hookCommand}"`) &&
      existing.includes('fail_closed: true') &&
      existing.includes(`command: "${telemetryHookCommand}"`)
    ) {
      console.log(`  Hooks config unchanged: ${configPath}`);
      return false;
    }
    removeHermesHooksConfigBlock();
    existing = '';
    if (existsSync(configPath)) {
      try {
        existing = readFileSync(configPath, 'utf8');
      } catch {
        // unreadable re-read means the block becomes the whole file
      }
    }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  const newContent = existing ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
  writeFileSync(configPath, newContent);
  console.log(`  Hooks config updated: ${configPath}`);
  return true;
}

function hermesHookScriptMtime(): string | null {
  const scriptPath = hermesHookScript();
  try {
    return statSync(scriptPath).mtime.toISOString();
  } catch {
    return null;
  }
}

function hermesAllowlistPath(): string {
  return join(hermesHomeDir(), 'shell-hooks-allowlist.json');
}

// shell-hooks-allowlist.json keeps user approvals under a single `approvals`
// array; all other fields round-trip as unknown.
interface HermesAllowlist {
  approvals?: unknown;
}

function ensureHermesHookAllowlist(): boolean {
  const hookCommand = hermesHookCommand();
  const telemetryHookCommand = hermesTelemetryHookCommand();
  const allowlistPath = hermesAllowlistPath();

  let data: HermesAllowlist = { approvals: [] };
  if (existsSync(allowlistPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(allowlistPath, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed;
      }
    } catch {
      // corrupt allowlist falls back to a fresh approvals list
    }
  }
  const approvals: unknown[] = Array.isArray(data.approvals) ? data.approvals : [];

  let changed = false;
  for (const cmd of [hookCommand, telemetryHookCommand]) {
    const already = approvals.some((a) => asRecord(a).event === 'pre_tool_call' && asRecord(a).command === cmd);
    if (!already) {
      const entry = {
        event: 'pre_tool_call',
        command: cmd,
        approved_at: new Date().toISOString(),
        script_mtime_at_approval: hermesHookScriptMtime(),
      };
      approvals.push(entry);
      changed = true;
    }
  }

  if (!changed) {
    console.log(`  Hook allowlist unchanged: ${allowlistPath}`);
    return false;
  }

  data.approvals = approvals;
  mkdirSync(dirname(allowlistPath), { recursive: true });
  writeFileSync(allowlistPath, JSON.stringify(data, null, 2));
  console.log(`  Hook allowlist updated: ${allowlistPath}`);
  return true;
}

function hermesHookAllowlisted(): boolean {
  const allowlistPath = hermesAllowlistPath();
  if (!existsSync(allowlistPath)) return false;
  try {
    const data: unknown = JSON.parse(readFileSync(allowlistPath, 'utf8'));
    const cmd = hermesHookCommand();
    const approvals: unknown = asRecord(data).approvals;
    return (
      Array.isArray(approvals) &&
      approvals.some((a) => asRecord(a).event === 'pre_tool_call' && asRecord(a).command === cmd)
    );
  } catch {
    return false;
  }
}

function hermesHookPluginInit(): string {
  const script = hermesHookScript();
  return [
    'import importlib.util',
    '',
    `SAFETY_SCRIPT = ${JSON.stringify(script)}`,
    '',
    '',
    'def _load_safety():',
    '    spec = importlib.util.spec_from_file_location("huaweicloud_safety_hook", SAFETY_SCRIPT)',
    '    module = importlib.util.module_from_spec(spec)',
    '    spec.loader.exec_module(module)',
    '    return module',
    '',
    '',
    '_safety = _load_safety()',
    '',
    '',
    'def register(ctx):',
    '    ctx.register_hook("pre_tool_call", _check)',
    '',
    '',
    'def _check(tool_name=None, args=None, **kwargs):',
    '    if tool_name != "terminal":',
    '        return None',
    '    if not (isinstance(args, dict) and "command" in args):',
    '        return None',
    '    reason = _safety.evaluate(tool_name, args)',
    '    if reason:',
    '        return {"action": "block", "message": _safety.DENY_PREFIX + reason}',
    '    return None',
    '',
  ].join('\n');
}

function ensureHermesHookPlugin(): boolean {
  const pluginDir = hermesSafetyPluginDir();
  const manifestPath = join(pluginDir, 'plugin.yaml');
  const initPath = join(pluginDir, '__init__.py');

  const manifest = [
    'name: huaweicloud-safety',
    `version: "${pkgVersion}"`,
    'description: Huawei Cloud safety pre_tool_call hook',
    'author: HuaweiCloud Mate',
    'provides_hooks:',
    '  - pre_tool_call',
    '',
  ].join('\n');
  const init = hermesHookPluginInit();

  const manifestCurrent = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  const initCurrent = existsSync(initPath) ? readFileSync(initPath, 'utf8') : '';
  if (manifestCurrent === manifest && initCurrent === init) {
    console.log(`  Hook plugin unchanged: ${pluginDir}`);
    return false;
  }

  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(manifestPath, manifest);
  writeFileSync(initPath, init);
  console.log(`  Hook plugin installed: ${pluginDir}`);
  return true;
}

function removeHermesHookPlugin(): boolean {
  const pluginDir = hermesSafetyPluginDir();
  if (!existsSync(pluginDir)) return false;
  rmSync(pluginDir, { recursive: true, force: true });
  console.log(`  Removed hook plugin: ${pluginDir}`);
  const parent = hermesPythonPluginsDir();
  try {
    if (existsSync(parent) && readdirSync(parent).length === 0) {
      rmSync(parent, { recursive: true, force: true });
    }
  } catch {
    // best-effort cleanup: an empty parent dir left behind is harmless
  }
  return true;
}

function hermesHookPluginInstalled(): boolean {
  return (
    existsSync(join(hermesSafetyPluginDir(), 'plugin.yaml')) && existsSync(join(hermesSafetyPluginDir(), '__init__.py'))
  );
}

function removeHermesHooksConfigBlock(): void {
  const configPath = hermesConfigFile();
  if (!existsSync(configPath)) return;
  const lines = readFileSync(configPath, 'utf8').split(/\r?\n/);
  let inHooksBlock = false;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'hooks:' && !inHooksBlock) {
      inHooksBlock = true;
      continue;
    }
    if (inHooksBlock) {
      if (trimmed === '' || line.startsWith(' ') || line.startsWith('\t')) {
        continue;
      }
      inHooksBlock = false;
    }
    out.push(line);
  }
  const cleaned = out.join('\n').trimEnd();
  writeFileSync(configPath, cleaned ? `${cleaned}\n` : '');
  console.log('  Hooks config cleaned');
}

function ensureHermesMcpSdk(): boolean {
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  try {
    const r = spawnSync(pythonBin, ['-c', 'import mcp; print("ok")'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout.trim() === 'ok') {
      console.log('  MCP Python SDK: \x1b[32mAlready installed\x1b[0m');
      return true;
    }
  } catch {
    // probe failure just means SDK state unknown — the install attempt follows
  }
  console.log('  Installing Hermes MCP Python SDK...');
  try {
    const pip = spawnSync(pythonBin, ['-m', 'pip', 'install', 'mcp', '--quiet'], { encoding: 'utf8', timeout: 60000 });
    if (pip.status === 0) {
      console.log('  MCP Python SDK: \x1b[32mInstalled\x1b[0m');
      return true;
    }
    console.log(`  MCP Python SDK: \x1b[33mInstall failed\x1b[0m`);
    console.log(`  \x1b[33m  Run manually: ${pythonBin} -m pip install mcp\x1b[0m`);
  } catch (error) {
    console.log(`  MCP Python SDK: \x1b[33m${errorMessage(error)}\x1b[0m`);
    console.log(`  \x1b[33m  Run manually: ${pythonBin} -m pip install mcp\x1b[0m`);
  }
  return false;
}

export function hermesMcpSdkOk(): boolean {
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  try {
    const r = spawnSync(pythonBin, ['-c', 'import mcp; print("ok")'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 && r.stdout.trim() === 'ok';
  } catch {
    return false;
  }
}
// Hermes deploy: safety + telemetry hooks, the config.yaml MCP block, and
// the runtime deps. --skip-mcp-server (clone-based installs) is honored in
// install mode only — update always ships the full server. The deps/sdk
// tail follows install's order (deps first); the old update body ran the
// sdk first, an ordering drift with no green-path effect.
export async function deployHermes(mode: DeployMode): Promise<void> {
  const hooksDir = join(PLUGIN_ROOT, 'hooks');
  const integrationsHooksDir = resolve(PLUGIN_ROOT, '..', '..', 'integrations', 'hermes', 'hooks');
  const pluginDest = hermesPluginsDir();
  const skipMcp = mode === 'install' && process.argv.includes('--skip-mcp-server');

  // Skills are server data and always travel with the plugin dir; only the
  // bundled server itself is optional (--skip-mcp-server runs from a clone).
  copyServerPayload(pluginDest, { skipDist: skipMcp });
  copyDir(hooksDir, join(pluginDest, 'hooks'));
  console.log(`  Safety Hooks${deployWord(mode)} -> ${join(pluginDest, 'hooks')}`);
  // Telemetry hook lives in integrations/hermes/hooks/ (platform-specific adapter)
  copyFileSync(
    join(integrationsHooksDir, 'huaweicloud-telemetry.py'),
    join(pluginDest, 'hooks', 'huaweicloud-telemetry.py'),
  );

  if (!skipMcp) ensureHermesMcpConfig();
  ensureHermesHooksConfig();
  ensureHermesHookAllowlist();
  ensureHermesHookPlugin();

  if (!skipMcp) installRuntimeDeps(pluginDest);
  if (!skipMcp) ensureHermesMcpSdk();
}

export function uninstallHermes(removeOwnedSkills: (dir: string) => number): void {
  const skillsDir = hermesSkillsDir();

  // 1. Remove hook config from config.yaml (before deleting script files)
  removeHermesHooksConfigBlock();
  console.log('  Hooks config removed');

  // 1b. Remove the Python safety hook plugin (v0.9.0+ enforcement path)
  removeHermesHookPlugin();

  // 2. Clean shell-hooks-allowlist.json (remove approved hook references)
  const hermesHome = hermesHomeDir();
  const allowlistPath = join(hermesHome, 'shell-hooks-allowlist.json');
  if (existsSync(allowlistPath)) {
    try {
      const allowlist = asRecord(JSON.parse(readFileSync(allowlistPath, 'utf8')));
      const approvals: unknown[] = Array.isArray(allowlist.approvals) ? allowlist.approvals : [];
      const before = approvals.length;
      const filtered = approvals.filter((a) => {
        const cmd = typeof a === 'string' ? a : asRecord(a).command;
        return !(typeof cmd === 'string' && cmd.includes('huaweicloud-safety.py'));
      });
      allowlist.approvals = filtered;
      if (filtered.length < before) {
        writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2));
        console.log(`  Removed ${before - filtered.length} hook approvals from allowlist`);
      }
    } catch {
      removeIfExists(allowlistPath);
      console.log('  Removed hook allowlist file');
    }
  }

  // 3. Remove MCP config from config.yaml (back up user args first, issue #615)
  const hermesConfig = hermesConfigFile();
  if (existsSync(hermesConfig)) {
    try {
      const text = readFileSync(hermesConfig, 'utf8');
      const argsLine = text.match(/^\s*args:\s*\[([^\]]*)\]\s*$/m);
      if (argsLine) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(`[${argsLine[1]!.replace(/'/g, '"')}]`);
        } catch {
          parsed = null;
        }
        if (Array.isArray(parsed) && parsed.length > 1) {
          saveAgentDelta('hermes', { argsExtra: parsed.slice(1) });
        }
      }
    } catch {
      // best-effort backup: no delta means reinstall uses default args
    }
  }
  removeHermesMcpConfigBlock();
  console.log('  MCP config removed');

  // 4. Remove skills (file deletion comes after config cleanup)
  const removed = removeOwnedSkills(skillsDir);
  if (removed > 0) console.log(`  Removed ${removed} skills`);
  removeSkillsDirIfEmpty(skillsDir, removed);

  // 5. Remove plugin directory (hook script files deleted last)
  if (removeIfExists(hermesPluginsDir())) {
    console.log('  Removed MCP server, safety policy and hooks');
  }
}

export function hermesStatus(): void {
  const pluginDir = hermesPluginsDir();
  console.log(
    `  MCP Server: ${mcpServerInstalled(pluginDir) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Hooks: ${existsSync(join(pluginDir, 'hooks', 'huaweicloud-safety.py')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Telemetry Hook: ${existsSync(join(pluginDir, 'hooks', 'huaweicloud-telemetry.py')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Hook allowlist: ${hermesHookAllowlisted() ? '\x1b[32mApproved\x1b[0m' : '\x1b[31mNot allowlisted\x1b[0m'}`,
  );
  console.log(
    `  Hook plugin: ${hermesHookPluginInstalled() ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(`  MCP Python SDK: ${hermesMcpSdkOk() ? '\x1b[32mReady\x1b[0m' : '\x1b[31mMissing\x1b[0m'}`);
  const skillCount = serverSkillCount(pluginDir);
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
  const configPath = hermesConfigFile();
  if (existsSync(configPath)) {
    try {
      const config = readFileSync(configPath, 'utf8');
      const mcpConfigured = config.includes('mcp_servers:') && config.includes('huaweicloud-devkit');
      const hooksConfigured = config.includes('hooks:') && config.includes('huaweicloud-safety.py');
      console.log(`  MCP config: ${mcpConfigured ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
      console.log(`  Hooks config: ${hooksConfigured ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
    } catch {
      console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
      console.log(`  Hooks config: \x1b[31mInvalid\x1b[0m`);
    }
  } else {
    console.log(`  MCP config: \x1b[31mNot found\x1b[0m`);
    console.log(`  Hooks config: \x1b[31mNot found\x1b[0m`);
  }
}
