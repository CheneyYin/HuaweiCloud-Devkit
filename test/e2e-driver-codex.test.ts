import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

import { getCodexPluginName, getMarketplaceName } from '../plugins/huaweicloud-core/src/codex-probe.ts';
import { shapeForGateway, startGatewayProxy } from './e2e/drivers/gateway-proxy.ts';
import { codexDriver } from './e2e/drivers/codex.ts';
import type { DriverContext } from './e2e/drivers/types.ts';
import { fixtureDir } from './fixture-dir.ts';

// The codex driver's config surgery and gateway shaping, pinned without the
// LLM: the TOML merge must keep top-level keys ahead of every table header,
// the auth bridge must cover the E2E_TEST_API_KEY spelling, and the proxy
// must strip exactly the two request shapes the gateway rejects.

const ENV_KEYS = ['E2E_PROVIDER_ID', 'E2E_PROVIDER_BASEURL', 'E2E_MODEL', 'E2E_APIKEY', 'E2E_TEST_API_KEY'] as const;

// prepare() runs only after a passing probe in the runner, so the tests
// mirror that contract: a complete model env is always present.
const BASE_MODEL_ENV: Record<string, string> = {
  E2E_PROVIDER_ID: 'maas',
  E2E_PROVIDER_BASEURL: 'https://example.invalid/v1',
  E2E_MODEL: 'glm-5.2',
};

function withModelEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const merged = { ...BASE_MODEL_ENV, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function fakeCodexHome(): { home: string; serverJs: string } {
  const home = fixtureDir('hwc-e2e-codex-driver-');
  const serverJs = join(
    home,
    '.codex',
    'plugins',
    'cache',
    getMarketplaceName(),
    getCodexPluginName(),
    '9.9.9-test',
    'dist',
    'mcp-server.js',
  );
  mkdirSync(join(serverJs, '..'), { recursive: true });
  writeFileSync(serverJs, '// fake server for the config-merge test\n', 'utf8');
  // The telemetry sibling the devkit runtime creates next to the version
  // dir on first server boot — resolveServerJs must filter past it.
  mkdirSync(join(home, '.codex', 'plugins', 'cache', getMarketplaceName(), getCodexPluginName(), 'telemetry'), {
    recursive: true,
  });
  // The installer-shaped config.toml a real `codex plugin marketplace add` +
  // `codex plugin add` pair writes (spike ground truth): two tables, no
  // top-level keys — the exact content the merge must sit between.
  const config = [
    `[marketplaces.${getMarketplaceName()}]`,
    'source_type = "local"',
    `source = "${home}"`,
    '',
    `[plugins."${getCodexPluginName()}@${getMarketplaceName()}"]`,
    'enabled = true',
    '',
  ].join('\n');
  writeFileSync(join(home, '.codex', 'config.toml'), config, 'utf8');
  return { home, serverJs };
}

function preparedConfig(): { home: string; serverJs: string; configPath: string; loaderPath: string } {
  const { home, serverJs } = fakeCodexHome();
  const ctx: DriverContext = { home, workdir: home, platform: process.platform };
  withModelEnv({ E2E_APIKEY: 'test-key', E2E_TEST_API_KEY: undefined }, () => codexDriver.prepare(ctx));
  return {
    home,
    serverJs,
    configPath: join(home, '.codex', 'config.toml'),
    loaderPath: join(home, 'mcp-env-loader.mjs'),
  };
}

test('codex prepare merges config.toml with top-level keys before any table header', () => {
  const { serverJs, configPath, loaderPath } = preparedConfig();
  assert.ok(existsSync(configPath), 'prepare must write config.toml');
  assert.ok(existsSync(loaderPath), 'prepare must write the env loader');
  const content = readFileSync(configPath, 'utf8');
  const lines = content.split('\n');
  // The first table header is the installer's marketplace entry; every
  // top-level key must sit above it, or TOML reassigns it into that table.
  const firstTable = lines.findIndex((line) => line.startsWith('['));
  for (const key of ['model =', 'model_provider =', 'web_search =', 'check_for_update_on_startup =']) {
    const at = lines.findIndex((line) => line.startsWith(key));
    assert.ok(at >= 0 && at < firstTable, `${key} must precede the first table header`);
  }
  // The installer-written tables survive between the prepended keys and the
  // appended driver tables.
  assert.match(content, new RegExp(`\\[marketplaces\\.${getMarketplaceName()}\\]`));
  assert.match(content, /source_type = "local"/);
  assert.match(content, /\[plugins\./);
  assert.match(content, /model = "glm-5\.2"/);
  assert.match(content, /web_search = "disabled"/);
  assert.match(content, /env_key = "E2E_APIKEY"/);
  assert.match(content, /wire_api = "responses"/);
  assert.match(content, /base_url = "http:\/\/127\.0\.0\.1:1\/v1"/);
  assert.match(content, /\[mcp_servers\.hwc\]/);
  assert.ok(content.includes(serverJs), 'the mcp_servers args must point at the installed plugin cache server');
  assert.ok(content.includes(join('mcp-env-loader.mjs')), 'the mcp_servers args must reference the env loader');
  assert.match(content, /HUAWEICLOUD_AGENT_TOOLKIT_MODE = "local"/);
  // The MCP child env is stripped to login vars, so the command must be an
  // absolute binary.
  assert.match(content, new RegExp(`command = "${process.execPath.replaceAll('\\', '\\\\')}"`));
});

test('codex prepare bridges E2E_TEST_APIKEY and blocks codex https egress', () => {
  const bridgedHome = fakeCodexHome();
  const bridged = withModelEnv({ E2E_APIKEY: undefined, E2E_TEST_API_KEY: 'alternate-key' }, () =>
    codexDriver.prepare({ home: bridgedHome.home, workdir: bridgedHome.home, platform: process.platform }),
  );
  assert.equal(bridged.E2E_APIKEY, 'alternate-key');
  assert.equal(bridged.https_proxy, 'http://127.0.0.1:9');
  assert.equal(bridged.HTTPS_PROXY, 'http://127.0.0.1:9');
  const directHome = fakeCodexHome();
  const direct = withModelEnv({ E2E_APIKEY: 'primary-key', E2E_TEST_API_KEY: 'alternate-key' }, () =>
    codexDriver.prepare({ home: directHome.home, workdir: directHome.home, platform: process.platform }),
  );
  assert.equal(direct.E2E_APIKEY, undefined);
  assert.equal(direct.https_proxy, 'http://127.0.0.1:9');
});

test('codex prepareHome creates the directory codex refuses to resolve', () => {
  const home = fixtureDir('hwc-e2e-codex-preparehome-');
  const codexHome = join(home, '.codex');
  assert.ok(!existsSync(codexHome));
  const installVars = codexDriver.prepareHome?.(home);
  assert.ok(existsSync(codexHome), 'prepareHome must create CODEX_HOME before install spawns codex');
  assert.equal(installVars?.https_proxy, 'http://127.0.0.1:9', 'prepareHome must arm the install-leg egress block');
  assert.equal(installVars?.HTTPS_PROXY, 'http://127.0.0.1:9');
});

test('the env loader merges mcp-env.json over the stripped child env and execs the server', async () => {
  const { home } = fakeCodexHome();
  // A fake server that proves the merged env reached it: the env-file value
  // wins over the (simulated stripped) child env, and both survive.
  const fakeServer = join(home, 'fake-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import { appendFileSync } from 'node:fs';",
      'const line = JSON.stringify({',
      '  trace: process.env.HUAWEICLOUD_DEVKIT_TRACE ?? null,',
      '  home: process.env.HOME ?? null,',
      '  marker: process.env.E2E_LOADER_MARKER ?? null,',
      '}) + "\\n";',
      'appendFileSync(process.env.E2E_LOADER_OUT, line);',
      '',
    ].join('\n'),
    'utf8',
  );
  const loader = join(home, 'mcp-env-loader.mjs');
  withModelEnv({ E2E_APIKEY: 'k' }, () => {
    // prepare writes the real loader; the env file is a runPrompt concern,
    // so the test writes its own to exercise the loader contract.
    codexDriver.prepare({ home, workdir: home, platform: process.platform });
  });
  assert.ok(existsSync(loader), 'prepare must have written the loader');
  const out = join(home, 'loader-out.jsonl');
  writeFileSync(
    join(home, 'mcp-env.json'),
    JSON.stringify({ E2E_LOADER_MARKER: 'from-env-file', HUAWEICLOUD_DEVKIT_TRACE: '/trace.jsonl', HOME: home }),
    'utf8',
  );
  const child = spawn(process.execPath, [loader, fakeServer], {
    env: { PATH: process.env.PATH, HOME: '/stripped/login/home', E2E_LOADER_OUT: out },
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((resolveExit) => child.on('close', resolveExit));
  assert.equal(code, 0, 'the loader must exit with the server status');
  const seen = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(seen.marker, 'from-env-file', 'env-file values must reach the server');
  assert.equal(seen.trace, '/trace.jsonl', 'seam values must reach the server');
  assert.equal(seen.home, home, 'env-file values must win over the stripped child env');
  // Exit-status propagation: a server exiting nonzero must surface through
  // the loader, not be swallowed into a clean-looking exit.
  const failingServer = join(home, 'failing-server.mjs');
  writeFileSync(failingServer, 'process.exit(3);\n', 'utf8');
  const failing = spawn(process.execPath, [loader, failingServer], { stdio: 'ignore' });
  const failingCode = await new Promise<number | null>((resolveExit) => failing.on('close', resolveExit));
  assert.equal(failingCode, 3, 'the loader must propagate the server exit code');
});

test('shapeForGateway strips the namespace field and joins array outputs', () => {
  const shaped = JSON.parse(
    shapeForGateway(
      JSON.stringify({
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          { type: 'function_call', name: 'tool', namespace: 'mcp__hwc', arguments: '{}', call_id: 'c1' },
          {
            type: 'function_call_output',
            call_id: 'c1',
            output: [
              { type: 'input_text', text: 'a' },
              { type: 'input_text', text: 'b' },
            ],
          },
        ],
      }),
    ),
  );
  const fc = shaped.input.find((item: { type: string }) => item.type === 'function_call');
  const fco = shaped.input.find((item: { type: string }) => item.type === 'function_call_output');
  assert.equal(fc.namespace, undefined, 'namespace must be stripped');
  assert.equal(fco.output, 'ab', 'array output must be joined into a string');
  // Non-POST-shaped and already-clean bodies pass through unchanged.
  assert.equal(shapeForGateway('not json'), 'not json');
  const clean = JSON.stringify({ input: [{ type: 'message', role: 'user' }] });
  assert.equal(shapeForGateway(clean), clean);
});

test('gateway proxy forwards shaped requests and streams responses through', async () => {
  const seen: { url?: string; body?: string }[] = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.created\n');
      res.write('data: {}\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const proxy = await startGatewayProxy(`http://127.0.0.1:${upstreamPort}`);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: [
          { type: 'function_call', name: 'tool', namespace: 'mcp__hwc', arguments: '{}', call_id: 'c1' },
          { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'x' }] },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const streamed = await response.text();
    assert.match(streamed, /response\.created/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, '/v1/responses');
    const forwarded = JSON.parse(seen[0]?.body ?? '{}');
    assert.equal(forwarded.input[0].namespace, undefined);
    assert.equal(forwarded.input[1].output, 'x');
  } finally {
    await proxy.close();
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
  }
});

test('gateway proxy reconstructs path-bearing base URLs (driver rewrite shape)', async () => {
  // The driver rewrites codex's base_url to
  // http://127.0.0.1:<port><pathname-of-real-base>; codex then requests
  // <pathname>/responses and origin + req.url must rebuild the real URL.
  // Both shapes are pinned: a path prefix (/openai/v1, the maas shape) and
  // a path-less base (no trailing slash — a // route would 404).
  for (const pathname of ['/openai/v1', '']) {
    const seen: string[] = [];
    const upstream = http.createServer((req, res) => {
      seen.push(String(req.url));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const realBase = new URL(`http://127.0.0.1:${upstreamPort}${pathname || '/'}`);
    const proxy = await startGatewayProxy(realBase.origin);
    try {
      const localBase = `http://127.0.0.1:${proxy.port}${pathname}`;
      const response = await fetch(`${localBase}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: [] }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(seen, [`${pathname}/responses`], 'the upstream must see the exact route');
    } finally {
      await proxy.close();
      await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    }
  }
});
