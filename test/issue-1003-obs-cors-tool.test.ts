import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool, TOOL_DEFINITIONS } from '../plugins/huaweicloud-core/src/tools.ts';
import { getToolSchema } from '../plugins/huaweicloud-core/src/tool-schemas.ts';
import { clearProxyDispatcherCache } from '../plugins/huaweicloud-core/src/proxy/proxy-agent.ts';
import { setRuntimeCredentials, clearRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.ts';

// ---- #1003: huaweicloud_obs_set_cors tool (same-structure obsSignedRequest
// reuse; the subresource parameterization is the port's own seam) ----

test('TOOL_DEFINITIONS exposes huaweicloud_obs_set_cors with set/get/delete + rules schema (#1003)', () => {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === 'huaweicloud_obs_set_cors');
  assert.ok(tool, 'tool must be registered');
  // v2's ToolDefinition carries name+description; the zod schema is the
  // single source of truth for shape (descriptions do not render into the
  // LooseToolSchema JSON) — pin the shape there and the HEAD doctrine on the
  // tool description.
  const schema = JSON.stringify(getToolSchema('huaweicloud_obs_set_cors'));
  assert.match(schema, /options":\["set","get","delete"\]/);
  assert.match(schema, /allowedOrigin/);
  assert.match(tool.description, /allowedMethod 必须含 HEAD/);
  assert.match(tool.description, /BrowserJS SDK/);
});

// Force the no-dispatcher branch (plain global fetch) so it is mockable, and
// inject AK/SK so resolveCredentials finds credentials without file probing.
function withMockedFetch(
  handler: (url: unknown, opts: unknown) => Promise<{ status: number; text: () => Promise<string> }>,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[key];
  process.env.NO_PROXY = '*';
  process.env.HW_ACCESS_KEY = 'test-ak';
  process.env.HW_SECRET_KEY = 'test-sk';
  process.env.HW_SECURITY_TOKEN = '';
  clearProxyDispatcherCache();
  globalThis.fetch = handler as unknown as typeof globalThis.fetch;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    clearProxyDispatcherCache();
  });
}

const fullRules = [
  {
    allowedOrigin: 'https://app.example.com',
    allowedMethod: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
    allowedHeader: ['*'],
    maxAgeSeconds: 3000,
  },
];

test('set builds CORSConfiguration XML and PUTs /?cors with the verify preflight hint (#1003)', async () => {
  const calls: Array<{ url: string; method: unknown; body: unknown }> = [];
  await withMockedFetch(
    async (url, opts) => {
      calls.push({
        url: String(url),
        method: (opts as { method?: string } | undefined)?.method,
        body: (opts as { body?: string } | undefined)?.body,
      });
      return { status: 200, text: async () => '' };
    },
    async () => {
      const res = (await callTool('huaweicloud_obs_set_cors', {
        action: 'set',
        bucket: 'my-bucket',
        region: 'cn-north-4',
        rules: fullRules,
      })) as Record<string, unknown>;
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, 'https://my-bucket.obs.cn-north-4.myhuaweicloud.com/?cors');
      assert.equal(calls[0]!.method, 'PUT');
      assert.match(String(calls[0]!.body), /<CORSConfiguration>/);
      assert.match(String(calls[0]!.body), /<AllowedOrigin>https:\/\/app\.example\.com<\/AllowedOrigin>/);
      // p01: HEAD must be present — the BrowserJS SDK probe depends on it.
      assert.match(String(calls[0]!.body), /<AllowedMethod>HEAD<\/AllowedMethod>/);
      assert.match(String(calls[0]!.body), /<MaxAgeSeconds>3000<\/MaxAgeSeconds>/);
      assert.equal(res.ok, true);
      assert.match(String(res.message), /CORS configured for my-bucket/);
      assert.match(String(res.verify), /OPTIONS/);
      assert.match(String(res.verify), /Access-Control-Request-Method: HEAD/);
      assert.match(String(res.verify), /--noproxy/);
    },
  );
});

test('get and delete address the /?cors subresource (#1003)', async () => {
  const calls: Array<{ method: unknown; url: string }> = [];
  await withMockedFetch(
    async (url, opts) => {
      const method = (opts as { method?: string } | undefined)?.method;
      calls.push({ method, url: String(url) });
      return { status: method === 'DELETE' ? 204 : 200, text: async () => '<CORSConfiguration/>' };
    },
    async () => {
      const got = (await callTool('huaweicloud_obs_set_cors', {
        action: 'get',
        bucket: 'my-bucket',
        region: 'cn-north-4',
      })) as Record<string, unknown>;
      assert.equal(calls[0]!.method, 'GET');
      assert.match(calls[0]!.url, /\?cors$/);
      assert.equal(got.ok, true);
      assert.match(String(got.verify), /OPTIONS/, 'get must carry the preflight hint too');

      const deleted = (await callTool('huaweicloud_obs_set_cors', {
        action: 'delete',
        bucket: 'my-bucket',
        region: 'cn-north-4',
      })) as Record<string, unknown>;
      assert.equal(calls[1]!.method, 'DELETE');
      assert.match(calls[1]!.url, /\?cors$/);
      assert.equal(deleted.ok, true);
      assert.equal(deleted.status, 204);
    },
  );
});

test('set rejects a rule without HEAD at the input boundary, before any request (#1003/p01)', async () => {
  let fetchCalled = 0;
  await withMockedFetch(
    async () => {
      fetchCalled += 1;
      return { status: 200, text: async () => '' };
    },
    async () => {
      await assert.rejects(
        callTool('huaweicloud_obs_set_cors', {
          action: 'set',
          bucket: 'my-bucket',
          region: 'cn-north-4',
          rules: [{ allowedOrigin: 'https://app.example.com', allowedMethod: ['GET', 'PUT'] }],
        }),
        (err: Error) => {
          assert.match(err.message, /must include 'HEAD'/);
          assert.match(err.message, /p01/);
          return true;
        },
      );
      assert.equal(fetchCalled, 0, 'input-boundary rejection must not reach the network');
    },
  );
});

test('set without credentials points at huaweicloud_auth_init (website-config parity, #1003)', async () => {
  await withMockedFetch(
    async () => ({ status: 200, text: async () => '' }),
    async () => {
      // runtimeCredentials wins over env/file stores — empty runtime creds
      // make the no-credential path hermetic.
      setRuntimeCredentials('', '', '', '');
      try {
        await assert.rejects(
          callTool('huaweicloud_obs_set_cors', {
            action: 'set',
            bucket: 'my-bucket',
            region: 'cn-north-4',
            rules: fullRules,
          }),
          /huaweicloud_auth_init/,
        );
      } finally {
        clearRuntimeCredentials();
      }
    },
  );
});
