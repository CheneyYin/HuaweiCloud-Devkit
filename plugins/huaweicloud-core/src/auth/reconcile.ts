import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  hasRuntimeCredentials,
  isPlaceholder,
  obsConfigPath,
  readGlobalCredentialsResolved,
  readLastSync,
  resolveCredentialsWithRuntime,
} from './credentials.ts';
import { errorFromTable } from './error-table.ts';
import { resolveHcloudCommand } from '../hcloud-probe.ts';
import { redactSecrets } from '../safety-policy.ts';
import { asText } from '../lib/as-text.ts';
import { asRecord } from '../lib/as-record.ts';

export { hasRuntimeCredentials };

export interface KooCliProfile {
  name: string;
  fingerprint: string;
  accessKeyId: string;
  encrypted: boolean;
}

export interface KooCliProfiles {
  current: string;
  mtimeMs: number;
  configPath: string;
  authEncrypt: boolean;
  profiles: KooCliProfile[];
}

export interface KooCliProfilesError {
  error: string;
  // #900: unified shape from the shared ERROR_TABLE (auth/error-table.ts).
  code?: string;
  messageZh?: string;
  action?: string;
  nextStep?: string;
}

export type KooCliProfilesResult = KooCliProfiles | KooCliProfilesError;

export interface ObsConfig {
  ak: string;
  sk: string;
  region: string;
}

export interface Inconsistency {
  store: string;
  source: string;
  fingerprint: string | null;
  manualModified: boolean;
}

export interface ScanState {
  stores: {
    s1Fingerprint: string;
    envFingerprint: string;
    currentFingerprint: string | null;
    s3Fingerprint: string | null;
    runtimeFingerprint: string | null;
  };
  kooCliCurrent: string | null;
  envIsPlaceholder: boolean;
  s2Encrypted: boolean;
  /** Non-null when S1 holds a secret:// ref the vault cannot resolve. */
  s1RefError: string | null;
  inconsistencies: Inconsistency[];
  hasRuntime: boolean;
  runtimeFingerprint: string | null;
}

interface LastSyncRecord {
  ts?: unknown;
  kooCliProfile?: unknown;
  s1Fingerprint?: unknown;
}

function toLastSync(value: unknown): LastSyncRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function kooCliConfigPath(): string {
  // KooCLI keeps its config at a fixed location (~/.hcloud/config.json),
  // independent of HUAWEICLOUD_HOME (that env only relocates devkit's own S1/S3).
  // HCLOUD_CONFIG_PATH exists solely for hermetic test injection.
  return process.env.HCLOUD_CONFIG_PATH || join(homedir(), '.hcloud', 'config.json');
}

export function fingerprint(ak?: unknown, sk?: unknown): string {
  if (!ak || !sk) return '';
  return createHash('sha256')
    .update(`${asText(ak)}${asText(sk)}`)
    .digest('hex')
    .slice(0, 8);
}

export function isManualModified(path: string): boolean {
  if (!existsSync(path)) return false;
  const lastSyncRaw: unknown = readLastSync();
  try {
    const fts = statSync(path).mtimeMs;
    if (!lastSyncRaw) return true; // no marker → treat as manual
    return fts > Number(toLastSync(lastSyncRaw).ts);
  } catch {
    return false;
  }
}

export function readKooCliProfiles(): KooCliProfilesResult {
  const configPath = kooCliConfigPath();
  if (!existsSync(configPath)) {
    // #900: bare string replaced by the unified ERROR_TABLE shape; the old
    // English text survives only as the distinguishing detail argument.
    const e = errorFromTable('HDKIT_KOOCLI_NOT_READY', 'KooCLI config not found');
    return { error: e.messageZh, code: e.code, messageZh: e.messageZh, action: e.action, nextStep: e.nextStep };
  }
  try {
    const raw = asRecord(JSON.parse(readFileSync(configPath, 'utf8')));
    const current = asText(raw.current || 'default');
    const profiles: unknown[] = Array.isArray(raw.profiles) ? raw.profiles : [];
    const mtimeMs = statSync(configPath).mtimeMs;
    // KooCLI 7.x stores AK/SK encrypted (authEncrypt=true): the on-disk values
    // are ciphertext, so a fingerprint computed from them can never match the
    // plaintext S1/S3 stores. Blind the comparable fields instead of treating
    // ciphertext as a real credential and misreporting a S2 drift (#533).
    // KooCLI serializes the flag as the string "true", not a boolean.
    const encrypted = raw.authEncrypt === true || raw.authEncrypt === 'true';
    return {
      current,
      mtimeMs,
      configPath,
      authEncrypt: encrypted,
      profiles: profiles.map((p) => {
        const profile = asRecord(p);
        return encrypted
          ? { name: asText(profile.name || ''), fingerprint: '', accessKeyId: '', encrypted: true }
          : {
              name: asText(profile.name || ''),
              fingerprint: fingerprint(profile.accessKeyId, profile.secretAccessKey),
              accessKeyId: asText(profile.accessKeyId || ''),
              encrypted: false,
            };
      }),
    };
  } catch {
    // #900: bare string replaced by the unified ERROR_TABLE shape.
    const e = errorFromTable('HDKIT_KOOCLI_NOT_READY', 'KooCLI config parse failed');
    return { error: e.messageZh, code: e.code, messageZh: e.messageZh, action: e.action, nextStep: e.nextStep };
  }
}

export function resolveManagedProfile(): string | null {
  const res = readKooCliProfiles();
  if ('error' in res) return null;
  return res.current;
}

export function currentFingerprintFromHcloud(res: KooCliProfilesResult): string | null {
  if ('error' in res) return null;
  const cur = res.profiles.find((p) => p.name === res.current);
  return cur ? cur.fingerprint : null;
}

function currentProfileFromHcloud(res: KooCliProfilesResult): KooCliProfile | null {
  if ('error' in res) return null;
  return res.profiles.find((p) => p.name === res.current) || null;
}

function s2CurrentMatchesLastDevkitSync(
  kooCli: KooCliProfilesResult,
  s1: Record<string, unknown>,
  s1Fingerprint: string,
): boolean {
  if ('error' in kooCli) return false;
  const current = currentProfileFromHcloud(kooCli);
  const lastSync = toLastSync(readLastSync());
  if (!current || !lastSync.ts || !lastSync.kooCliProfile || !lastSync.s1Fingerprint) return false;
  if (!s1.ak || current.accessKeyId !== s1.ak) return false;
  if (lastSync.kooCliProfile !== kooCli.current) return false;
  if (lastSync.s1Fingerprint !== s1Fingerprint) return false;
  return Number(kooCli.mtimeMs || 0) <= Number(lastSync.ts) + 1000;
}

export function scanState(): ScanState {
  // S1 refs resolve through the shared seam so fingerprints compare plaintext
  // against plaintext (S2/S3). An unresolvable ref must not crash status
  // reporting: it surfaces as s1RefError and suppresses the drift checks
  // (their fingerprints would be meaningless against ref strings).
  let s1: Record<string, unknown> = {};
  let s1RefError: string | null = null;
  try {
    s1 = asRecord(readGlobalCredentialsResolved());
  } catch (error) {
    s1RefError = error instanceof Error ? error.message : String(error);
  }
  const envAk = isPlaceholder(process.env.HW_ACCESS_KEY) ? '' : process.env.HW_ACCESS_KEY || '';
  const envSk = isPlaceholder(process.env.HW_SECRET_KEY) ? '' : process.env.HW_SECRET_KEY || '';
  const kooCli = readKooCliProfiles();
  const inconsistencies: Inconsistency[] = [];
  const envIsPlaceholder =
    Boolean(process.env.HW_ACCESS_KEY && isPlaceholder(process.env.HW_ACCESS_KEY)) ||
    Boolean(process.env.HW_SECRET_KEY && isPlaceholder(process.env.HW_SECRET_KEY));

  const s1Fingerprint = s1RefError ? '' : fingerprint(s1.ak, s1.sk);
  const currentFp = currentFingerprintFromHcloud(kooCli);
  const s2SyncedByDevkit = s1Fingerprint ? s2CurrentMatchesLastDevkitSync(kooCli, s1, s1Fingerprint) : false;
  const effectiveCurrentFp = s2SyncedByDevkit ? s1Fingerprint : currentFp;
  const envFingerprint = fingerprint(envAk, envSk);
  const s3 = existsSync(obsConfigPath()) ? parseS3ObsConfig(obsConfigPath()) : null;
  const s3Fingerprint = s3 ? fingerprint(s3.ak, s3.sk) : null;

  let hasRuntime = false;
  let runtimeFingerprint: string | null = null;
  try {
    const rt = asRecord(resolveCredentialsWithRuntime());
    hasRuntime = hasRuntimeCredentials();
    if (hasRuntime) runtimeFingerprint = fingerprint(rt.ak, rt.sk);
  } catch {
    // nothing resolvable → runtime store inactive
  }

  if (s1Fingerprint && currentFp && s1Fingerprint !== effectiveCurrentFp) {
    inconsistencies.push({
      store: 'S2-current',
      source: 'KooCLI current profile',
      fingerprint: currentFp,
      manualModified: isManualModified(
        'error' in kooCli ? kooCliConfigPath() : kooCli.configPath || kooCliConfigPath(),
      ),
    });
  }
  if (s1Fingerprint && s3Fingerprint && s1Fingerprint !== s3Fingerprint) {
    inconsistencies.push({
      store: 'S3',
      source: 'obsutilconfig',
      fingerprint: s3Fingerprint,
      manualModified: isManualModified(obsConfigPath()),
    });
  }

  return {
    stores: {
      s1Fingerprint,
      envFingerprint,
      currentFingerprint: effectiveCurrentFp,
      s3Fingerprint,
      runtimeFingerprint,
    },
    kooCliCurrent: 'error' in kooCli ? null : kooCli.current,
    // R11: env carries placeholder/masked values → surface that explicitly so
    // diagnostics don't show a bogus fingerprint derived from template text.
    envIsPlaceholder,
    // S2 is encrypted storage (authEncrypt) → its fingerprint is unavailable,
    // so the S2-current drift check is intentionally skipped (#533).
    s2Encrypted: Boolean(!('error' in kooCli) && kooCli.authEncrypt),
    s1RefError,
    inconsistencies,
    hasRuntime,
    runtimeFingerprint,
  };
}

function parseS3ObsConfig(path: string): ObsConfig | null {
  try {
    const text = readFileSync(path, 'utf8');
    const get = (k: string): string => {
      const m = text.match(new RegExp(`^${k}=(.+)$`, 'm'));
      return m ? m[1]!.trim() : '';
    };
    return { ak: get('ak'), sk: get('sk'), region: inferRegion(text) };
  } catch {
    return null;
  }
}

function inferRegion(text: string): string {
  const m = text.match(/endpoint=https:\/\/obs\.([^.]+)\./);
  return m ? m[1]! : '';
}

export function exportStateForStatus(_jailed?: boolean) {
  const scan = scanState();
  return {
    ...scan,
    // fields below are consumed by getAuthStatus in service.ts
    inconsistent: scan.inconsistencies.length > 0,
  };
}

// Shared spawn shape for the KooCLI configure verbs: ok + redacted stderr.
function runHcloudConfigureArgs(args: string[]): { ok: boolean; error: string } {
  const { executable, argsPrefix } = resolveHcloudCommand();
  const r = spawnSync(executable, [...argsPrefix, ...args], {
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
    timeout: 30000,
  });
  return {
    ok: r.status === 0,
    error: redactSecrets(
      String(r.stderr || '')
        .trim()
        .slice(0, 240),
    ),
  };
}

export function runHcloudConfigure(
  profile: string,
  ak: string,
  sk: string,
  region?: string,
): { ok: boolean; error: string } {
  return runHcloudConfigureArgs([
    'configure',
    'set',
    `--cli-profile=${profile}`,
    `--cli-access-key=${ak}`,
    `--cli-secret-key=${sk}`,
    `--cli-region=${region || ''}`,
  ]);
}

// Delete a KooCLI profile (best-effort). The #920 purge seam, shared by ALL
// THREE KooCLI write paths (the auth_switch persist tool path, syncAuth, and
// the setup-cli `auth init` path): `configure set` REFUSES an empty --cli-security-token, so
// a stale/expired token already in the profile can never be overwritten — it
// poisons every hcloud call with APIGW.0301 while the writer still reports
// success. The documented manual bypass is `hcloud configure delete
// --cli-profile=<profile>` followed by a re-configure; this helper makes that
// path a runtime step instead of user knowledge.
// A missing profile reports a non-zero status, which callers treat as
// "nothing to clean" — never as an error.
export function runHcloudProfileDelete(profile: string): { ok: boolean; error: string } {
  return runHcloudConfigureArgs(['configure', 'delete', `--cli-profile=${profile}`]);
}
