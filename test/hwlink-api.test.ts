import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyConnectionError,
  createConnection,
  CONNECTION_RETRY_BACKOFF_MS,
} from '../plugins/huaweicloud-core/src/lib/hdkit/hwlink-api.ts';
import { clearProxyDispatcherCache } from '../plugins/huaweicloud-core/src/proxy/proxy-agent.ts';

// ---- #997 P0-1: createConnection classification + retry ----

test('classifyConnectionError maps the drifting restriction codes to one transient class (#997)', () => {
  assert.equal(classifyConnectionError({ error_code: 'HDKIT_SUB_ACCOUNT_RESTRICTED' }, 200), 'transient_restricted');
  assert.equal(classifyConnectionError({ error_code: 'HD.83700029' }, 200), 'transient_restricted');
  assert.equal(classifyConnectionError({}, 503), 'retryable_server');
  assert.equal(classifyConnectionError({}, 429), 'retryable_server');
  assert.equal(classifyConnectionError({ error_code: 'HD.9700053' }, 200), 'fatal');
  assert.equal(classifyConnectionError({ error_code: 'HDKIT_CRED_INVALID' }, 401), 'fatal');
  assert.deepEqual([...CONNECTION_RETRY_BACKOFF_MS], [1000, 4000, 10000]);
});

// Force the no-dispatcher branch so the module's global fetch call is mockable
// (same doctrine as hdkitservice-api.test.ts's whole-file premise). The handler
// returns Response-shaped stubs ({ status, json }) — the module only reads
// those two, so the cast is the honest boundary.
type StubResponse = { status: number; json: () => Promise<unknown> };
function withMockedFetch(
  handler: (url: unknown, opts: unknown) => StubResponse | Promise<StubResponse>,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  const originalFetch = globalThis.fetch;
  const originalProxy = { ...process.env };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[key];
  process.env.NO_PROXY = '*';
  clearProxyDispatcherCache();
  globalThis.fetch = handler as unknown as typeof globalThis.fetch;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = originalFetch;
    process.env = originalProxy;
    clearProxyDispatcherCache();
  });
}

const restrictedResponse = {
  status: 200,
  json: async () => ({
    error_code: 'HDKIT_SUB_ACCOUNT_RESTRICTED',
    error_msg: '由于沙箱使用限制，当前子账号暂时无法使用沙箱。请切换主账号后重试。',
  }),
};
const connectedResponse = {
  status: 200,
  json: async () => ({ error_code: '0000', result: { connection_id: 721668 } }),
};
const polledConnectionResponse = {
  status: 200,
  json: async () => ({
    result: {
      connection_id: 721668,
      connection_info: { url: 'https://example.devstation/ws', extensions: { source: 'CLI' } },
    },
  }),
};

test('createConnection retries transient restriction errors and succeeds (#997)', async () => {
  let postCalls = 0;
  await withMockedFetch(
    (url, opts) => {
      if (String((opts as { method?: string } | undefined)?.method ?? '') === 'POST') {
        postCalls += 1;
        return Promise.resolve(postCalls <= 2 ? restrictedResponse : connectedResponse);
      }
      return Promise.resolve(polledConnectionResponse);
    },
    async () => {
      const result = await createConnection('env1', 'ak', 'sk', '', { backoffMs: [1, 1, 1] });
      assert.equal(result.wsUrl, 'https://example.devstation/ws?source=CLI');
      assert.equal(result.source, 'CLI');
      assert.equal(postCalls, 3, 'must retry twice before the success');
    },
  );
});

test('createConnection exhausts retries and throws a NON-misleading error (#997)', async () => {
  let postCalls = 0;
  await withMockedFetch(
    (url, opts) => {
      if (String((opts as { method?: string } | undefined)?.method ?? '') === 'POST') {
        postCalls += 1;
        return Promise.resolve(restrictedResponse);
      }
      return Promise.resolve(polledConnectionResponse);
    },
    async () => {
      await assert.rejects(
        createConnection('env1', 'ak', 'sk', '', { maxRetries: 2, backoffMs: [1, 1] }),
        (err: Error & { code?: string; kind?: string; retryable?: boolean; suggestedRetryAfterMs?: number }) => {
          assert.equal(postCalls, 3, '1 initial + 2 retries, no more');
          assert.equal(err.code, 'HDKIT_SUB_ACCOUNT_RESTRICTED');
          assert.equal(err.kind, 'transient_restricted');
          assert.match(err.message, /TRANSIENT server-side state, NOT an account problem/);
          assert.match(err.message, /Do NOT switch to the main account/);
          assert.match(err.message, /retry with backoff/);
          assert.ok(err.retryable, 'error must be marked retryable');
          assert.ok((err.suggestedRetryAfterMs ?? 0) > 0, 'must carry a retryAfter suggestion');
          return true;
        },
      );
    },
  );
});

test('createConnection fails fast on fatal (non-transient) errors (#997)', async () => {
  let postCalls = 0;
  await withMockedFetch(
    (url, opts) => {
      if (String((opts as { method?: string } | undefined)?.method ?? '') === 'POST') {
        postCalls += 1;
        return Promise.resolve({
          status: 200,
          json: async () => ({ error_code: 'HD.9700053', error_msg: 'no such devenv' }),
        });
      }
      return Promise.resolve(polledConnectionResponse);
    },
    async () => {
      await assert.rejects(createConnection('env1', 'ak', 'sk', '', { backoffMs: [1, 1, 1] }), (err: Error) => {
        assert.equal(postCalls, 1, 'fatal errors must not be retried');
        assert.match(err.message, /Failed to create connection/);
        return true;
      });
    },
  );
});
