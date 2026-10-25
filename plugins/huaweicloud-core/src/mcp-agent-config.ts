// The generic MCP-agent config family, extracted from setup-cli.ts: the
// Claude Code / Cursor / custom-MCP-client wiring path — the paste snippet
// and the surgical mcpServers writer (user keys preserved, .bak backup on
// first touch).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import { asRecord } from './lib/as-record.ts';

export const MCP_ENTRY = {
  command: 'npx',
  args: ['-y', '-p', 'huaweicloud-devkit', 'huaweicloud-devkit-mcp'],
};

export function printMCPConfigSnippet(reason: string): void {
  console.log(`  ${reason}`);
  console.log('  Add this to your agent MCP config (stdio):');
  const snippet = JSON.stringify({ mcpServers: { 'huaweicloud-devkit': MCP_ENTRY } }, null, 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  console.log(snippet);
  console.log('  Or run the remote server and use a remote (Streamable HTTP) config:');
  console.log('    npx --yes huaweicloud-devkit-mcp --transport remote   # listens on 127.0.0.1:9528');
  console.log('  See README → "Other Agents" for details.');
}

// Generic MCP agent configs keep arbitrary user keys, so only mcpServers is
// validated (and normalized to a record) before the managed entry is written.
interface AgentMcpConfig {
  [key: string]: unknown;
  mcpServers: Record<string, unknown>;
}

export function configureMCPAgent(targetFile: string, agentLabel: string): boolean {
  let config: AgentMcpConfig = { mcpServers: {} };
  let existed = false;
  if (existsSync(targetFile)) {
    existed = true;
    try {
      const parsed: unknown = JSON.parse(readFileSync(targetFile, 'utf8'));
      config =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as AgentMcpConfig)
          : { mcpServers: {} };
    } catch {
      console.error(`  [${agentLabel}] ${targetFile} is not valid JSON; leaving it untouched.`);
      return false;
    }
  }
  config.mcpServers = asRecord(config.mcpServers);
  if (config.mcpServers['huaweicloud-devkit']) {
    console.log(`  [${agentLabel}] mcpServers.huaweicloud-devkit already configured; skipping.`);
    return true;
  }
  if (existed) copyFileSync(targetFile, `${targetFile}.bak`);
  config.mcpServers['huaweicloud-devkit'] = { ...MCP_ENTRY };
  mkdirSync(dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, JSON.stringify(config, null, 2), 'utf8');
  console.log(`  [${agentLabel}] MCP server configured in ${targetFile}. Restart the session to apply.`);
  return true;
}

export function configureGenericMCP(): boolean {
  console.log('Configuring a generic MCP agent (MCP tools only; skills/hooks are not installed)...');
  const targets: Array<[string, string]> = [];
  const claudeFile = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json');
  if (existsSync(claudeFile)) targets.push(['Claude Code', claudeFile]);
  const cursorFile = join(homedir(), '.cursor', 'mcp.json');
  if (existsSync(cursorFile) || existsSync(join(homedir(), '.cursor'))) {
    targets.push(['Cursor', cursorFile]);
  }

  if (targets.length === 0) {
    printMCPConfigSnippet('No known MCP agent detected; here is a config snippet you can paste:');
    return false;
  }
  let anyConfigured = false;
  for (const [label, file] of targets) {
    if (configureMCPAgent(file, label)) anyConfigured = true;
  }
  if (!anyConfigured) {
    console.log('  Nothing to configure for the detected MCP agents.');
  }
  return anyConfigured;
}
