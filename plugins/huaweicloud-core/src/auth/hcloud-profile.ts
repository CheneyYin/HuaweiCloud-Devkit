// The KooCLI profile configure/verify helpers and the auth status printers,
// extracted from setup-cli.ts. resolveHcloudCommand (not a bare
// findHcloudBin) is load-bearing in both spawns: it honors the
// HCLOUD_BIN_ARGS_JSON node-launch convention.

import { spawnSync } from 'node:child_process';

import { resolveHcloudCommand } from '../hcloud-probe.ts';
import { resolveManagedProfile } from './reconcile.ts';
import { redactSecrets } from '../safety-policy.ts';
import { asText } from '../lib/as-text.ts';
import { asRecord } from '../lib/as-record.ts';

export function configuredProfileName(): string {
  const name = resolveManagedProfile();
  return name || 'default';
}

export function configureHcloud(credentials: { ak: unknown; sk: unknown; region?: unknown }): {
  ok: boolean;
  code: number | null;
  error: string;
} {
  // resolveHcloudCommand (not a bare findHcloudBin): honors the
  // HCLOUD_BIN_ARGS_JSON node-launch convention — critical now that the
  // #920 purge deletes the profile BEFORE this write; a bare-binary spawn
  // that deterministically fails would leave the deleted profile unrestored.
  const { executable, argsPrefix } = resolveHcloudCommand();
  const args = [
    'configure',
    'set',
    `--cli-profile=${configuredProfileName()}`,
    `--cli-access-key=${asText(credentials.ak)}`,
    `--cli-secret-key=${asText(credentials.sk)}`,
    `--cli-region=${asText(credentials.region || '')}`,
  ];
  const r = spawnSync(executable, [...argsPrefix, ...args], {
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
    timeout: 30000,
  });
  return {
    ok: r.status === 0,
    code: r.status,
    error: redactSecrets(
      String(r.stderr || '')
        .trim()
        .slice(0, 240),
    ),
  };
}

// Verify that the freshly written KooCLI profile can actually authenticate
// (#920): a stale/expired security token in the profile survives
// `configure set` (it refuses empty values) and poisons every hcloud call with
// APIGW.0301 — while the setup output still claims success. Probe with a real
// `hcloud STS GetCallerIdentity` and only report synchronized when it passes.
export function verifyHcloudIdentity(region: string): { ok: boolean; code: number | null; error: string } {
  // An empty region must be omitted entirely — `--cli-region=` sends a
  // literal empty value that KooCLI rejects as an invalid region.
  const args = ['STS', 'GetCallerIdentity'];
  if (region) args.push(`--cli-region=${region}`);
  // resolveHcloudCommand (not a bare findHcloudBin): honors the
  // HCLOUD_BIN_ARGS_JSON node-launch convention every other spawn in this
  // flow uses — a bare binary path would run `node STS GetCallerIdentity`.
  const { executable, argsPrefix } = resolveHcloudCommand();
  const r = spawnSync(executable, [...argsPrefix, ...args], {
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
    timeout: 30000,
  });
  const output = `${String(r.stdout || '')}${String(r.stderr || '')}`;
  return {
    ok: r.status === 0 && !/APIGW\.0301|Incorrect IAM authentication/i.test(output),
    code: r.status,
    error: redactSecrets(
      String(r.stderr || r.stdout || '')
        .trim()
        .slice(0, 240),
    ),
  };
}

export function printAuthAgents(agents: Record<string, unknown> = {}): void {
  for (const [agent, info] of Object.entries(agents)) {
    console.log(`  ${agent}: ${asRecord(info).configured ? '[OK]' : '[MISSING]'}`);
  }
}

// getAuthStatus returns an inferred shape; only the fields printed here are
// consumed, so the printer declares just those.
export interface AuthStatusSummary {
  credentialsConfigured: unknown;
  credentialsPath: unknown;
  obsConfigured: unknown;
  obsConfigPath: unknown;
  kooCliInstalled: unknown;
  agents: unknown;
  reconciled?: { s1RefError?: unknown };
}

export function printAuthStatus(status: AuthStatusSummary): void {
  console.log(
    `Credentials vault: ${status.credentialsConfigured ? 'configured' : 'missing'} (${String(status.credentialsPath)})`,
  );
  const rawS1RefError = asRecord(status.reconciled).s1RefError;
  const s1RefError = typeof rawS1RefError === 'string' ? rawS1RefError : null;
  if (s1RefError) {
    console.log(
      `\x1b[31mS1 vault ref error: ${s1RefError}\x1b[0m — fix the vault (npx huaweicloud-devkit secret list) or replace the refs in ~/.config/huaweicloud/credentials.json with plaintext.`,
    );
  }
  console.log(`OBS config: ${status.obsConfigured ? 'configured' : 'missing'} (${String(status.obsConfigPath)})`);
  console.log(`KooCLI: ${status.kooCliInstalled ? 'installed' : 'missing'}`);
  console.log('Agent MCP registration:');
  printAuthAgents(asRecord(status.agents));
}
