import { resolveCredentialsWithRuntime } from '../../auth/credentials.ts';
import { fetchWithProxy } from '../../proxy/proxy-agent.ts';
import { asRecord } from '../as-record.ts';
import { signSdkHmacRequest } from '../hw-request-signing.ts';
import { asText } from '../as-text.ts';

const BASE_URL = process.env.HWLINK_ENDPOINT || 'https://devstation.myhuaweicloud.com';

function sortedQs(query: Record<string, unknown>): string {
  return Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

export function getCredentials(): { ak: string; sk: string; securitytoken: string } {
  const credentials = resolveCredentialsWithRuntime();
  // resolveCredentialsWithRuntime is called without allowMissing, so it throws
  // rather than returning null; this guard only narrows the inferred type.
  if (!credentials) {
    throw new Error('Huawei Cloud credentials are not configured.');
  }
  return { ak: credentials.ak, sk: credentials.sk, securitytoken: credentials.securityToken };
}

async function apiGet(
  path: string,
  query: Record<string, unknown> | undefined,
  ak: string,
  sk: string,
  securitytoken: string,
): Promise<{ status: number; data: unknown }> {
  query = query || {};
  const qs = sortedQs(query);
  const fullPath = qs ? `${path}?${qs}` : path;
  const headers = signSdkHmacRequest({ path, query, ak, sk, securityToken: securitytoken, baseUrl: BASE_URL });
  const resp = await fetchWithProxy(`${BASE_URL}${fullPath}`, { headers });
  return { status: resp.status, data: await readResponseBody(resp) };
}

// #997 hardening: a 5xx from a gateway typically returns HTML — resp.json()
// would throw a SyntaxError BEFORE classifyConnectionError ever sees the
// status, so the retryable_server class only fired for JSON bodies (the least
// likely shape for a gateway error). Text-then-parse (the sibling
// hdkitservice-api doctrine): a non-JSON body becomes a status-keyed synthetic
// payload so 429/5xx still classify and retry. Transport-level fetch
// rejections (ECONNRESET etc.) still propagate unclassified — a documented
// residual, deliberately not retried.
async function readResponseBody(resp: { status: number; text: () => Promise<string> }): Promise<unknown> {
  const raw = await resp.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { error_code: `HTTP_${resp.status}`, error_msg: raw.slice(0, 200) };
  }
}

async function apiPost(
  path: string,
  body: unknown,
  ak: string,
  sk: string,
  securitytoken: string,
): Promise<{ status: number; data: unknown }> {
  const headers = signSdkHmacRequest({
    method: 'POST',
    path,
    query: {},
    body,
    ak,
    sk,
    securityToken: securitytoken,
    baseUrl: BASE_URL,
  });
  const resp = await fetchWithProxy(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await readResponseBody(resp) };
}

// #997: transient/restriction-class error codes from the connection API.
// HDKIT_SUB_ACCOUNT_RESTRICTED and HD.83700029 are the SAME server-side
// transient condition under two different codes (measured 2026-10-21/22: the
// same AK/SK and the same request body got HD.83700029 on the 21st and
// HDKIT_SUB_ACCOUNT_RESTRICTED on the 22nd — the code drifts between calls).
// The message accuses the account of being a restricted sub-account, but a
// fully compliant account (realnameVerified:true, agreementSigned:true, no
// sub-users) got the SAME error and the identical request succeeded 25 minutes
// later — the only action that helped was waiting. Retry these instead of
// failing, and NEVER surface the server's "switch to the main account" advice
// as actionable: acting on it is an irreversible, account-wide operation
// triggered by a transient state.
const TRANSIENT_CONNECTION_CODES = new Set(['HDKIT_SUB_ACCOUNT_RESTRICTED', 'HD.83700029']);

export type ConnectionErrorKind = 'transient_restricted' | 'retryable_server' | 'fatal';

// #997: classify a connection-API failure (exported for tests). NB: the code
// extraction is nullish (??), not falsy (||) — a falsy-but-present error_code
// wins over a meaningful code, a deliberate divergence from main's || chain
// (kept because v2 reads the same field pair in classify and err.code, which
// main did not).
export function classifyConnectionError(data: unknown, status: number): ConnectionErrorKind {
  const record = asRecord(data);
  const code = asText(record.error_code ?? record.code ?? '').toUpperCase();
  if (TRANSIENT_CONNECTION_CODES.has(code)) return 'transient_restricted';
  if (status === 429 || (status >= 500 && status < 600)) return 'retryable_server';
  return 'fatal';
}

// #997: default backoff between connection retries, in ms. The measured incident
// self-resolved in ~25 minutes, so three spaced retries cover the short end
// without blocking exec callers for long.
export const CONNECTION_RETRY_BACKOFF_MS: ReadonlyArray<number> = [1000, 4000, 10000];

const CONNECTION_RETRY_HINT =
  'This is a TRANSIENT server-side state, NOT an account problem: the same request typically succeeds after a short wait ' +
  '(measured 2026-10-22: HDKIT_SUB_ACCOUNT_RESTRICTED self-resolved in 25 minutes for a fully compliant account — realname verified, agreement signed, no sub-users). ' +
  'Do NOT switch to the main account, do NOT modify IAM users or credentials based on this error — retry with backoff instead.';

export interface CreateConnectionOptions {
  maxRetries?: number;
  backoffMs?: ReadonlyArray<number>;
}

// #997: the retry-exhausted error's enriched shape — named (the sibling
// hdkitservice-api HdkitError idiom) so callers and tests import it instead
// of re-declaring structural casts. The fields are a forward-facing seam:
// today only err.message crosses the MCP tool boundary; code/kind/retryable/
// suggestedRetryAfterMs exist for callers that want to skip futile outer
// retries while the transient state settles.
export interface ConnectionRetryError extends Error {
  code?: string;
  kind?: ConnectionErrorKind;
  retryable?: boolean;
  suggestedRetryAfterMs?: number;
}

export interface ConnectionResult {
  wsUrl: string;
  source: unknown;
}

export async function createConnection(
  envId: string,
  ak: string,
  sk: string,
  securitytoken: string,
  { maxRetries = 3, backoffMs }: CreateConnectionOptions = {},
): Promise<ConnectionResult> {
  const backoff = backoffMs ?? CONNECTION_RETRY_BACKOFF_MS;
  const maxAttempts = maxRetries + 1;
  let lastFailure: { kind: ConnectionErrorKind; status: number; data: unknown } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && lastFailure) {
      const wait = backoff[Math.min(attempt - 2, backoff.length - 1)] ?? 1000;
      process.stderr.write(
        `createConnection: retryable error (${lastFailure.kind}) — retry ${attempt - 1}/${maxRetries} in ${wait}ms\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const { status, data } = await apiPost(
      `/open-api-public/v1/devenvs/${envId}/connections`,
      { source: 'CLI' },
      ak,
      sk,
      securitytoken,
    );

    const payload = asRecord(data);
    const result = asRecord(payload.result);
    if (status === 200 && payload.error_code === '0000' && result.connection_id) {
      return await waitForConnection(asText(result.connection_id), envId, ak, sk, securitytoken);
    }

    const kind = classifyConnectionError(data, status);
    if (kind === 'fatal') {
      throw new Error(`Failed to create connection: ${JSON.stringify(data)}`);
    }
    lastFailure = { kind, status, data };
  }

  // lastFailure is non-null whenever the loop ran at least once without
  // returning or throwing; the guard below turns a degenerate maxRetries
  // (< 0 ⇒ zero attempts) into an honest options error instead of a null
  // TypeError masquerading as a server failure.
  if (!lastFailure) {
    throw new Error('createConnection: no attempts executed (maxRetries must be >= 0)');
  }
  const failure = lastFailure;
  const err = new Error(
    `Failed to create connection after ${maxAttempts} attempts (${failure.kind}): ${JSON.stringify(failure.data)}. ${CONNECTION_RETRY_HINT}`,
  ) as ConnectionRetryError;
  err.code = asText(asRecord(failure.data).error_code ?? asRecord(failure.data).code ?? `HTTP_${failure.status}`);
  err.kind = failure.kind;
  err.retryable = true;
  // Deliberate divergence from main: main always suggests the largest backoff
  // entry; v2 suggests the wait the NEXT attempt would actually use — the next
  // attempt is maxAttempts + 1, whose wait index is maxAttempts - 1.
  err.suggestedRetryAfterMs = backoff[Math.min(maxAttempts - 1, backoff.length - 1)] ?? 1000;
  throw err;
}

// Poll the connection until the ws URL + source are live (the create call
// returns a connection_id before the endpoint is reachable). 60 one-second
// attempts, same shape as before the retry extraction.
async function waitForConnection(
  connectionId: string,
  envId: string,
  ak: string,
  sk: string,
  securitytoken: string,
): Promise<ConnectionResult> {
  const maxAttempts = 60;

  for (let i = 0; i < maxAttempts; i++) {
    process.stderr.write(`\rWaiting for connection ${connectionId}... (${i}s)`);
    const { data: getData } = await apiGet(
      `/open-api-public/v1/devenvs/${envId}/connections/${connectionId}`,
      {},
      ak,
      sk,
      securitytoken,
    );

    const getPayload = asRecord(getData);
    const getResult = asRecord(getPayload.result);
    const connectionInfo = asRecord(getResult.connection_info);
    const extensions = asRecord(connectionInfo.extensions);
    if (typeof connectionInfo.url === 'string' && connectionInfo.url && extensions.source != null) {
      const u = new URL(connectionInfo.url);
      u.searchParams.set('source', asText(extensions.source));
      process.stderr.write(`\rConnection ${connectionId} established (${i}s).\n`);
      return {
        wsUrl: u.toString(),
        source: extensions.source,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for connection ${connectionId}`);
}
