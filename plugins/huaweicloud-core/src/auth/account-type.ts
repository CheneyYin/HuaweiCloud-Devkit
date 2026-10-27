import { runHcloud } from '../hcloud-cli.ts';
import { asText } from '../lib/as-text.ts';

// #954 (1.1.10): parse `hcloud STS GetCallerIdentity` stdout into structured
// identity fields. URN forms (see the IAM 5.0 usermanual):
//   iam::<account_id>:user:<username>            — user credentials (primary or IAM sub-user)
//   sts::<account_id>::assumed-agency:<name>/…   — agency session credentials (rule does not apply)
export interface ParsedCallerIdentity {
  ok: true;
  accountId: string;
  principalUrn: string;
  principalId: string | undefined;
  urnType: 'user' | 'agency' | 'unknown';
  username: string | undefined;
}
export interface ParsedCallerIdentityError {
  ok: false;
  error: string;
}

export function parseCallerIdentity(stdout: unknown): ParsedCallerIdentity | ParsedCallerIdentityError {
  let parsed: unknown;
  try {
    parsed = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
  } catch {
    return { ok: false, error: 'GetCallerIdentity returned non-JSON output.' };
  }
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  if (
    typeof record.principal_urn !== 'string' ||
    typeof record.account_id !== 'string' ||
    !record.principal_urn ||
    !record.account_id
  ) {
    return { ok: false, error: 'GetCallerIdentity response missing principal_urn/account_id.' };
  }
  const principalUrn = record.principal_urn;
  let urnType: 'user' | 'agency' | 'unknown' = 'unknown';
  let username: string | undefined;
  const userMatch = principalUrn.match(/^iam::[^:]+:user:(.+)$/);
  if (userMatch) {
    urnType = 'user';
    username = userMatch[1];
  } else if (/^sts::/.test(principalUrn) || /assumed-agency/.test(principalUrn)) {
    urnType = 'agency';
  }
  return {
    ok: true,
    accountId: record.account_id,
    principalUrn,
    principalId: record.principal_id != null ? asText(record.principal_id) : undefined,
    urnType,
    username,
  };
}

export interface ParsedAuthDomains {
  ok: true;
  domains: Array<{ id: string; name: string }>;
}
export interface ParsedAuthDomainsError {
  ok: false;
  error: string;
}

// #954: parse `hcloud IAM KeystoneListAuthDomains` stdout into the domain list.
export function parseAuthDomains(stdout: unknown): ParsedAuthDomains | ParsedAuthDomainsError {
  let parsed: unknown;
  try {
    parsed = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
  } catch {
    return { ok: false, error: 'KeystoneListAuthDomains returned non-JSON output.' };
  }
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const rawDomains = Array.isArray(record.domains) ? record.domains : [];
  const domains = rawDomains
    .filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object' && !Array.isArray(d))
    .map((d) => ({ id: asText(d.id ?? ''), name: asText(d.name ?? '') }));
  if (domains.length === 0) {
    return { ok: false, error: 'IAM returned no domain information. Verify the AK/SK is valid.' };
  }
  return { ok: true, domains };
}

export interface AccountTypeVerdict {
  ok: true;
  applicable: boolean;
  isPrimaryAccount?: boolean;
  domainId?: string;
  domainName?: string;
  username?: string;
  userId?: string;
  principalUrn: string;
  evidence?: string;
  reason?: string;
}
export interface AccountTypeError {
  ok: false;
  error: string;
}

// #954: judge primary vs sub-account. Rule (validated against 6 real
// credentials + 1 report case):
//   username == domainName  -> primary account (its operator user is named after the domain)
//   username != domainName  -> IAM sub-user (a sub-user cannot occupy the domain name)
// Two tempting-but-wrong rules, kept here so they are not "rediscovered":
//   - ShowDomainPasswordPolicy is NOT primary-only (it is permission-gated; a sub-user with IAM
//     permissions can call it) — observed live.
//   - principal_id == account_id does NOT hold for primary accounts either — observed on three
//     separate primary-account samples.
export function judgeAccountType(
  identity: ParsedCallerIdentity,
  domains: ParsedAuthDomains,
): AccountTypeVerdict | AccountTypeError {
  if (identity.urnType !== 'user') {
    return {
      ok: true,
      applicable: false,
      reason:
        'Credentials are an agency session (principal_urn is not iam::…:user:…). ' +
        'The primary/sub-account judgment applies to user credentials only.',
      principalUrn: identity.principalUrn,
    };
  }
  const matched = domains.domains.find((d) => d.id === identity.accountId);
  if (!matched) {
    return {
      ok: false,
      error:
        'Inconsistent identity response: GetCallerIdentity account_id does not match any domain ' +
        'returned by KeystoneListAuthDomains. Retry, and re-run "npx huaweicloud-devkit auth init" if it persists.',
    };
  }
  const username = identity.username ?? '';
  const isPrimaryAccount = username === matched.name;
  return {
    ok: true,
    applicable: true,
    isPrimaryAccount,
    domainId: matched.id,
    domainName: matched.name,
    username,
    userId: identity.principalId,
    principalUrn: identity.principalUrn,
    evidence: isPrimaryAccount
      ? `username == domainName ("${username}") — the primary account's operator user is named after the domain.`
      : `username ("${username}") != domainName ("${matched.name}") — the caller is an IAM user under the domain.`,
  };
}

// #954: orchestrate the two read-only hcloud calls and judge the account type.
export async function checkAccountType({ region }: { region?: string } = {}): Promise<unknown> {
  const regionArgs = region ? [`--cli-region=${region}`] : [];
  const identityResult = await runHcloud(['STS', 'GetCallerIdentity', ...regionArgs], {
    timeoutMs: 30000,
    maxRetries: 0,
  }).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (!('ok' in identityResult && identityResult.ok)) {
    const failed = identityResult as { ok: false; error?: string };
    return {
      ok: false,
      error: failed.error || 'STS GetCallerIdentity failed.',
      hint: 'Re-run "npx huaweicloud-devkit auth init" (invalid/expired AK/SK is the most common cause, e.g. APIGW.0301).',
    };
  }
  const identity = parseCallerIdentity((identityResult as { stdout?: string }).stdout);
  if (!identity.ok) {
    return { ok: false, error: identity.error };
  }

  const domainsResult = await runHcloud(['IAM', 'KeystoneListAuthDomains'], {
    timeoutMs: 30000,
    maxRetries: 0,
  }).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (!('ok' in domainsResult && domainsResult.ok)) {
    const failed = domainsResult as { ok: false; error?: string };
    return {
      ok: false,
      error: failed.error || 'IAM KeystoneListAuthDomains failed.',
      hint: 'Re-run "npx huaweicloud-devkit auth init" if credentials are suspected expired.',
    };
  }
  const domains = parseAuthDomains((domainsResult as { stdout?: string }).stdout);
  if (!domains.ok) {
    return { ok: false, error: domains.error };
  }

  return judgeAccountType(identity, domains);
}
