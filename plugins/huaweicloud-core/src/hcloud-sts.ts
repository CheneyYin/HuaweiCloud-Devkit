// Temporary-STS credential handling for the KooCLI execution path,
// extracted from the hcloud-cli monolith (the stable src/hcloud-cli.ts
// face re-exports resolveStsInjectArgs): the command-line
// credential-injection resolver (obsutil-style -i/-k/-t for OBS,
// --cli-* flags for the rest), its kill-switch and wrapper guards, and
// the already-expired probe the run engine fails fast on.

import { parseStsExpiry, resolveCredentialsWithRuntime } from './auth/credentials.ts';

// Boundary narrowing for credential-shaped values: only string fields survive,
// so callers keep truthiness checks and string plumbing.
interface CredentialLike {
  ak?: string;
  sk?: string;
  securityToken?: string;
}

function asCreds(value: unknown): CredentialLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const result: CredentialLike = {};
  if (typeof record.ak === 'string') result.ak = record.ak;
  if (typeof record.sk === 'string') result.sk = record.sk;
  if (typeof record.securityToken === 'string') result.securityToken = record.securityToken;
  return result;
}

// Build command-line credential-injection args when the current credentials are
// temporary STS (carry a non-empty security token). KooCLI/obsutil do not read the
// platform-injected HW_* env (link B reads only S2/S3 config), so for a live STS
// credential set that R3 forbids writing to disk, we pass it per-command instead.
// Zero-persist: nothing touches S1/S2/S3 and every invocation re-reads the current
// value (stale as soon as the token is).
export function resolveStsInjectArgs(rawArgs: unknown): string[] {
  const normalized = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  if (normalized.length === 0) return [];
  const flat = normalized.map(String);

  // Explicit kill-switch (R2): CI/ops can disable argv-injection entirely so the
  // temporary STS never appears in a process list.
  const flag = process.env.HUAWEICLOUD_INJECT_STS_CMD;
  if (flag === '0' || flag === 'false') return [];

  // Never inject for help / metadata subcommands — the flags are meaningless there.
  if (flat.some((a) => a === '--help' || a === '-h' || a === 'help')) return [];

  // Wrapper invocation (bash -c / sudo / sh ...): our extra args would land in the
  // wrapper's argv, not hcloud's — either ineffective or misleading. Skip them.
  const WRAP = new Set([
    'bash',
    'sh',
    'zsh',
    'dash',
    'bash.exe',
    'sh.exe',
    '/bin/bash',
    '/bin/sh',
    '/bin/zsh',
    '/bin/dash',
    'sudo',
  ]);
  const first = String(flat[0] || '').toLowerCase();
  if (WRAP.has(first)) return [];

  // KooCLI profile-management subcommands don't take --cli-security-token.
  if (first === 'configure' || first === 'config') return [];

  // If the caller already passed explicit credential flags, do not override them.
  if (
    flat.some(
      (a) =>
        a.startsWith('--cli-access-key=') || a.startsWith('--cli-secret-key=') || a.startsWith('--cli-security-token='),
    )
  ) {
    return [];
  }
  // Explicit obsutil-style credentials already present — standalone (-i AK) or
  // attached (-iAK) — should not be overridden by an extra injection.
  if (flat.some((a) => a === '-i' || a === '-k' || a === '-t' || /^-[ikt][A-Za-z0-9]/.test(a))) return [];

  const creds = asCreds(resolveCredentialsWithRuntime({ allowMissing: true }));
  if (!creds || !creds.ak || !creds.sk || !creds.securityToken) return [];

  // R3: if we can derive an expiry and the token is already at/within 60s of
  // expiring, skip injection — using a dead token would make a doomed IAM round
  // trip. If expiry is unknown/unparseable we keep the existing "inject anyway"
  // behavior (can't prove it's stale).
  // KNOWN asymmetry (inherited from main): the runHcloud CREDENTIAL_EXPIRED
  // gate fires only at true expiry, so in this grace window the command runs
  // under the KooCLI profile's credentials instead of the session STS.
  const expiry = parseStsExpiry({ securityToken: creds.securityToken });
  if (expiry !== null) {
    const grace = 60 * 1000;
    if (expiry <= Date.now() + grace) return [];
  }

  // flat mirrors normalized, which returned early above when empty.
  const isObs = flat[0]!.toUpperCase() === 'OBS';
  return isObs
    ? ['-i', creds.ak, '-k', creds.sk, '-t', creds.securityToken]
    : ['--cli-access-key=' + creds.ak, '--cli-secret-key=' + creds.sk, '--cli-security-token=' + creds.securityToken];
}

// Returns true when the current credentials are a TEMPORARY STS set that has
// already expired (per token expiry). Lets us fail fast with a clear
// CREDENTIAL_EXPIRED instead of letting a doomed IAM call return a misleading
// error. Permanent AK/SK (no token) and unparseable expiry are never treated
// as expired.
//
// Consumed by the run engine (hcloud-run.ts); not part of the face's
// public surface.
export function isTemporaryStsExpired(): boolean {
  let creds;
  try {
    creds = asCreds(resolveCredentialsWithRuntime({ allowMissing: true }));
  } catch {
    return false;
  }
  if (!creds?.securityToken) return false;
  const expiry = parseStsExpiry({ securityToken: creds.securityToken });
  if (expiry === null) return false; // unknown → don't block
  return expiry <= Date.now();
}
