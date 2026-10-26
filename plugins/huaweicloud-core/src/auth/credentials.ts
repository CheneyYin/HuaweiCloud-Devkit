// The credential subsystem's stable public face (same exported names, same
// import path, same behavior — the safety-policy.ts precedent). The S1 store
// family lives in ./s1-store.ts, the R11 placeholder policy in
// ./credential-placeholder.ts, the CodeArts context reader in
// ./codearts-context.ts, the STS expiry derivation in ./sts-expiry.ts, and
// the OBS config writer in ./obs-config.ts; the resolution tiers and the
// runtime credential state still live here.
import { asText } from '../lib/as-text.ts';
import { buildOnboardingSteps, makeError, type GuidanceStep } from './error-table.ts';
import { present } from './credential-placeholder.ts';
import { readGlobalCredentialsResolved } from './s1-store.ts';
import { isCodeArtsContext, readCodeArtsCredentials } from './codearts-context.ts';

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

// The CodeArts context reader, the STS expiry derivation, and the OBS config
// writer.
export {
  getParentCwd,
  isCodeArtsContext,
  readCodeArtsCredentials,
  pickDevkitMcpServer,
  type CodeArtsCredentials,
} from './codearts-context.ts';
export { parseStsExpiry, type StsExpiryInput } from './sts-expiry.ts';
export { obsConfigPath, writeObsConfig, type WriteObsConfigInput } from './obs-config.ts';

export interface ResolvedCredentials {
  ak: string;
  sk: string;
  securityToken: string;
  region: string;
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
