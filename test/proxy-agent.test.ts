import { test, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getProxyDispatcher, clearProxyDispatcherCache, PROXY_TLS_OPTIONS } =
  await import('../plugins/huaweicloud-core/src/proxy/proxy-agent.ts');
const { shouldBypassProxy } = await import('../plugins/huaweicloud-core/src/proxy/proxy-config.ts');

// The resolver reads BOTH spellings of each variable (proxy-config.ts:
// process.env.HTTPS_PROXY || process.env.https_proxy), so a test premise
// must clear both — an ambient lowercase spelling (the curl convention;
// https_proxy is the one that routes these https:// test targets) leaks
// through an uppercase-only cleanup and turns the no-proxy test red on
// proxied developer machines.
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'] as const;

function pushProxyEnv() {
  const saved: Record<string, string | undefined> = {};
  for (const key of PROXY_ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function setProxyEnv(https = '', http = '', noProxy = '') {
  const targets: Array<[string, string]> = [
    ['HTTPS_PROXY', https],
    ['HTTP_PROXY', http],
    ['NO_PROXY', noProxy],
  ];
  for (const [key, value] of targets) {
    const lower = key.toLowerCase();
    if (value) {
      process.env[key] = value;
      process.env[lower] = value;
    } else {
      delete process.env[key];
      delete process.env[lower];
    }
  }
}

// The three spelling tests share one teardown shape: env restore, home
// restore, dispatcher-cache clear, temp home removal.
function teardownProxyTest(
  saved: Record<string, string | undefined>,
  savedHome: string | undefined,
  tmpHome: string,
): void {
  restoreProxyEnv(saved);
  if (savedHome === undefined) delete process.env.HUAWEICLOUD_HOME;
  else process.env.HUAWEICLOUD_HOME = savedHome;
  clearProxyDispatcherCache();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

function restoreProxyEnv(saved: Record<string, string | undefined>) {
  for (const key of PROXY_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

test('PROXY_TLS_OPTIONS relaxes both proxy and tunneled target TLS legs', () => {
  assert.deepEqual(PROXY_TLS_OPTIONS, {
    proxyTls: { rejectUnauthorized: false },
    requestTls: { rejectUnauthorized: false },
  });
});

test('getProxyDispatcher returns undefined when no proxy is configured', async () => {
  const saved = pushProxyEnv();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-agent-test-'));
  const savedHome = process.env.HUAWEICLOUD_HOME;
  try {
    setProxyEnv();
    process.env.HUAWEICLOUD_HOME = tmpHome;
    clearProxyDispatcherCache();

    const dispatcher = await getProxyDispatcher('https://devkit.huaweicloud.com/rest/');
    assert.equal(dispatcher, undefined);
  } finally {
    teardownProxyTest(saved, savedHome, tmpHome);
  }
});

interface CapturedProxyOptions {
  uri: string;
  proxyTls?: { rejectUnauthorized?: boolean };
  requestTls?: { rejectUnauthorized?: boolean };
}

test(
  'getProxyDispatcher constructs ProxyAgent with relaxed TLS options',
  { skip: typeof mock?.module !== 'function' },
  async (t) => {
    const saved = pushProxyEnv();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-agent-test-'));
    const savedHome = process.env.HUAWEICLOUD_HOME;
    let captured = null as CapturedProxyOptions | null;

    t.mock.module('undici', {
      namedExports: {
        ProxyAgent: class {
          constructor(options: CapturedProxyOptions) {
            captured = options;
          }
          dispatch() {}
        },
      },
    });

    try {
      setProxyEnv('http://proxy.internal:8080');
      process.env.HUAWEICLOUD_HOME = tmpHome;
      clearProxyDispatcherCache();

      await getProxyDispatcher('https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/');

      assert.ok(captured, 'expected ProxyAgent to be constructed');
      assert.equal(captured.uri, 'http://proxy.internal:8080');
      assert.deepEqual(captured.proxyTls, { rejectUnauthorized: false });
      assert.deepEqual(captured.requestTls, { rejectUnauthorized: false });
    } finally {
      teardownProxyTest(saved, savedHome, tmpHome);
    }
  },
);

test(
  'getProxyDispatcher reads the lowercase https_proxy spelling alone',
  { skip: typeof mock?.module !== 'function' },
  async (t) => {
    const saved = pushProxyEnv();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-agent-test-'));
    const savedHome = process.env.HUAWEICLOUD_HOME;
    let captured = null as CapturedProxyOptions | null;

    t.mock.module('undici', {
      namedExports: {
        ProxyAgent: class {
          constructor(options: CapturedProxyOptions) {
            captured = options;
          }
          dispatch() {}
        },
      },
    });

    try {
      // Only the lowercase spelling, the curl convention: the uppercase
      // keys stay absent, so the fallback chain (HTTPS_PROXY ||
      // https_proxy) must resolve through the lowercase read.
      for (const key of PROXY_ENV_KEYS) delete process.env[key];
      process.env.https_proxy = 'http://lower.proxy:8080';
      process.env.HUAWEICLOUD_HOME = tmpHome;
      clearProxyDispatcherCache();

      await getProxyDispatcher('https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/');

      assert.ok(captured, 'expected ProxyAgent to be constructed from the lowercase spelling');
      assert.equal(captured.uri, 'http://lower.proxy:8080');
    } finally {
      teardownProxyTest(saved, savedHome, tmpHome);
    }
  },
);

test(
  'getProxyDispatcher reads the uppercase HTTPS_PROXY spelling alone',
  { skip: typeof mock?.module !== 'function' },
  async (t) => {
    const saved = pushProxyEnv();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-agent-test-'));
    const savedHome = process.env.HUAWEICLOUD_HOME;
    let captured = null as CapturedProxyOptions | null;

    t.mock.module('undici', {
      namedExports: {
        ProxyAgent: class {
          constructor(options: CapturedProxyOptions) {
            captured = options;
          }
          dispatch() {}
        },
      },
    });

    try {
      // Only the uppercase spelling, the CI/docker convention: the
      // lowercase keys stay absent, so the primary read in the chain
      // (HTTPS_PROXY || https_proxy) must resolve. A refactor that drops
      // either half of the chain keeps the other tests green (both
      // spellings set to the same value) — this pair of single-spelling
      // pins is what fails it.
      for (const key of PROXY_ENV_KEYS) delete process.env[key];
      process.env.HTTPS_PROXY = 'http://upper.proxy:8080';
      process.env.HUAWEICLOUD_HOME = tmpHome;
      clearProxyDispatcherCache();

      await getProxyDispatcher('https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/');

      assert.ok(captured, 'expected ProxyAgent to be constructed from the uppercase spelling');
      assert.equal(captured.uri, 'http://upper.proxy:8080');
    } finally {
      teardownProxyTest(saved, savedHome, tmpHome);
    }
  },
);

// ── no_proxy CIDR matching (main 1.1.9 port) ────────────────────────────────

test('no_proxy CIDR patterns match literal IPv4/IPv6 hosts (incl. mapped forms)', async () => {
  const { getProxyDispatcher } = await import('../plugins/huaweicloud-core/src/proxy/proxy-agent.ts');
  const cases: Array<[string, string, boolean]> = [
    // IPv4 host vs IPv4 CIDR — inside and outside.
    ['10.0.0.5', '10.0.0.0/8', true],
    ['10.1.2.3', '10.0.0.0/8', true],
    ['11.0.0.1', '10.0.0.0/8', false],
    ['192.168.1.20', '192.168.1.0/24', true],
    ['192.168.2.20', '192.168.1.0/24', false],
    // /0 matches everything; /32 exactly one.
    ['8.8.8.8', '0.0.0.0/0', true],
    ['8.8.8.8', '8.8.8.8/32', true],
    ['8.8.8.9', '8.8.8.8/32', false],
    // IPv4-mapped IPv6 host vs IPv4 CIDR.
    ['::ffff:10.0.0.5', '10.0.0.0/8', true],
    ['::ffff:11.0.0.1', '10.0.0.0/8', false],
    // IPv4-mapped CIDR base vs IPv4 host (the mapped base parses as a 32-bit rule).
    ['10.0.0.5', '::ffff:10.0.0.0/8', true],
    ['11.0.0.5', '::ffff:10.0.0.0/8', false],
    // IPv6 host vs IPv6 CIDR.
    ['2001:db8::1', '2001:db8::/32', true],
    ['2001:db9::1', '2001:db8::/32', false],
    ['fe80::1', 'fe80::/10', true],
    ['::1', '::1/128', true],
    ['::2', '::1/128', false],
    // Hostnames never match CIDRs.
    ['example.com', '10.0.0.0/8', false],
    // Malformed patterns never crash and never match.
    ['10.0.0.5', '10.0.0.0/33', false],
    ['10.0.0.5', '10.0.0.0/abc', false],
    ['2001:db8::1', '2001:db8::/129', false],
  ];
  for (const [host, pattern, expectBypass] of cases) {
    const bypass = shouldBypassProxy(host, [pattern]);
    assert.equal(bypass, expectBypass, `host=${host} pattern=${pattern} expected bypass=${expectBypass}`);
    // End-to-end agreement: a bypassed target yields no dispatcher. Bracketed
    // IPv6 URLs exercise the URL-hostname normalization (brackets stripped,
    // hex-mapped forms translated).
    if (expectBypass) {
      process.env.HTTPS_PROXY = 'http://proxy.invalid:8080';
      process.env.HTTP_PROXY = 'http://proxy.invalid:8080';
      process.env.NO_PROXY = pattern;
      try {
        const target = host.includes(':') ? `http://[${host}]:443/` : `http://${host}:443/`;
        const dispatcher = await getProxyDispatcher(target);
        assert.equal(dispatcher, undefined, `host=${host} pattern=${pattern} must bypass the proxy`);
      } finally {
        delete process.env.HTTPS_PROXY;
        delete process.env.HTTP_PROXY;
        delete process.env.NO_PROXY;
      }
    }
  }
});
