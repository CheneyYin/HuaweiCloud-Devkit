// The Hermes config.yaml MCP-block family, split out of agents/hermes.ts:
// the mcp_servers managed-block writer (user args survive, DEVKIT_PACKS
// parameterized), and the block remover. The hooks/allowlist/plugin families
// live in agents/hermes-hooks.ts; the deploy/uninstall/status lifecycle and
// the MCP Python SDK provisioning stay in agents/hermes.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { hermesConfigFile, hermesPluginsDir } from '../targets.ts';
import { readDevkitPacksFromYaml, packsCarryValue } from '../packs-policy.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { takeAgentDelta } from '../mcp-config-backup.ts';

// Returns true when the config file was written, false when it was already correct.
export function ensureHermesMcpConfig(): boolean {
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
  // YAML double-quoted scalars: backslash starts an escape sequence, so a
  // raw backslash in DEVKIT_PACKS would corrupt (or inject into) the parsed
  // value — escape backslashes first, then quotes (CodeQL
  // js/incomplete-sanitization; backslash-before-quote order matters: the
  // quote escape's own backslash must not be doubled).
  const yamlQuoted = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const hermesPacksLine = devkitPacks !== null ? `      DEVKIT_PACKS: "${yamlQuoted(devkitPacks)}"` : null;
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
    const extras = hermesDelta.argsExtra.map((a) => `"${yamlQuoted(String(a))}"`).join(', ');
    blockLines[3] = `    args: ["${mcpPath}", ${extras}]`;
  }
  const newBlock = blockLines.join('\n');
  const newContent = existing ? `${existing.trimEnd()}\n\n${newBlock}\n` : `${newBlock}\n`;
  writeFileSync(configPath, newContent);
  console.log(`  MCP config updated: ${configPath}`);
  return true;
}

export function removeHermesMcpConfigBlock(): void {
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
