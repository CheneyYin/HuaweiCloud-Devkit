import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { AGENTS } from '../plugins/huaweicloud-core/src/telemetry/agent-registry.ts';
import { detectAgentHarness } from '../plugins/huaweicloud-core/src/telemetry/agent-detect.ts';

const DETECTION_ENV_KEYS = ['AGENT_HARNESS', ...new Set(AGENTS.flatMap((agent) => agent.envVars || []))];

function withNoAgentEnv(fn: () => void) {
  const prev = Object.fromEntries(DETECTION_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of DETECTION_ENV_KEYS) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type TelemetryModule = typeof import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');

// 隔离 telemetry.mjs 的模块级目录常量（GLOBAL_TELEMETRY_DIR 在 import 时固定）：
// 临时 HUAWEICLOUD_DEVKIT_HOME + 带 query 的 import 强制新模块实例，用完恢复并清理。
async function withIsolatedTelemetry(fn: (telemetry: TelemetryModule) => unknown) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-telemetry-'));
  const prevHome = process.env.HUAWEICLOUD_DEVKIT_HOME;
  process.env.HUAWEICLOUD_DEVKIT_HOME = tmp;
  try {
    const telemetry = await import(`../plugins/huaweicloud-core/src/telemetry/telemetry.ts?iso=${Date.now()}`);
    return await fn(telemetry);
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_DEVKIT_HOME;
    else process.env.HUAWEICLOUD_DEVKIT_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- flush-behavior test infrastructure ----
//
// The flush path rides fetchWithProxy, which dispatches to global.fetch
// when no proxy is configured (the hdkitservice-api.test.ts stubbing
// precedent). "No proxy" must be established from every source the
// resolver reads: the proxy env spellings AND a developer's proxy.json
// (whose path derives from HUAWEICLOUD_HOME), so the file-scope hermetic
// home below redirects that config too.
//
// The hermetic home ALSO pins the CANONICAL face instance's module-scope
// paths (the query-less import the pack handlers and the stdio transport
// resolve): its GLOBAL_TELEMETRY_DIR is derived at first load, so the env
// must be in place before any test triggers that load — hence file scope,
// not per-test. withIsolatedTelemetry overrides it per-test and restores
// back to this value.
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;
const savedProxyEnv: Record<string, string | undefined> = {};
for (const key of PROXY_ENV_KEYS) {
  savedProxyEnv[key] = process.env[key];
  delete process.env[key];
}
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const FILE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-telemetry-file-'));
const prevDevkitHome = process.env.HUAWEICLOUD_DEVKIT_HOME;
const prevHwHome = process.env.HUAWEICLOUD_HOME;
process.env.HUAWEICLOUD_DEVKIT_HOME = FILE_HOME;
process.env.HUAWEICLOUD_HOME = FILE_HOME;

after(() => {
  for (const key of PROXY_ENV_KEYS) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
  if (prevDevkitHome === undefined) delete process.env.HUAWEICLOUD_DEVKIT_HOME;
  else process.env.HUAWEICLOUD_DEVKIT_HOME = prevDevkitHome;
  if (prevHwHome === undefined) delete process.env.HUAWEICLOUD_HOME;
  else process.env.HUAWEICLOUD_HOME = prevHwHome;
  fs.rmSync(FILE_HOME, { recursive: true, force: true });
});

const TELEMETRY_URL = 'https://telemetry-stub.test/events';

interface CapturedCall {
  url: string;
  body?: string;
}

// Stub global.fetch; the returned restore puts the original back. The
// handler receives the flat (url, init) the pipeline passes on.
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): () => void {
  const original = global.fetch;
  global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(input.toString(), init ?? {})) as typeof fetch;
  return () => {
    global.fetch = original;
  };
}

function okTelemetryResponse(): Response {
  return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// The telemetry POSTs out of a captured call log, bodies parsed.
function telemetryPostBodies(calls: CapturedCall[]): Record<string, unknown>[][] {
  return calls
    .filter((call) => call.url === TELEMETRY_URL)
    .map((call) => JSON.parse(call.body ?? '[]') as Record<string, unknown>[]);
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('detectAgentHarness returns known when no env set', () => {
  const result = detectAgentHarness();
  assert.ok(result === null || (typeof result === 'string' && result.length > 0));
});

test('detectAgentHarness respects AGENT_HARNESS env', () => {
  const prev = process.env.AGENT_HARNESS;
  process.env.AGENT_HARNESS = 'opencode';
  try {
    assert.equal(detectAgentHarness(), 'opencode');
  } finally {
    if (prev) process.env.AGENT_HARNESS = prev;
    else delete process.env.AGENT_HARNESS;
  }
});

test('detectAgentHarness detects opencode from env', () => {
  const prev = process.env.OPENCODE_SESSION_ID;
  process.env.OPENCODE_SESSION_ID = 'test-session';
  try {
    assert.equal(detectAgentHarness(), 'opencode');
  } finally {
    if (prev) process.env.OPENCODE_SESSION_ID = prev;
    else delete process.env.OPENCODE_SESSION_ID;
  }
});

test('detectAgentHarness returns null when nothing matches', () => {
  withNoAgentEnv(() => {
    assert.equal(detectAgentHarness(), null);
  });
});

test('detectAgentHarness classifies MCP client names to canonical harness', () => {
  const nameBackedAgents = AGENTS.filter((a) => a.clientNames?.length);
  const idNameAgents = AGENTS.filter((a) => a.envVars?.length);
  const cases = [
    ...nameBackedAgents.flatMap((a) => (a.clientNames ?? []).map((n) => [n, a.id])),
    ...idNameAgents.map((a) => [a.id, a.id]),
  ];
  withNoAgentEnv(() => {
    for (const [name, expected] of cases) {
      assert.equal(detectAgentHarness({ name }), expected, `name=${name}`);
    }
  });
});

test('detectAgentHarness prefers real host env over clientInfo.name', () => {
  const hostBackedAgents = AGENTS.filter((a) => a.envVars?.length);
  withNoAgentEnv(() => {
    for (const agent of hostBackedAgents) {
      process.env[agent.envVars![0]] = 'simulated';
      assert.equal(
        detectAgentHarness({ name: 'unknown-mcp-client-probe' }),
        agent.id,
        `env ${agent.envVars![0]} should win over name for ${agent.id}`,
      );
      delete process.env[agent.envVars![0]];
    }
  });
});

// The registry's path patterns are matched against the spawned server's own
// module path. opencode resolves its config root from XDG_CONFIG_HOME (and
// the installer follows, xdgConfigHome), so the opencode marker must survive
// a non-default root — the plugin dir segment, not the ~/.config prefix.
test('opencode path pattern matches payload paths under any XDG root', () => {
  const opencode = AGENTS.find((a) => a.id === 'opencode');
  assert.ok(opencode?.pathPatterns?.length, 'opencode must carry path patterns');
  const marker = opencode.pathPatterns![0]!;
  const payloadPaths = [
    '/home/u/.config/opencode/huaweicloud-plugins/dist/mcp-server.js',
    '/home/u/xdg/opencode/huaweicloud-plugins/dist/mcp-server.js',
    '/home/u/.config/opencode/huaweicloud-plugins/src/mcp-server.mjs',
  ];
  for (const serverPath of payloadPaths) {
    assert.ok(serverPath.includes(marker), `marker ${marker} must match ${serverPath}`);
  }
  // matchAgent is substring + first-match over AGENTS order, so the real
  // no-collision property is non-containment: a future broad pattern (e.g.
  // /huaweicloud-plugins/) on any agent would shadow or be shadowed by the
  // opencode marker while passing an exact-equality check.
  for (const agent of AGENTS.filter((a) => a.id !== 'opencode')) {
    for (const pattern of agent.pathPatterns ?? []) {
      assert.ok(
        !pattern.includes(marker) && !marker.includes(pattern),
        `agent ${agent.id} pattern ${pattern} must neither contain nor be contained by the opencode marker ${marker}`,
      );
    }
  }
  // And no agent listed BEFORE opencode may match an opencode payload path
  // (first-match order would attribute the spawn to that agent instead).
  const opencodeIdx = AGENTS.findIndex((a) => a.id === 'opencode');
  for (const agent of AGENTS.slice(0, opencodeIdx)) {
    for (const pattern of agent.pathPatterns ?? []) {
      for (const serverPath of payloadPaths) {
        assert.ok(
          !serverPath.includes(pattern),
          `earlier agent ${agent.id} pattern ${pattern} must not match an opencode payload path`,
        );
      }
    }
  }
});

test('generateOrRecoverInstallId returns consistent string', async () => {
  await withIsolatedTelemetry(async ({ generateOrRecoverInstallId }) => {
    const id1 = generateOrRecoverInstallId();
    const id2 = generateOrRecoverInstallId();
    assert.equal(typeof id1, 'string');
    assert.equal(id1, id2);
  });
});

test('isTelemetryEnabled defaults to true', async () => {
  const { isTelemetryEnabled } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
  assert.equal(isTelemetryEnabled(), true);
});

test('isTelemetryEnabled returns false when env set to off', async () => {
  const prev = process.env.HUAWEICLOUD_DEVKIT_TELEMETRY;
  process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
  try {
    const { isTelemetryEnabled } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
    assert.equal(isTelemetryEnabled(), false);
  } finally {
    if (prev) process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = prev;
    else delete process.env.HUAWEICLOUD_DEVKIT_TELEMETRY;
  }
});

test('initTelemetry and trackToolInvoke do not throw', async () => {
  await withIsolatedTelemetry(async ({ initTelemetry, trackToolInvoke, trackSkillRetrieve }) => {
    initTelemetry({ harness: 'test', version: '1.0.0' });
    assert.doesNotThrow(() => trackToolInvoke('test_tool_name'));
    assert.doesNotThrow(() => trackSkillRetrieve('test_skill_name'));
  });
});

test('trackSandboxConnect and trackSandboxDisconnect do not throw', async () => {
  await withIsolatedTelemetry(async ({ initTelemetry, trackSandboxConnect, trackSandboxDisconnect }) => {
    initTelemetry({ harness: 'test', version: '1.0.0' });
    assert.doesNotThrow(() => trackSandboxConnect());
    assert.doesNotThrow(() => trackSandboxDisconnect());
  });
});

test('sanitizeValue truncates long values to 255', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
  const out = sanitizeValue('x'.repeat(500));
  assert.equal(out.length, 255);
  assert.ok(out.endsWith('...'));
});

test('sanitizeValue replaces newlines and tabs with spaces', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
  assert.equal(sanitizeValue('a\nb\tc'), 'a b c');
});

test('sanitizeValue keeps short values intact', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
  assert.equal(sanitizeValue('hcloud version'), 'hcloud version');
});

test('sanitizeValue coerces non-strings and nulls safely', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
  assert.equal(sanitizeValue(null), '');
  assert.equal(sanitizeValue(undefined), '');
  assert.equal(sanitizeValue(123), '123');
});

test('cacheUserHash writes to filesystem', async () => {
  await withIsolatedTelemetry(async ({ cacheUserHash }) => {
    assert.doesNotThrow(() => cacheUserHash('sha256hash1234'));
  });
});

test('ingestHookEvents handles empty or missing file', async () => {
  await withIsolatedTelemetry(async ({ initTelemetry, ingestHookEvents }) => {
    initTelemetry({ harness: 'test', version: '1.0.0' });
    assert.doesNotThrow(() => ingestHookEvents());
  });
});

// ---- awaitable flush (E4a) ----
//
// initTelemetry enqueues boot events (plugin:install / first_use / the DAU
// ping, depending on stamp state) and schedules its own setImmediate
// flush; every test below first awaits one flush so the boot round and
// that chain have settled, leaving a deterministic empty queue.

test('flushTelemetryEvents resolves without a POST when the queue is empty', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const calls: CapturedCall[] = [];
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        await telemetry.flushTelemetryEvents();
        const postsBefore = telemetryPostBodies(calls).length;
        await telemetry.flushTelemetryEvents();
        assert.equal(telemetryPostBodies(calls).length, postsBefore);
      });
    } finally {
      restore();
    }
  });
});

test('flushTelemetryEvents sends queued events with their literal keys', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const calls: CapturedCall[] = [];
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        await telemetry.flushTelemetryEvents();
        telemetry.trackToolInvoke('flush_send_probe');
        telemetry.trackSkillRetrieve('flush-skill-probe');
        await telemetry.flushTelemetryEvents();
        const posts = telemetryPostBodies(calls);
        const last = posts[posts.length - 1]!;
        assert.deepEqual(
          last.map((event) => event.key),
          ['tool:flush_send_probe', 'skill:retrieve'],
        );
        // events carry the session identity they were built with
        assert.equal(last[0]!.harness, 'test');
        assert.equal(typeof last[0]!.installId, 'string');
        assert.ok((last[0]!.installId as string).length > 0);
      });
    } finally {
      restore();
    }
  });
});

test('a flush arriving mid-round chains onto it and flushes late-enqueued events', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const calls: CapturedCall[] = [];
    // The gate holds exactly the NEXT telemetry POST until released, so
    // round 1 stays in flight while the test enqueues behind its splice.
    let holdNext = false;
    let release: () => void = () => {};
    let gate: Promise<void> = Promise.resolve();
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      if (holdNext && url === TELEMETRY_URL) {
        holdNext = false;
        await gate;
      }
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        await telemetry.flushTelemetryEvents();

        telemetry.trackToolInvoke('inflight_first');
        holdNext = true;
        gate = new Promise<void>((resolveGate) => {
          release = resolveGate;
        });
        // Round 1 splices inflight_first synchronously, then suspends on
        // the gated fetch.
        const p1 = telemetry.flushTelemetryEvents();
        telemetry.trackToolInvoke('inflight_second');
        // Arrives mid-round: chains onto round 1 plus one follow-up round.
        const p2 = telemetry.flushTelemetryEvents();
        release();
        await p1;
        await p2;

        const posts = telemetryPostBodies(calls);
        const tail = posts.slice(-2);
        assert.deepEqual(
          tail[0]!.map((event) => event.key),
          ['tool:inflight_first'],
        );
        assert.deepEqual(
          tail[1]!.map((event) => event.key),
          ['tool:inflight_second'],
        );
      });
    } finally {
      restore();
    }
  });
});

test('flushTelemetryEvents resolves on server failure and requeues for the next flush', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const calls: CapturedCall[] = [];
    let failTelemetry = true;
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      if (url === TELEMETRY_URL && failTelemetry) {
        return new Response(JSON.stringify({}), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        telemetry.trackToolInvoke('retry_probe');
        // 503 -> requeue; the promise resolves, never rejects (the P0
        // await contract).
        await assert.doesNotReject(telemetry.flushTelemetryEvents());
        const failedRounds = telemetryPostBodies(calls).length;
        failTelemetry = false;
        await telemetry.flushTelemetryEvents();
        const posts = telemetryPostBodies(calls);
        assert.ok(posts.length > failedRounds, 'the requeued events must be re-sent by a later flush');
        const keys = posts
          .slice(failedRounds)
          .flat()
          .map((event) => event.key);
        assert.ok(keys.includes('tool:retry_probe'));
      });
    } finally {
      restore();
    }
  });
});
