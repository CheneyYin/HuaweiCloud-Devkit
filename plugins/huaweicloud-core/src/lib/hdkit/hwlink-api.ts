import { resolveCredentialsWithRuntime } from '../../auth/credentials.ts';
import { fetchWithProxy } from '../../proxy/proxy-agent.ts';
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function createConnection(
  envId: string,
  ak: string,
  sk: string,
  securitytoken: string,
): Promise<{ wsUrl: string; source: unknown }> {
  const { status, data } = await apiPost(
    `/open-api-public/v1/devenvs/${envId}/connections`,
    { source: 'CLI' },
    ak,
    sk,
    securitytoken,
  );

  const payload = asRecord(data);
  const result = asRecord(payload.result);
  if (status !== 200 || payload.error_code !== '0000' || !result.connection_id) {
    throw new Error(`Failed to create connection: ${JSON.stringify(data)}`);
  }

  const connectionId = asText(result.connection_id);
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
