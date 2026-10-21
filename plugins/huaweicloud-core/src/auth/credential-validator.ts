import { asRecord } from '../lib/as-record.ts';
import { fetchWithProxy } from '../proxy/proxy-agent.ts';
import { signSdkHmacRequest } from '../lib/hw-request-signing.ts';
import { errorFromTable } from './error-table.ts';

function iamBaseUrl(): string {
  return process.env.HW_IAM_ENDPOINT || 'https://iam.myhuaweicloud.com';
}

interface IamProject {
  id: string;
  name?: unknown;
}

// One-property reads off unknown parsed JSON; only an object with a non-empty
// string id is a usable project (IAM project ids are strings).
function toIamProject(value: unknown): IamProject | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { id?: unknown; name?: unknown };
  if (typeof record.id !== 'string' || record.id === '') return null;
  return { id: record.id, name: record.name };
}

function projectForRegion(projects: unknown[], region?: string): string | null {
  const usable = projects.map((p) => toIamProject(p)).filter((p): p is IamProject => p !== null);
  if (region) {
    const match = usable.find((p) => p.name === region);
    if (match) return match.id;
  }
  return usable.find((p) => p.id)?.id || null;
}

export interface ValidateIamCredentialsOptions {
  ak?: string;
  sk?: string;
  securityToken?: string;
  region?: string;
  timeoutMs?: number;
}

export interface IamValidationResult {
  valid: boolean;
  projectId: string | null;
  error: string | null;
  warning?: string | null;
  skipped?: boolean;
  // #900: unified shape from the shared ERROR_TABLE (auth/error-table.ts).
  code?: string;
  messageZh?: string;
  action?: string;
  nextStep?: string;
}

/**
 * Validate AK/SK by calling IAM KeystoneListProjects (read-only) with
 * SDK-HMAC-SHA256 request signing. A wrong SK produces an invalid signature,
 * which IAM rejects with HTTP 401 before any project data is returned.
 *
 * Returns { valid, projectId, error, warning, code, messageZh, action, nextStep }:
 * - valid: true when IAM verified the signature (or the rejection is not
 *   authentication-related), false when the credentials are unusable.
 * - projectId: first project matching `region`, else the first visible project.
 * - warning: set when credentials passed but project discovery was denied.
 * - code/messageZh/action/nextStep: unified #900 shape from the shared
 *   ERROR_TABLE (auth/error-table.ts). The English `error`/`warning` detail
 *   text is intentionally kept — existing consumers (sandbox_credentials,
 *   external string-matching tests) rely on it.
 */
export async function validateIamCredentials({
  ak,
  sk,
  securityToken,
  region,
  timeoutMs = 15000,
}: ValidateIamCredentialsOptions = {}): Promise<IamValidationResult> {
  if (!ak || !sk) {
    // #900: unified shape from the shared ERROR_TABLE; English detail kept.
    const e = errorFromTable('HDKIT_CRED_MISSING');
    return {
      valid: false,
      projectId: null,
      error: 'AK and SK are both required for credential validation.',
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: e.nextStep,
    };
  }

  const base = iamBaseUrl();
  const path = '/v3/projects';
  const query: Record<string, string> = region ? { name: region } : {};
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${base}${path}${qs ? `?${qs}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: { status: number; text(): Promise<string> };
  try {
    const headers = signSdkHmacRequest({ path, query, ak, sk, securityToken: securityToken, baseUrl: base });
    resp = await fetchWithProxy(url, { headers, signal: controller.signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const e = errorFromTable('HDKIT_CRED_UNEXPECTED', detail);
    return {
      valid: false,
      projectId: null,
      skipped: true,
      error: `IAM validation request failed (treating credentials as unverified): ${detail}`,
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: e.nextStep,
    };
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON body: asRecord(null) collapses to {}, so the error paths below fall back to the raw text
  }

  if (resp.status === 200) {
    const projects = Array.isArray(asRecord(data).projects) ? (asRecord(data).projects as unknown[]) : [];
    return { valid: true, projectId: projectForRegion(projects, region), error: null, warning: null };
  }

  if (resp.status === 401) {
    const errMsg = asRecord(asRecord(data).error).message;
    const msg = typeof errMsg === 'string' && errMsg ? errMsg : text.slice(0, 200);
    const e = errorFromTable('HDKIT_CRED_INVALID', `HTTP 401: ${msg}`);
    return {
      valid: false,
      projectId: null,
      error: `IAM rejected the credentials (HTTP 401: ${msg}). The AK/SK is invalid - check the SK for typos or expired security tokens.`,
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: e.nextStep,
    };
  }

  if (resp.status === 403) {
    const errMsg = asRecord(asRecord(data).error).message;
    const msg = typeof errMsg === 'string' && errMsg ? errMsg : text.slice(0, 200);
    const e = errorFromTable('HDKIT_CRED_FORBIDDEN', `HTTP 403: ${msg}`);
    return {
      valid: true,
      projectId: null,
      error: null,
      warning: `Credentials signed successfully but project listing was denied (HTTP 403). Continuing without project_id.`,
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: e.nextStep,
    };
  }

  const e = errorFromTable('HDKIT_CRED_UNEXPECTED', `HTTP ${resp.status}`);
  return {
    valid: false,
    projectId: null,
    skipped: true,
    error: `Unexpected IAM response (HTTP ${resp.status}): ${text.slice(0, 200)}`,
    code: e.code,
    messageZh: e.messageZh,
    action: e.action,
    nextStep: e.nextStep,
  };
}
