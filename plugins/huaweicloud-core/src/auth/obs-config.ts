// The OBS config writer (the S4 mirror), extracted from the credentials
// monolith (the stable src/auth/credentials.ts face re-exports this family):
// the ~/.obsutilconfig KooCLI-style flat key=value file OBS tooling reads.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { asText } from '../lib/as-text.ts';
import { makeError } from './error-table.ts';
import { ensurePrivateMode } from './s1-store.ts';

export function obsConfigPath(): string {
  // obsutil reads its config from a fixed location (~/.obsutilconfig), independent
  // of HUAWEICLOUD_HOME. HCLOUD_OBS_CONFIG_PATH exists solely for hermetic test injection.
  return process.env.HCLOUD_OBS_CONFIG_PATH || join(homedir(), '.obsutilconfig');
}

export interface WriteObsConfigInput {
  ak?: unknown;
  sk?: unknown;
  securityToken?: unknown;
  region?: unknown;
  endpoint?: unknown;
}

export function writeObsConfig(credentials: WriteObsConfigInput = {}): { path: string; endpoint: string } {
  const region = asText(credentials.region || '');
  const ak = asText(credentials.ak || '');
  const sk = asText(credentials.sk || '');
  const securityToken = asText(credentials.securityToken || '');
  if (!region || !ak || !sk) {
    // #900: unified error shape from the shared ERROR_TABLE.
    throw makeError('HDKIT_CRED_REGION_MISSING');
  }
  const path = obsConfigPath();
  const endpoint = asText(credentials.endpoint || `https://obs.${region}.myhuaweicloud.com`);
  // Flat key=value format (no [default] section) as written by KooCLI 7.x `hcloud OBS config`.
  const content = `endpoint=${endpoint}\nak=${ak}\nsk=${sk}${securityToken ? `\ntoken=${securityToken}` : ''}\n`;
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  ensurePrivateMode(path);
  return { path, endpoint };
}
