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
  return { status: resp.status, data: await resp.json() };
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
  return { status: resp.status, data: await resp.json() };
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

// #997: classify a connection-API failure (exported for tests).
export function classifyConnectionError(data: unknown, status: number): ConnectionErrorKind {
  const record = asRecord(data);
  const code = String(record.error_code ?? record.code ?? '').toUpperCase();
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

  // lastFailure is non-null whenever the loop exhausted its attempts without
  // returning or throwing; the assertion keeps the JSON.stringify below honest.
  const failure = lastFailure!;
  const err = new Error(
    `Failed to create connection after ${maxAttempts} attempts (${failure.kind}): ${JSON.stringify(failure.data)}. ${CONNECTION_RETRY_HINT}`,
  );
  (
    err as Error & { code?: string; kind?: ConnectionErrorKind; retryable?: boolean; suggestedRetryAfterMs?: number }
  ).code = String(asRecord(failure.data).error_code ?? asRecord(failure.data).code ?? `HTTP_${failure.status}`);
  (err as Error & { kind?: ConnectionErrorKind }).kind = failure.kind;
  (err as Error & { retryable?: boolean }).retryable = true;
  (err as Error & { suggestedRetryAfterMs?: number }).suggestedRetryAfterMs =
    backoff[Math.min(maxAttempts - 1, backoff.length - 1)] ?? 1000;
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
