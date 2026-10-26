// The credential subsystem's stable public face (same exported names, same
// import path, same behavior — the safety-policy.ts precedent). The S1 store
// family (the JSON vault on disk, secret-ref resolution, the last-sync
// sidecar, backup/restore) lives in ./s1-store.ts and the R11 placeholder
// policy in ./credential-placeholder.ts; the CodeArts reader, STS expiry, the
// OBS config writer, and the resolution tiers still live here.
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { asText } from '../lib/as-text.ts';
import { asRecord } from '../lib/as-record.ts';
import { buildOnboardingSteps, makeError, type GuidanceStep } from './error-table.ts';
import { present } from './credential-placeholder.ts';
import { ensurePrivateMode, readGlobalCredentialsResolved } from './s1-store.ts';

// The S1 store family and the R11 placeholder policy.
export {
  globalCredentialsPath,
  readGlobalCredentials,
  resolveStoredRefs,
  readGlobalCredentialsResolved,
  readGlobalCredentialsStrict,
  writeGlobalCredentials,
  setConfiguredBySession,
  lastSyncPath,
  readLastSync,
  writeLastSync,
  backupGlobalCredentials,
  restoreGlobalCredentialsBackup,
  type StoredCredentials,
  type WriteGlobalCredentialsInput,
  type LastSyncRecord,
  type LastSyncMetadata,
  type StrictS1Read,
} from './s1-store.ts';
export { isPlaceholder } from './credential-placeholder.ts';

export interface CodeArtsCredentials {
  ak: string;
  sk: string;
  securityToken: string;
  region: string;
}

export interface ResolvedCredentials {
  ak: string;
  sk: string;
  securityToken: string;
  region: string;
}

export function obsConfigPath(): string {
  // obsutil reads its config from a fixed location (~/.obsutilconfig), independent
  // of HUAWEICLOUD_HOME. HCLOUD_OBS_CONFIG_PATH exists solely for hermetic test injection.
  return process.env.HCLOUD_OBS_CONFIG_PATH || join(homedir(), '.obsutilconfig');
}

// Pick the Huawei Cloud DevKit MCP server entry from a map using prefix matching.
// CodeArts Work marketplace presets keyed entries like `huaweicloud-devkit_1`
// (suffix per installed instance); match by prefix so `_1`/`_2`/`HuaweiCloud DevKit`
// all resolve without hardcoding an instance number.
// Deterministically choose the Huawei Cloud DevKit MCP server entry from a map.
// Priority (stable, independent of object key order):
//   1. exact `huaweicloud-devkit` (installer-managed key)
//   2. `HuaweiCloud Dev Kit`
//   3. prefixed instances `huaweicloud-devkit_N` sorted by ascending N
export function pickDevkitMcpServer(mcpMap: unknown): Record<string, unknown> | null {
  const map = asRecord(mcpMap);
  const keys = Object.keys(map);
  const rank = (k: string): number => {
    if (k === 'huaweicloud-devkit') return -2;
    if (k === 'HuaweiCloud DevKit') return -1;
    const m = /^huaweicloud-devkit_(\d+)$/i.exec(k);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  const candidates = keys
    .filter((k) => /^huaweicloud-devkit(?:_|$)/i.test(k) || k === 'HuaweiCloud DevKit')
    .sort((a, b) => rank(a) - rank(b));
  for (const k of candidates) {
    if (map[k]) return map[k] as Record<string, unknown>;
  }
  return null;
}

export interface StsExpiryInput {
  securityToken?: unknown;
  expiresAtEnv?: unknown;
}

// Derive the expiry (epoch ms) of a temporary STS credential set.
// Priority: 1) HW_STS_EXPIRES_AT env (ISO8601 or epoch seconds); 2) decode the
// security token (JWT payload or bare URL-safe base64 JSON) reading common
// expiry fields (exp, timeout_at, expires_at, id_expires_at; issued_at+duration).
// Returns null when unknown/unparseable. Never throws.
export function parseStsExpiry({ securityToken, expiresAtEnv = process.env.HW_STS_EXPIRES_AT }: StsExpiryInput = {}):
  number | null {
  if (expiresAtEnv) {
    const v = asText(expiresAtEnv).trim();
    if (!v) return null;
    const asNum = Number(v);
    if (Number.isFinite(asNum) && asNum > 0) return asNum > 1e12 ? asNum : asNum * 1000;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
    return null;
  }
  if (!securityToken || typeof securityToken !== 'string') return null;
  const token = String(securityToken).trim();
  if (!token) return null;

  const payload: unknown = ((): unknown => {
    try {
      if (token.includes('.')) {
        const parts = token.split('.');
        const b64 = parts.length >= 2 ? parts[1] : null;
        if (!b64) return null;
        const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        return JSON.parse(Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      }
      const pad = token + '='.repeat((4 - (token.length % 4)) % 4);
      return JSON.parse(Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    } catch {
      return null;
    }
  })();
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const exp = Number(record.exp ?? record.expires_at ?? record.timeout_at ?? Number.NaN);
  if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  const issued = Number(record.issued_at ?? record.iat ?? Number.NaN);
  const duration = Number(record.duration ?? record.expires_in ?? record.lifetime ?? Number.NaN);
  if (Number.isFinite(issued) && issued > 0 && Number.isFinite(duration) && duration > 0) {
    return (issued + duration) * 1000;
  }
  return null;
}

function readWorkEnvironmentEntry(config: unknown): CodeArtsCredentials | null {
  const server = pickDevkitMcpServer(asRecord(config).mcp);
  const environment = asRecord(server?.environment);
  const ak = environment.HW_ACCESS_KEY;
  const sk = environment.HW_SECRET_KEY;
  if (present(ak) && present(sk)) {
    const region = environment.HW_REGION || environment.HUAWEICLOUD_REGION;
    return {
      ak,
      sk,
      securityToken: present(environment.HW_SECURITY_TOKEN) ? environment.HW_SECURITY_TOKEN : '',
      region: asText(region || ''),
    };
  }
  return null;
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

export interface ResolveCredentialsOptions {
  allowMissing?: boolean;
}

export function resolveCredentials(options: ResolveCredentialsOptions = {}): ResolvedCredentials | null {
  // R11: placeholder/masked env values are "not configured", never credentials.
  const envAk = process.env.HW_ACCESS_KEY;
  const envSk = process.env.HW_SECRET_KEY;
  const envSecurityToken = process.env.HW_SECURITY_TOKEN;
  let ak = present(envAk) ? envAk : '';
  let sk = present(envSk) ? envSk : '';
  let securityToken = present(envSecurityToken) ? envSecurityToken : '';
  let region = process.env.HW_REGION || process.env.HUAWEICLOUD_REGION || '';

  const codeartsCreds = isCodeArtsContext() ? readCodeArtsCredentials() : null;
  if (codeartsCreds) {
    if (!ak && codeartsCreds.ak) ak = codeartsCreds.ak;
    if (!sk && codeartsCreds.sk) sk = codeartsCreds.sk;
    if (!securityToken && codeartsCreds.securityToken) securityToken = codeartsCreds.securityToken;
    if (!region && codeartsCreds.region) region = codeartsCreds.region;
  }

  const stored = readGlobalCredentialsResolved();
  if (stored) {
    // R11: skip placeholder/masked values from the vault too (templates must
    // not win the truthiness check and shadow another store).
    if (!ak && present(stored.ak)) ak = stored.ak;
    if (!sk && present(stored.sk)) sk = stored.sk;
    if (!securityToken && present(stored.securityToken)) securityToken = stored.securityToken;
    if (!region && typeof stored.region === 'string' && stored.region) region = stored.region;
  }

  // R9: S1 written by `auth_switch persist` (configuredBySession) is the session's
  // source of truth and wins over env-injected defaults. Plain S1 (`auth init`)
  // still yields to env so devspace-style env injection keeps working.
  if (stored && stored.configuredBySession === true && present(stored.ak) && present(stored.sk)) {
    ak = stored.ak;
    sk = stored.sk;
    if (!securityToken) securityToken = present(stored.securityToken) ? stored.securityToken : '';
    if (!region && typeof stored.region === 'string' && stored.region) region = stored.region;
  }

  // Sandbox/platform-injected temporary STS credentials (env vars carrying a
  // security token) must not shadow the user's explicit permanent credentials
  // from `auth init`. Prefer the stored file when both exist.
  const envHasFullTriplet = present(envAk) && present(envSk) && present(envSecurityToken);
  if (envHasFullTriplet && stored && present(stored.ak) && present(stored.sk)) {
    ak = stored.ak;
    sk = stored.sk;
    securityToken = present(stored.securityToken) ? stored.securityToken : '';
    region = typeof stored.region === 'string' && stored.region ? stored.region : region;
  }

  if (!ak || !sk) {
    if (options.allowMissing) return null;
    // #900: unified guidance — one steps builder shared with computeOnboarding,
    // and the error shape from the single ERROR_TABLE. Zero IO beyond the
    // readCodeArtsCredentials() probe we already do for scenario routing.
    const codeartsCreds = readCodeArtsCredentials();
    const injectedAvailable = present(codeartsCreds?.ak) && present(codeartsCreds?.sk);
    const codearts = isCodeArtsContext();
    const err = makeError('HDKIT_CRED_MISSING') as MissingCredentialError;
    err.onboarding = injectedAvailable
      ? {
          scenario: 4,
          reason: 'import-injected',
          message: '检测到配置中已有有效账号,可导入为正式凭证。',
          steps: buildOnboardingSteps(4, { codearts }),
        }
      : {
          scenario: 3,
          reason: 's1-missing',
          message: '未配置华为云凭证,需要完成登录后才能使用云能力。',
          steps: buildOnboardingSteps(3, { codearts }),
        };
    throw err;
  }

  return { ak, sk, securityToken, region };
}

interface OnboardingHint {
  scenario: number;
  reason: string;
  message: string;
  steps: Array<Record<string, unknown> | GuidanceStep>;
}

// The table error plus the resolver's onboarding hint (#900 shape union).
type MissingCredentialError = ReturnType<typeof makeError> & { onboarding?: OnboardingHint };

let _parentCwd: string | null | undefined = undefined;

export function getParentCwd(): string | null {
  if (_parentCwd !== undefined) return _parentCwd;
  try {
    _parentCwd = readlinkSync(`/proc/${process.ppid}/cwd`);
    return _parentCwd;
  } catch {
    _parentCwd = null;
    return null;
  }
}

// Shared with service.ts's computeOnboarding (#900): the codearts flag must
// select the identical builder variant on the resolver failure path and the
// status path — one detector, both call sites.
export function isCodeArtsContext(): boolean {
  return (
    existsSync(join(process.cwd(), '.codeartsdoer')) ||
    existsSync(join(homedir(), '.codeartsdoer')) ||
    existsSync(join(homedir(), '.codeartswork')) ||
    existsSync(join(homedir(), '.codearts'))
  );
}

export function readCodeArtsCredentials(): CodeArtsCredentials | null {
  const parentCwd = getParentCwd();
  const searchDirs = [process.env.CODEARTS_PROJECT_DIR, parentCwd, process.cwd(), homedir()];

  for (const dir of searchDirs) {
    if (!dir) continue;
    const path = join(dir, '.codeartsdoer', 'mcp', 'mcp_settings.json');
    try {
      if (!existsSync(path)) continue;
      const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const server = pickDevkitMcpServer(asRecord(config).mcpServers);
      const env = asRecord(server?.env);
      if (!server || !server.env) continue;

      const ak = env.HW_ACCESS_KEY;
      const sk = env.HW_SECRET_KEY;
      if (present(ak) && present(sk)) {
        const region = env.HW_REGION || env.HUAWEICLOUD_REGION;
        return {
          ak,
          sk,
          securityToken: present(env.HW_SECURITY_TOKEN) ? env.HW_SECURITY_TOKEN : '',
          region: asText(region || ''),
        };
      }
    } catch {
      // mcp_settings.json missing or invalid — skip
    }
  }

  // CodeArts Work — user-level only.
  // New layout (post platform migration): ~/.codearts/mcp/mcp_settings.json with
  // prefixed keys like `huaweicloud-devkit_1`; legacy ~/.codeartswork kept as
  // fallback while still in service.
  const workPaths = [
    join(homedir(), '.codearts', 'mcp', 'mcp_settings.json'),
    join(homedir(), '.codeartswork', 'mcp', 'mcp_settings.json'),
  ];
  for (const path of workPaths) {
    try {
      if (!existsSync(path)) continue;
      const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const entry = readWorkEnvironmentEntry(config);
      if (entry) return entry;
    } catch {
      // mcp_settings.json missing or invalid — skip
    }
  }

  return null;
}

let runtimeCredentials: ResolvedCredentials | null = null;

export function setRuntimeCredentials(ak: unknown, sk: unknown, securityToken?: unknown, region?: unknown): void {
  runtimeCredentials = {
    ak: asText(ak ?? ''),
    sk: asText(sk ?? ''),
    securityToken: asText(securityToken || ''),
    region: asText(region || ''),
  };
}

export function clearRuntimeCredentials(): void {
  runtimeCredentials = null;
}

export function hasRuntimeCredentials(): boolean {
  return runtimeCredentials !== null;
}

export function resolveCredentialsWithRuntime(options: ResolveCredentialsOptions = {}): ResolvedCredentials | null {
  if (runtimeCredentials) {
    return {
      ak: runtimeCredentials.ak,
      sk: runtimeCredentials.sk,
      securityToken: runtimeCredentials.securityToken,
      region: runtimeCredentials.region,
    };
  }

  return resolveCredentials(options);
}
