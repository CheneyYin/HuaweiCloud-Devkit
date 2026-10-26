// The session-scoped runtime credential override, extracted from the
// credentials monolith's resolver family (the stable
// src/auth/credentials.ts face re-exports this module): the in-memory tier
// that shadows every store until cleared.
import { asText } from '../lib/as-text.ts';
import { resolveCredentials, type ResolvedCredentials, type ResolveCredentialsOptions } from './credential-resolver.ts';

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
