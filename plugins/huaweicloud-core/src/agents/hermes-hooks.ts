// The Hermes hooks family, split out of agents/hermes.ts: the config.yaml
// hooks block and the shell-hooks allowlist. The Python safety-hook plugin
// (the v0.9.0+ enforcement path) lives in agents/hermes-hook-plugin.ts, the
// mcp_servers block family in agents/hermes-config.ts; the
// deploy/uninstall/status lifecycle and the MCP Python SDK provisioning stay
// in agents/hermes.ts.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { hermesConfigFile, hermesHomeDir, hermesPluginsDir } from '../targets.ts';
import { asRecord } from '../lib/as-record.ts';

function hermesHookScript(): string {
  return join(hermesPluginsDir(), 'hooks', 'huaweicloud-safety.py').replace(/\\/g, '/');
}

export function hermesHookCommand(): string {
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

export function ensureHermesHooksConfig(): boolean {
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

export function ensureHermesHookAllowlist(): boolean {
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

export function hermesHookAllowlisted(): boolean {
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

export function removeHermesHooksConfigBlock(): void {
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
