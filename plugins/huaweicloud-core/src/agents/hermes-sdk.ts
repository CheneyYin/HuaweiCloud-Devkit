// The Hermes MCP Python SDK family, split out of agents/hermes.ts for the
// complex-file bar: the deploy-time provisioning (pip install with probe
// short-circuit), the probe itself, and the doctor check that keys on the
// Hermes config state. The config.yaml mcp_servers block family lives in
// agents/hermes-config.ts, the hooks/allowlist/plugin families in
// agents/hermes-hooks.ts and agents/hermes-hook-plugin.ts, and the
// deploy/uninstall/status lifecycle in agents/hermes.ts.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { hermesConfigFile } from '../targets.ts';
import { errorMessage } from '../install-payload.ts';
import type { DoctorReporter } from '../doctor-report.ts';

export function ensureHermesMcpSdk(): boolean {
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

// Doctor: the Hermes MCP Python SDK check — only checked when Hermes config
// is found (the MCP-configured chain naming Hermes, or any config.yaml
// carrying an mcp_servers block).
export function hermesDoctorSdkCheck(ctx: DoctorReporter, mcpCfgTarget: string | null): void {
  if (
    mcpCfgTarget === 'Hermes Agent' ||
    (existsSync(hermesConfigFile()) && readFileSync(hermesConfigFile(), 'utf8').includes('mcp_servers'))
  ) {
    ctx.check('Hermes MCP Python SDK', hermesMcpSdkOk(), 'Run: pip3 install mcp');
  }
}
