import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { redactSecrets } from '../plugins/huaweicloud-core/src/safety-policy.ts';
import { createDevkitMcpServer, createLinkedDevkitServers } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';
import {
  callOpenMcpTool,
  resolveGatewayCommand,
  resolveGatewaySpawnArgs,
  _gatewaySurface,
  _openMcpSidecarStats,
  _resetOpenMcpSidecar,
} from '../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/sidecar.ts';
import {
  classify,
  matchingDenyRule,
  resolveApprovalMode,
} from '../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/approval.ts';

// The five huaweicloud-open-mcp pack lifecycle invariants from the pack-system decision
// record, driven through the real dispatch surfaces with a fake gateway
// (test/fixtures/fake-open-mcp-sidecar.mjs). The Node suite never depends on
// Python or uv: OPENMCP_BIN points every spawn at the fixture.

const root = fileURLToPath(new URL('..', import.meta.url));
const fakeSidecar = join(root, 'test', 'fixtures', 'fake-open-mcp-sidecar.mjs');
process.env.OPENMCP_BIN = fakeSidecar;

// The sidecar's lazy spawn now provisions the policy base; pin the state
// home so tests never write into the real user config tree.
const stateHome = mkdtempSync(join(tmpdir(), 'openmcp-state-home-'));
process.env.HUAWEICLOUD_HOME = stateHome;

const OPEN_MCP_TOOLS = new Set([
  'huaweicloud_search_apis',
  'huaweicloud_list_products',
  'huaweicloud_get_product',
  'huaweicloud_list_apis',
  'huaweicloud_get_api',
  'huaweicloud_get_api_examples',
  'huaweicloud_gateway_list_tools',
  'huaweicloud_gateway_call',
  'huaweicloud_gateway_restart',
]);

// node --test runs each file in its own process; the try/finally keeps later
// tests in this file honest when a test pins DEVKIT_PACKS.
function withDevkitPacks(value, fn) {
  return async () => {
    const previous = process.env.DEVKIT_PACKS;
    process.env.DEVKIT_PACKS = value;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.DEVKIT_PACKS;
      else process.env.DEVKIT_PACKS = previous;
    }
  };
}

// The fake gateway reads its env at spawn time, so a test that needs a knob
// must reset the sidecar after setting it (and again after restoring) — the
// FAKE_FAIL_HANDSHAKE pattern, lifted into a helper for the policy/drift
// matrix below.
function withGatewayEnv(overrides, fn) {
  return async () => {
    const saved = {};
    for (const [key, value] of Object.entries(overrides)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    await _resetOpenMcpSidecar();
    try {
      await fn();
    } finally {
      for (const key of Object.keys(overrides)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await _resetOpenMcpSidecar();
    }
  };
}

// Invariant 1: a trimmed pack registers no tools AND never spawns the sidecar.
// The registry imports every pack's handler modules unconditionally, so the
// zero-spawn half is exactly what lazy spawning has to guarantee.
test(
  'DEVKIT_PACKS excluding huaweicloud-open-mcp registers no gateway tools and spawns nothing',
  withDevkitPacks('core', async () => {
    const { server, transport } = await createLinkedDevkitServers();
    const client = new Client({ name: 'open-mcp-trim-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      assert.equal(names.length, 10, 'core-only tools/list');
      for (const name of OPEN_MCP_TOOLS) {
        assert.ok(!names.includes(name), `${name} must not be registered when huaweicloud-open-mcp is trimmed`);
      }
      assert.equal(_openMcpSidecarStats().spawns, 0, 'a trimmed pack must never spawn the sidecar');
    } finally {
      await client.close();
      await server.close();
    }
  }),
);

test('pack meta discloses the huaweicloud-open-mcp pack with its nine tools', async () => {
  const info = await callTool('huaweicloud_pack_info', { pack: 'huaweicloud-open-mcp' });
  assert.equal(info.ok, true);
  assert.equal(info.enabled, true);
  assert.equal(info.tools.length, 9);
  for (const entry of info.tools) {
    assert.ok(OPEN_MCP_TOOLS.has(entry.name), `${entry.name} must be one of the pack's tools`);
    assert.equal(typeof entry.description, 'string');
  }
  assert.equal(_openMcpSidecarStats().spawns, 0, 'pack meta must not spawn the sidecar');
});

test('metadata proxy round-trips through the sidecar', async () => {
  const result = await callTool('huaweicloud_search_apis', { query: 'ecs', limit: 5 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.tool, 'search_apis');
  assert.equal(result.arguments.query, 'ecs');
  assert.equal(result.arguments.limit, 5);
  assert.equal(typeof result.pid, 'number');
  assert.equal(_openMcpSidecarStats().spawns, 1, 'first call lazily spawns exactly once');
  assert.equal(_openMcpSidecarStats().alive, true);
});

// Invariant 2: the remote transport constructs and closes an McpServer per
// HTTP request; the sidecar is a process-scope singleton that must not
// notice.
test('remote-style per-request server construction does not touch the sidecar', async () => {
  const before = _openMcpSidecarStats();
  const first = createDevkitMcpServer({ sessionId: 'remote-1' });
  await first.close();
  const second = createDevkitMcpServer({ sessionId: 'remote-2' });
  await second.close();
  assert.equal(_openMcpSidecarStats().spawns, before.spawns, 'server construct/close must not spawn or kill');
  const result = await callTool('huaweicloud_list_products', { keyword: 'ecs' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.tool, 'list_products');
  assert.equal(_openMcpSidecarStats().spawns, before.spawns, 'the existing singleton serves later calls');
});

test('a dead sidecar is respawned by the next call, not awaited forever', async () => {
  const first = await callTool('huaweicloud_get_product', { product: 'ECS' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const spawnsBefore = _openMcpSidecarStats().spawns;
  process.kill(first.pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(_openMcpSidecarStats().alive, false, 'the singleton must register the child death');
  const second = await callTool('huaweicloud_get_product', { product: 'VPC' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.pid, first.pid, 'the next call must be served by a fresh child');
  assert.equal(_openMcpSidecarStats().spawns, spawnsBefore + 1);
});

// All four normalization branches: the real gateway answers successful
// calls as structuredContent and refusals two different ways (isError for
// protocol-level rejections, {ok:false, reason} envelopes for policy ones).
test('normalization covers structuredContent, isError, envelope failures, and raw text', async () => {
  const echoed = await callOpenMcpTool('search_apis', { query: 'ecs' });
  assert.equal(echoed.ok, true, JSON.stringify(echoed));
  assert.equal(echoed.arguments.query, 'ecs');
  assert.equal(typeof echoed.pid, 'number');

  const failing = await callOpenMcpTool('failing_tool', {});
  assert.equal(failing.ok, false);
  assert.equal(failing.error, 'fake gateway tool failure');

  const envelope = await callOpenMcpTool('envelope_fail_tool', {});
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'fake envelope failure', 'reason must map into the repo-standard error key');
  assert.equal(envelope.reason, 'fake envelope failure', 'reason is kept for gateway fidelity');

  const rawText = await callOpenMcpTool('raw_text_tool', {});
  assert.equal(rawText.ok, true);
  assert.equal(rawText.raw, 'not json at all');
});

// Regression for the EPIPE crash: a call whose write lands between the
// child's OS-level death and Node's 'exit' delivery used to raise an
// unhandled 'error' on the stdin socket and take down the whole server
// (reproduced by probe). The stdin error handler must turn it into a fast
// {ok:false} instead.
test('a call racing child death fails fast instead of crashing the server', async () => {
  const first = await callTool('huaweicloud_get_product', { product: 'ECS' });
  assert.equal(first.ok, true, JSON.stringify(first));
  process.kill(first.pid, 'SIGKILL');
  // Block the event loop so 'exit' cannot be delivered yet: the write below
  // hits the kernel-broken pipe inside the exact EPIPE window.
  const blockedUntil = Date.now() + 50;
  while (Date.now() < blockedUntil) {
    /* spin */
  }
  const raced = await callOpenMcpTool('get_product', { product: 'VPC' }, 2000);
  assert.equal(raced.ok, false, 'the racing call must fail, not hang or crash');
  let cleared = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!_openMcpSidecarStats().alive) {
      cleared = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(cleared, 'the singleton must clear once the child death is delivered');
  const revived = await callTool('huaweicloud_get_product', { product: 'RDS' });
  assert.equal(revived.ok, true, JSON.stringify(revived));
});

// Gateway resolution order, pinned deterministically: OPENMCP_BIN → a
// persistent install (~/.local/bin or PATH) → the uvx fallback, which runs
// the gateway with no persistent install at all.
test('gateway resolution prefers OPENMCP_BIN, then disk, then uvx', () => {
  const direct = resolveGatewayCommand({ OPENMCP_BIN: fakeSidecar, HOME: '/nonexistent', PATH: '/usr/bin' });
  assert.equal(direct.command, fakeSidecar);
  assert.deepEqual(direct.argsPrefix, []);

  const home = mkdtempSync(join(tmpdir(), 'openmcp-res-home-'));
  const binDir = mkdtempSync(join(tmpdir(), 'openmcp-res-bin-'));
  const fakeUvx = join(binDir, 'uvx');
  writeFileSync(fakeUvx, `#!/bin/sh\nshift\nexec "${process.execPath}" "${fakeSidecar}" "$@"\n`, { mode: 0o755 });
  const envUvxOnly = { HOME: home, PATH: `/usr/bin:${binDir}` };
  const viaUvx = resolveGatewayCommand(envUvxOnly);
  assert.equal(viaUvx.command, fakeUvx, 'with nothing on disk, uvx is the fallback');
  assert.deepEqual(viaUvx.argsPrefix, ['huaweicloud-open-mcp']);

  // A persistent install in ~/.local/bin outranks the uvx fallback.
  const localBin = join(home, '.local', 'bin');
  mkdirSync(localBin, { recursive: true });
  const installed = join(localBin, 'huaweicloud-open-mcp');
  writeFileSync(installed, `#!/bin/sh\nexec "${process.execPath}" "${fakeSidecar}" "$@"\n`, { mode: 0o755 });
  const viaDisk = resolveGatewayCommand(envUvxOnly);
  assert.equal(viaDisk.command, installed);
  assert.deepEqual(viaDisk.argsPrefix, []);
});

// The uvx path end to end: with no gateway binary anywhere and only a fake
// uvx on PATH, a tool call must spawn through it (uvx <package> <args>)
// and complete the round trip.
test('a tool call runs end to end through the uvx fallback', { skip: process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'openmcp-uvx-home-'));
  const binDir = mkdtempSync(join(tmpdir(), 'openmcp-uvx-bin-'));
  const fakeUvx = join(binDir, 'uvx');
  writeFileSync(fakeUvx, `#!/bin/sh\nshift\nexec "${process.execPath}" "${fakeSidecar}" "$@"\n`, { mode: 0o755 });

  const savedBin = process.env.OPENMCP_BIN;
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  delete process.env.OPENMCP_BIN;
  process.env.HOME = home;
  process.env.PATH = `/usr/bin:${binDir}`;
  try {
    await _resetOpenMcpSidecar();
    const result = await callTool('huaweicloud_search_apis', { query: 'via-uvx' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.arguments.query, 'via-uvx');
    assert.equal(typeof result.pid, 'number');
  } finally {
    if (savedBin === undefined) delete process.env.OPENMCP_BIN;
    else process.env.OPENMCP_BIN = savedBin;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    await _resetOpenMcpSidecar();
  }
});

// A failed handshake must kill the spawned child: the parent holds the
// child's stdin pipe open, so an un-killed orphan survives (and pins the
// event loop) for the process lifetime — one leak per retry.
test('a failed handshake kills the spawned child (no orphan)', async () => {
  await _resetOpenMcpSidecar();
  const previous = process.env.FAKE_FAIL_HANDSHAKE;
  process.env.FAKE_FAIL_HANDSHAKE = '1';
  try {
    const result = await callOpenMcpTool('search_apis', { query: 'boom' });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /fake handshake failure/);
    assert.equal(_openMcpSidecarStats().alive, false, 'a failed spawn must clear the singleton');
    const pid = _openMcpSidecarStats().lastPid;
    assert.ok(Number.isSafeInteger(pid), 'stats must expose the spawned child pid');
    let gone = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        gone = true;
        break;
      }
    }
    assert.ok(gone, 'the handshake-failed child must be killed, not orphaned');
  } finally {
    if (previous === undefined) delete process.env.FAKE_FAIL_HANDSHAKE;
    else process.env.FAKE_FAIL_HANDSHAKE = previous;
    await _resetOpenMcpSidecar();
  }
});

// Invariant 3: the child's lifetime is the parent's stdin pipe. The driver
// uses the real sidecar module, prints the child pid, then exits; the child
// must follow.
test('the sidecar dies with its parent process (stdin pipe EOF)', async () => {
  const driver = join(root, 'test', 'fixtures', 'open-mcp-sidecar-driver.mjs');
  const child = spawn(process.execPath, [driver], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  await new Promise((resolve) => child.on('close', resolve));
  const pid = Number(out.trim());
  assert.ok(Number.isSafeInteger(pid), `driver must print the sidecar pid, got: ${out.trim()}`);
  let gone = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      gone = true;
      break;
    }
  }
  assert.ok(gone, 'the sidecar must exit after its parent process exits');
});

test('sidecar errors surface as ok:false results, never as throws', async () => {
  // A tool name the fake gateway does not implement answers JSON-RPC
  // -32602; the proxy must normalize that into {ok:false} the way the
  // obs/auth pack handlers do. The reset runs in finally so a failing
  // assertion fails cleanly instead of leaving the sidecar child's pipes
  // holding the event loop open.
  try {
    const result = await callOpenMcpTool('no_such_tool', {});
    assert.equal(result.ok, false);
    assert.equal(result.tool, 'no_such_tool');
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
    assert.equal(_openMcpSidecarStats().spawns > 0, true, 'the cumulative spawn counter stays honest');
  } finally {
    await _resetOpenMcpSidecar();
    assert.equal(_openMcpSidecarStats().alive, false, 'reset clears the singleton');
  }
});

// The restart tool's contract, driven through the pack's real dispatch with
// the fake gateway: a live child recycles to a NEW pid, and with no prior
// spawn the restart is just one spawn (idempotent). stats.spawns is the
// module-level cumulative counter, so the assertions are deltas.
test('huaweicloud_gateway_restart recycles a live child and spawns fresh when none exists', async () => {
  await _resetOpenMcpSidecar();
  try {
    // No prior spawn: the restart is a single spawn.
    let before = _openMcpSidecarStats().spawns;
    let result = await callTool('huaweicloud_gateway_restart', {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.spawns - before, 1, 'first restart with no live child is one spawn');
    const firstPid = result.pid;
    assert.ok(firstPid !== null, 'the new child must report a pid');

    // Live child: the restart stops it and spawns a replacement.
    before = _openMcpSidecarStats().spawns;
    result = await callTool('huaweicloud_gateway_restart', {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.spawns - before, 1, 'a live child adds exactly one more spawn');
    assert.notEqual(result.pid, firstPid, 'the recycled child must be a new process');

    // The replacement actually serves proxy calls.
    const probe = await callTool('huaweicloud_list_products', {});
    assert.equal(probe.ok, true, JSON.stringify(probe));
  } finally {
    await _resetOpenMcpSidecar();
    assert.equal(_openMcpSidecarStats().alive, false, 'reset clears the singleton');
  }
});

// ── Spawn-arg policy (pin-unless-env for mode/policy; audit never) ──
// resolveGatewaySpawnArgs is pure, so every branch pins without a spawn;
// the end-to-end tests below then drive the same decisions through the
// real sidecar and assert them from the fake gateway's argv/env echo.

test('resolveGatewaySpawnArgs pins openapi + the provisioned policy when gateway envs are unset', () => {
  const home = mkdtempSync(join(tmpdir(), 'openmcp-args-home-'));
  const plan = resolveGatewaySpawnArgs({ HOME: home, HUAWEICLOUD_HOME: home });
  assert.deepEqual(
    plan.args.filter((arg) => arg.startsWith('--')),
    ['--elicitation', '--mode', '--policy', '--log-file'],
    'flag order and completeness',
  );
  assert.equal(plan.args[plan.args.indexOf('--mode') + 1], 'openapi');
  assert.ok(plan.provision, 'the devkit provisions the policy base when no operator path is set');
  assert.equal(plan.provision.dir, join(home, '.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp'));
  assert.equal(plan.provision.policyPath, join(plan.provision.dir, 'policy'));
  assert.equal(plan.args[plan.args.indexOf('--policy') + 1], plan.provision.policyPath);
});

test('resolveGatewaySpawnArgs defers to operator envs and never passes an audit arg', () => {
  const plan = resolveGatewaySpawnArgs({
    HOME: '/nonexistent',
    HUAWEICLOUD_MCP_MODE: 'data',
    HUAWEICLOUD_MCP_POLICY_FILE: '/opt/gw-policy',
    HUAWEICLOUD_MCP_AUDIT_FILE: '/opt/gw-audit.ndjson',
  });
  assert.ok(!plan.args.includes('--mode'), 'operator mode env wins; no --mode arg');
  assert.ok(!plan.args.includes('--policy'), 'operator policy env wins; no --policy arg');
  assert.equal(plan.provision, null, 'no devkit provisioning when the operator owns the path');
  assert.ok(!plan.args.some((arg) => arg.startsWith('--audit-file')), 'audit is opt-in only, never passed');
  assert.deepEqual(plan.args, ['--elicitation', 'off', '--log-file', join(tmpdir(), 'huaweicloud-open-mcp.log')]);
});

test('resolveGatewaySpawnArgs rejects discover and unknown modes with a devkit-authored error', () => {
  for (const bad of ['discover', 'openapi,discover', 'openapi,data,banana', ',']) {
    assert.throws(
      () => resolveGatewaySpawnArgs({ HOME: '/h', HUAWEICLOUD_MCP_MODE: bad }),
      /not supported by the devkit proxy/,
    );
  }
  // Blank trims to unset: the openapi pin applies.
  const pinned = resolveGatewaySpawnArgs({ HOME: '/h', HUAWEICLOUD_MCP_MODE: '  ' });
  assert.ok(pinned.args.includes('--mode'));
  // Combinable supported modes validate without an arg (the env wins).
  const combined = resolveGatewaySpawnArgs({ HOME: '/h', HUAWEICLOUD_MCP_MODE: 'openapi,data' });
  assert.ok(!combined.args.includes('--mode'));
});

test('spawn wires the pinned mode, the provisioned policy file, and the scratch cwd', async () => {
  await _resetOpenMcpSidecar();
  try {
    const result = await callOpenMcpTool('search_apis', { query: 'spawn-args' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const argv = result.argv as string[];
    assert.ok(Array.isArray(argv), 'the fake echoes its argv');
    const modeIndex = argv.indexOf('--mode');
    assert.ok(modeIndex >= 0, 'unset mode env: the openapi pin is passed');
    assert.equal(argv[modeIndex + 1], 'openapi');
    const policyIndex = argv.indexOf('--policy');
    assert.ok(policyIndex >= 0, 'unset policy env: the provisioned policy is passed');
    const policyPath = argv[policyIndex + 1];
    assert.equal(policyPath, join(stateHome, '.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp', 'policy'));
    assert.ok(existsSync(policyPath), 'provisioning precedes spawn: the file exists');
    assert.equal((result.env as Record<string, unknown>).HUAWEICLOUD_MCP_MODE, null, 'no mode env was inherited');
    // The child reports process.cwd() (kernel-canonicalized), while
    // tmpdir() is the raw env string — on macOS /tmp is a symlink to
    // /private/tmp, so both sides compare through realpath. The cwd is a
    // per-child mkdtemp directory under tmpdir, never the shared root.
    const cwdReal = realpathSync(String(result.cwd));
    const tmpReal = realpathSync(tmpdir());
    assert.ok(
      cwdReal.startsWith(tmpReal + '/') || cwdReal.startsWith(tmpReal + '\\'),
      `the child cwd must live under tmpdir (${cwdReal} vs ${tmpReal})`,
    );
    assert.notEqual(cwdReal, tmpReal, 'the cwd is a per-child scratch dir, not the shared tmpdir root');
    if (process.platform !== 'win32') {
      assert.equal(statSync(policyPath).mode & 0o777, 0o600, 'policy file is 0600');
      assert.equal(statSync(dirname(policyPath)).mode & 0o777, 0o700, 'state dir is 0700');
    }
  } finally {
    await _resetOpenMcpSidecar();
  }
});

test('an operator mode env suppresses the pin and reaches the gateway child', async () => {
  await _resetOpenMcpSidecar();
  const saved = process.env.HUAWEICLOUD_MCP_MODE;
  process.env.HUAWEICLOUD_MCP_MODE = 'data';
  try {
    const result = await callOpenMcpTool('search_apis', { query: 'mode-env' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(!((result.argv as string[]) || []).includes('--mode'), 'env set: no --mode arg, the env wins');
    assert.equal((result.env as Record<string, unknown>).HUAWEICLOUD_MCP_MODE, 'data', 'the child saw the env');
  } finally {
    if (saved === undefined) delete process.env.HUAWEICLOUD_MCP_MODE;
    else process.env.HUAWEICLOUD_MCP_MODE = saved;
    await _resetOpenMcpSidecar();
  }
});

test('an operator policy env suppresses devkit provisioning', async () => {
  await _resetOpenMcpSidecar();
  const operatorPolicy = join(stateHome, 'operator-policy');
  writeFileSync(operatorPolicy, '', { mode: 0o600 });
  const saved = process.env.HUAWEICLOUD_MCP_POLICY_FILE;
  process.env.HUAWEICLOUD_MCP_POLICY_FILE = operatorPolicy;
  try {
    const result = await callOpenMcpTool('search_apis', { query: 'operator-policy' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(!((result.argv as string[]) || []).includes('--policy'), 'operator policy env wins: no --policy arg');
    assert.equal(
      (result.env as Record<string, unknown>).HUAWEICLOUD_MCP_POLICY_FILE,
      operatorPolicy,
      'the child saw the operator env',
    );
  } finally {
    if (saved === undefined) delete process.env.HUAWEICLOUD_MCP_POLICY_FILE;
    else process.env.HUAWEICLOUD_MCP_POLICY_FILE = saved;
    await _resetOpenMcpSidecar();
  }
});

// ── approval.ts unit surface (pure decision table; no gateway child) ──

test('classify: read-only discovery tools and manage_policy list pass through', () => {
  for (const tool of ['search_apis', 'list_products', 'get_product', 'list_apis', 'get_api', 'get_api_examples']) {
    assert.deepEqual(classify(tool, {}, 'devkit', null), { verdict: 'passthrough' }, tool);
    assert.deepEqual(
      classify(tool, {}, 'native', null),
      { verdict: 'passthrough' },
      `${tool} stays readonly in native mode`,
    );
  }
  assert.deepEqual(classify('manage_policy', { action: 'list' }, 'devkit', null), { verdict: 'passthrough' });
});

test('classify: manage_policy add demands an explicit ephemeral scope', () => {
  for (const scope of ['once', 'session', 'temporary', ' ONCE ', 'Session']) {
    assert.deepEqual(
      classify('manage_policy', { action: 'add', line: 'ECS:X=allow', scope }, 'devkit', null),
      {
        verdict: 'token',
      },
      `scope ${scope}`,
    );
  }
  // The allow-list failure direction is closed: unknown, missing, and every
  // persistent spelling deny (round-4 probe bought an eternal grant
  // through 'PERMANENT' before this). Non-string scopes deny too — an
  // array ['once'] stringifies to 'once' and must not slip the gate.
  for (const scope of ['permanent', 'PERMANENT', ' permanent ', 'forever', 'banana', '', ['once'], { once: 1 }, 42]) {
    const toolArgs: Record<string, unknown> = { action: 'add', line: 'ECS:X=allow' };
    toolArgs.scope = scope;
    const ruling = classify('manage_policy', toolArgs, 'devkit', null);
    assert.equal(ruling.verdict, 'deny', `scope ${JSON.stringify(scope)} must deny`);
    assert.match(String(ruling.reason), /ephemeral scopes|policy file/);
  }
  // remove: the token binds the rule text; scope is REJECTED on remove
  // (round-8: the gateway refuses a scoped remove outright — a token-gated
  // remove+scope burned the approval on a guaranteed rejection).
  assert.deepEqual(classify('manage_policy', { action: 'remove', line: 'ECS:X=allow' }, 'devkit', null), {
    verdict: 'token',
  });
  for (const scope of ['once', 'permanent']) {
    const scoped = classify('manage_policy', { action: 'remove', line: 'ECS:X=allow', scope }, 'native', null);
    assert.equal(scoped.verdict, 'deny', `remove with scope ${scope} denies before consent is spent`);
    assert.match(String(scoped.reason), /takes no scope/);
  }
  // Action normalization (round-6): case/whitespace variants route into
  // the add/remove branches like their canonical spellings — 'ADD' with a
  // valid ephemeral scope spends a token, not a deny. Genuinely unknown
  // actions (and non-strings) deny: scope admission must never depend on
  // the gateway being spelling-stricter than the classifier.
  assert.deepEqual(
    classify('manage_policy', { action: 'ADD', line: 'ECS:X=allow', scope: 'once' }, 'devkit', null),
    { verdict: 'token' },
    'normalized ADD routes into the add branch',
  );
  for (const action of ['append', ['add'], 42, undefined]) {
    const toolArgs: Record<string, unknown> = { line: 'ECS:X=allow', scope: 'once' };
    if (action !== undefined) toolArgs.action = action;
    const ruling = classify('manage_policy', toolArgs, 'devkit', null);
    assert.equal(ruling.verdict, 'deny', `action ${JSON.stringify(action)} must deny`);
    assert.match(String(ruling.reason), /only list, add, and remove/);
  }
});

test('classify: execute_api secret reads are denied in both modes', () => {
  for (const mode of ['devkit', 'native']) {
    const ruling = classify('execute_api', { product: 'DEW', api: 'ShowSecretVersion' }, mode, null);
    assert.equal(ruling.verdict, 'deny', mode);
    assert.match(String(ruling.reason), /secret/i);
  }
});

test('classify: surface drift denies execute_api in both modes; native passes through otherwise', () => {
  const args = { product: 'ECS', api: 'CreateServers' };
  assert.deepEqual(classify('execute_api', args, 'devkit', null), { verdict: 'token' }, 'unknown surface: token');
  assert.deepEqual(
    classify('execute_api', args, 'native', new Set(['execute_api'])),
    { verdict: 'passthrough' },
    'native delegates to the gateway policy engine',
  );
  const withoutExecuteApi = new Set(['search_apis']);
  for (const mode of ['devkit', 'native']) {
    const ruling = classify('execute_api', args, mode, withoutExecuteApi);
    assert.equal(ruling.verdict, 'deny', mode);
    assert.match(String(ruling.reason), /drift/);
  }
});

test('classify: the drift gate covers every non-read-only tool and skips read-only names', () => {
  const surface = new Set(['search_apis', 'list_products']);
  for (const tool of ['transform_data', 'query_data', 'manage_policy', 'unknown_tool']) {
    const ruling = classify(tool, {}, 'devkit', surface);
    assert.equal(ruling.verdict, 'deny', `${tool} missing from the live surface denies as drift`);
    assert.match(String(ruling.reason), new RegExp(`no longer exposes ${tool}`));
  }
  // Read-only names skip the gate: a missing discovery tool never costs a
  // token and fails harmlessly at the gateway.
  assert.deepEqual(classify('list_products', {}, 'devkit', surface), { verdict: 'passthrough' });
});

test('classify: transform_data guards the protected tree; everything else fails closed', () => {
  const inside = classify(
    'transform_data',
    { out: { path: join(stateHome, '.config', 'huaweicloud', 'leak.csv') } },
    'devkit',
    null,
  );
  assert.equal(inside.verdict, 'deny');
  assert.match(String(inside.reason), /consent infrastructure|protected state tree/);
  assert.deepEqual(classify('transform_data', { out: { path: join(tmpdir(), 'plain.csv') } }, 'devkit', null), {
    verdict: 'token',
  });
  assert.deepEqual(
    classify('transform_data', { sql: 'select 1' }, 'devkit', null),
    { verdict: 'token' },
    'no out path: token',
  );
  assert.deepEqual(classify('query_data', { sql: 'select 1' }, 'devkit', null), { verdict: 'token' });
  assert.deepEqual(classify('unknown_tool', {}, 'native', null), { verdict: 'token' }, 'fail-closed on ignorance');
});

test('classify: every structured file target and credential-shaped SQL is denied for the data tools', () => {
  const protectedPath = join(stateHome, '.config', 'huaweicloud', 'approvals.json');
  // out.path on transform_data (the write target).
  assert.equal(
    classify('transform_data', { out: { path: protectedPath } }, 'devkit', null).verdict,
    'deny',
    'out.path into the tree denies',
  );
  // tables.*.path on BOTH data tools (query_data reads, transform_data
  // resolves them too) — round-4: the guard covered out.path only.
  for (const tool of ['query_data', 'transform_data']) {
    assert.equal(
      classify(tool, { sql: 'select * from t', tables: { victim: { path: protectedPath } } }, 'devkit', null).verdict,
      'deny',
      `${tool} tables path into the tree denies`,
    );
    assert.equal(
      classify(
        tool,
        { sql: 'select * from t', tables: { fine: { path: join(tmpdir(), 'plain.csv') } } },
        'devkit',
        null,
      ).verdict,
      'token',
      `${tool} tables path outside the tree spends a token`,
    );
  }
  // Best-effort text scan: a credential file referenced only inside SQL
  // (read_csv) trips the CLI face's own credential patterns.
  const sqlRead = classify(
    'query_data',
    { sql: "select * from read_csv('/home/u/.hcloud/config.json')" },
    'devkit',
    null,
  );
  assert.equal(sqlRead.verdict, 'deny', 'SQL credential literal denies');
  assert.match(String(sqlRead.reason), /credential/i);
});

test('classify: the path scan survives Windows separators and ignores separator-free mentions', () => {
  // Raw values are walked, never JSON.stringify: serialization doubles
  // backslashes, and 'C:\hcloud\config' (dotless, single separator) then
  // defeated the credential patterns (round-5 probe).
  const windowsDotless = classify(
    'query_data',
    { sql: "select * from read_csv('C:\\hcloud\\config')" },
    'devkit',
    null,
  );
  assert.equal(windowsDotless.verdict, 'deny', 'dotless Windows path in SQL denies');
  const windowsDotted = classify(
    'query_data',
    { sql: "select * from read_csv('C:\\Users\\u\\.hcloud\\config.json')" },
    'devkit',
    null,
  );
  assert.equal(windowsDotted.verdict, 'deny', 'dotted Windows path in SQL denies');
  // False-positive direction closed: a '.hcloud' mention with no path
  // separator is prose, not a file reference.
  const benign = classify('query_data', { sql: "select 'see the .hcloud docs for details'" }, 'devkit', null);
  assert.equal(benign.verdict, 'token', 'separator-free mentions are not file references');
  // Circular input terminates instead of throwing: classify rules, never
  // rejects.
  const circular: Record<string, unknown> = { sql: 'select 1' };
  circular.self = circular;
  assert.doesNotThrow(() => classify('query_data', circular, 'devkit', null));
  assert.equal(classify('query_data', circular, 'devkit', null).verdict, 'token');
  // A value that is itself a JSON string carries doubled separators in
  // memory (read_json('{"path":"C:\\\\hcloud\\\\config"}')); the collapsed
  // variant of each candidate restores the single separator the patterns
  // require (round-6).
  const jsonNested = classify('query_data', { sql: JSON.stringify({ path: 'C:\\hcloud\\config' }) }, 'devkit', null);
  assert.equal(jsonNested.verdict, 'deny', 'JSON-nested doubled separators still deny');
});

test('redactString covers auth-header values, quoted AK/SK, and Bearer forms', () => {
  const redacted = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
  assert.equal(redacted, 'Authorization: <redacted>', 'the multi-word bearer value redacts to end-of-line');
  const quotedAk = redactSecrets('pydinct error near {"AK":"AKIAXXXX","SK":"seCrEt"} trailing');
  assert.ok(!quotedAk.includes('AKIAXXXX'), 'quoted AK redacts');
  assert.ok(!quotedAk.includes('seCrEt'), 'quoted SK redacts');
  assert.match(quotedAk, /trailing/, 'surrounding prose survives');
  // Word boundary (round-7): 'task:', 'risk:', 'disk:' are NOT AK/SK keys.
  for (const prose of ['task: migrate the database', 'risk: high severity', 'disk: 100GB']) {
    const preserved = redactSecrets(prose);
    assert.equal(preserved, prose, `${prose} must survive verbatim`);
  }
  // The object walk and the string walk agree on input_value.
  assert.equal(redactSecrets({ input_value: 'SECRET' }).input_value, '<redacted>', 'object keys redact');
});

test('classify: manage_policy list is drift-denied when the tool is missing from the surface', () => {
  // Pinned behavior (fail-closed by design): manage_policy is not in the
  // read-only set, so a surface lacking it denies every action including
  // the read-only list — the tool is unreachable, its list most of all.
  const ruling = classify('manage_policy', { action: 'list' }, 'devkit', new Set(['search_apis']));
  assert.equal(ruling.verdict, 'deny');
  assert.match(String(ruling.reason), /drift/);
});

test('resolveApprovalMode: unset/devkit/native, and a loud failure for anything else', () => {
  assert.equal(resolveApprovalMode({}), 'devkit');
  assert.equal(resolveApprovalMode({ HUAWEICLOUD_OPENMCP_APPROVAL: '' }), 'devkit');
  assert.equal(resolveApprovalMode({ HUAWEICLOUD_OPENMCP_APPROVAL: ' devkit ' }), 'devkit');
  assert.equal(resolveApprovalMode({ HUAWEICLOUD_OPENMCP_APPROVAL: 'native' }), 'native');
  assert.throws(() => resolveApprovalMode({ HUAWEICLOUD_OPENMCP_APPROVAL: 'bogus' }), /HUAWEICLOUD_OPENMCP_APPROVAL/);
});

test('matchingDenyRule: JSON and plain-line files, wildcards, missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openmcp-deny-'));
  const jsonPolicy = join(dir, 'rules.json');
  writeFileSync(jsonPolicy, JSON.stringify(['*=allow', 'ECS:CreateServers=deny']));
  const linesPolicy = join(dir, 'rules.lines');
  writeFileSync(linesPolicy, 'ECS:CreateServers=deny\n*=deny\n');

  assert.equal(
    matchingDenyRule('ECS', 'CreateServers', { HUAWEICLOUD_MCP_POLICY_FILE: jsonPolicy })?.line,
    'ECS:CreateServers=deny',
    'a deny beats an earlier wildcard allow (stricter than the gateway first-match)',
  );
  assert.equal(
    matchingDenyRule('VPC', 'ListVpcs', { HUAWEICLOUD_MCP_POLICY_FILE: jsonPolicy }),
    null,
    'an allow-only match reads as no denial',
  );
  assert.equal(
    matchingDenyRule('vpc', 'listvpcs', { HUAWEICLOUD_MCP_POLICY_FILE: linesPolicy })?.line,
    '*=deny',
    'sides match anchored and case-insensitively',
  );
  assert.equal(
    matchingDenyRule('RDS', 'ListInstances', { HUAWEICLOUD_MCP_POLICY_FILE: join(dir, 'absent') }),
    null,
    'a missing file reads as no denial',
  );
});

test('matchingDenyRule: whole-line comments, spaced separators, unparseable forms', () => {
  // Round-8 (source-verified against the installed module): parse_policy
  // raises on inline '#' comments, on colon-less non-'*' targets, and on
  // any effect other than allow/deny — the gateway keeps its last valid
  // rules and the line is inert gateway-side. The devkit reads those
  // lines as UNPARSEABLE denials (fail-closed, distinct message) so a
  // broken operator file surfaces instead of silently trusting stale
  // rules. Only WHOLE-LINE comments are dropped.
  const dir = mkdtempSync(join(tmpdir(), 'openmcp-deny-hard-'));
  const policy = join(dir, 'policy');
  writeFileSync(
    policy,
    ['ECS : ListServers = deny', '# a whole-line comment', '', 'ECS:CreateServers=deny # inline note'].join('\n'),
  );
  const env = { HUAWEICLOUD_MCP_POLICY_FILE: policy };
  const spaced = matchingDenyRule('ECS', 'ListServers', env);
  assert.ok(spaced && !spaced.unparseable && spaced.line.startsWith('ECS : ListServers'), 'spaced separators parse');

  // The inline-comment line is unparseable: it denies every query with
  // the distinct broken-file flag, not the operator-deny framing.
  const inline = matchingDenyRule('ECS', 'CreateServers', env);
  assert.ok(inline && inline.unparseable, 'inline comments are parse failures');
  assert.match(inline.line, /# inline note/);
  const bystander = matchingDenyRule('DEW', 'ListSecrets', env);
  assert.ok(bystander && bystander.unparseable, 'an unparseable line denies unrelated products too');
  assert.equal(bystander.line, inline.line, 'the same broken line is reported');

  // Colon-less non-'*' targets and bad effects are unparseable as well
  // (the gateway raises on both).
  for (const bad of ['RDS=deny', 'VPC:DisassociateRouteTable=maybe', 'no equals sign']) {
    const dir2 = mkdtempSync(join(tmpdir(), 'openmcp-deny-bad-'));
    const policy2 = join(dir2, 'policy');
    writeFileSync(policy2, `${bad}\n`);
    const hit = matchingDenyRule('RDS', 'ListFlavors', { HUAWEICLOUD_MCP_POLICY_FILE: policy2 });
    assert.ok(hit && hit.unparseable, `${bad} is an unparseable deny (fail-closed)`);
    assert.equal(hit.line, bad);
  }
});

test('matchingDenyRule: fnmatch wildcards (?, classes, negation) match the gateway', () => {
  // Round-7: the gateway's matcher is fnmatch — '?', '[...]' and negated
  // '[!...]' classes are PATTERNS gateway-side; the old escaper treated
  // '?' and '[' literally. Round-8: negation was still mistranslated
  // ('[!A]' became a positive JS class of '!'|'A', both directions
  // wrong) and a backslash inside a class threw out of the pre-check.
  const dir = mkdtempSync(join(tmpdir(), 'openmcp-deny-fn-'));
  const policy = join(dir, 'policy');
  writeFileSync(
    policy,
    ['ECS:Create?ervers=deny', 'VPC:List[A-Z]pcs=deny', 'OBS:*Object=deny', 'RDS:List[!P]alavors=deny'].join('\n'),
  );
  const env = { HUAWEICLOUD_MCP_POLICY_FILE: policy };
  assert.ok(matchingDenyRule('ECS', 'CreateServers', env), '? matches one character');
  assert.ok(matchingDenyRule('ECS', 'CreateXervers', env), 'any single character');
  assert.equal(matchingDenyRule('ECS', 'CreateSerrvers', env), null, '? matches exactly one');
  assert.ok(matchingDenyRule('VPC', 'ListIpcs', env), 'character class matches inside');
  assert.equal(matchingDenyRule('VPC', 'List1pcs', env), null, 'class excludes outside');
  assert.ok(matchingDenyRule('OBS', 'GetObject', env), 'star still works');
  // Negation: '[!P]' matches any single character EXCEPT P.
  assert.ok(matchingDenyRule('RDS', 'ListMalavors', env), 'negated class admits a non-P character');
  assert.equal(matchingDenyRule('RDS', 'ListPalavors', env), null, 'negated class excludes P');

  // A backslash inside a class no longer throws out of the pre-check.
  const dir3 = mkdtempSync(join(tmpdir(), 'openmcp-deny-bs-'));
  const policy3 = join(dir3, 'policy');
  writeFileSync(policy3, 'ECS:List[\\w]pcs=deny\n');
  assert.doesNotThrow(() => matchingDenyRule('ECS', 'Listwpcs', { HUAWEICLOUD_MCP_POLICY_FILE: policy3 }));
});

// ── gateway_list_tools / gateway_call through the real dispatch ──

test('huaweicloud_gateway_list_tools reports the live surface and its drift', async () => {
  const result = await callTool('huaweicloud_gateway_list_tools', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.tools) && result.tools.length > 0, 'tools/list is non-empty');
  assert.ok(result.tools.every((tool) => typeof tool.name === 'string' && tool.inputSchema));
  assert.ok(result.drift && Array.isArray(result.drift.missing), 'drift is always reported');
  assert.ok(
    result.drift.missing.includes('execute_api'),
    'the default fake exposes no policy tools, so execute_api is drift-missing',
  );
});

test('gateway_call passes read-only discovery tools straight through', async () => {
  const result = await callTool('huaweicloud_gateway_call', { tool: 'search_apis', toolArgs: { query: 'ecs' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.tool, 'search_apis');
  assert.equal(result.arguments.query, 'ecs');
  assert.equal(result.requiresApproval, undefined, 'read-only tools never demand consent');
});

test(
  'gateway_call token round trip: redacted echo, approved replay, single use',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    const toolArgs = { sql: 'select 1', out: { path: 'x.csv' }, adminPass: 'Secret123' };
    const first = await callTool('huaweicloud_gateway_call', { tool: 'transform_data', toolArgs });
    assert.equal(first.ok, false);
    assert.equal(first.requiresApproval, true);
    assert.equal(first.classification, 'token');
    assert.equal(typeof first.approvalToken, 'string');
    assert.equal(first.toolArgs.adminPass, '<redacted>', 'the echoed copy must not carry the secret');
    assert.doesNotMatch(JSON.stringify(first), /Secret123/);

    const second = await callTool('huaweicloud_gateway_call', {
      tool: 'transform_data',
      toolArgs,
      approvalToken: first.approvalToken,
      approvedByUser: true,
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.tool, 'transform_data');
    assert.equal(second.arguments.adminPass, '<redacted>', 'the result boundary redacts gateway echoes too');

    const third = await callTool('huaweicloud_gateway_call', {
      tool: 'transform_data',
      toolArgs,
      approvalToken: first.approvalToken,
      approvedByUser: true,
    });
    assert.equal(third.ok, false);
    assert.match(String(third.error), /Invalid or expired approval token/);
  }),
);

test(
  'a replay with different toolArgs is refused and names the ORIGINAL unredacted copy',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    const minted = await callTool('huaweicloud_gateway_call', {
      tool: 'transform_data',
      toolArgs: { sql: 'select 1' },
    });
    assert.equal(minted.requiresApproval, true);
    const mismatch = await callTool('huaweicloud_gateway_call', {
      tool: 'transform_data',
      toolArgs: { sql: 'select 2' },
      approvalToken: minted.approvalToken,
      approvedByUser: true,
    });
    assert.equal(mismatch.ok, false);
    assert.match(String(mismatch.error), /ORIGINAL unredacted/);
  }),
);

test(
  'a same-line grant refuses the bridge without burning the token; removal unblocks it',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    // An agent-purchased once-grant for the exact line the bridge would add.
    const grantArgs = { action: 'add', line: 'ECS:CreateServers=allow', scope: 'once' };
    const plan = await callTool('huaweicloud_gateway_call', { tool: 'manage_policy', toolArgs: grantArgs });
    assert.equal(plan.requiresApproval, true);
    const added = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: grantArgs,
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(added.ok, true, JSON.stringify(added));

    // The bridged execute refuses: the bridge's line-based cleanup would
    // delete the existing grant and leave its own standing. The refusal
    // happens BEFORE the token is consumed.
    const execArgs = { product: 'ECS', api: 'CreateServers', region: 'cn-north-4' };
    const execPlan = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
    assert.equal(execPlan.requiresApproval, true);
    const refused = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: execPlan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /already exists/);
    assert.match(String(refused.error), /Remove the conflicting rule first/);

    // Removing the conflicting grant is itself a token-gated action.
    const removePlan = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'remove', line: 'ECS:CreateServers=allow' },
    });
    assert.equal(removePlan.requiresApproval, true);
    const removed = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'remove', line: 'ECS:CreateServers=allow' },
      approvalToken: removePlan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(removed.ok, true, JSON.stringify(removed));

    // The SAME execute token still works: the conflict refusal never
    // spent it. The bridge adds its grant, executes, burns, cleans up.
    const executed = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: execPlan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.deepEqual(executed.executed, { product: 'ECS', api: 'CreateServers' });

    const listing = await callTool('huaweicloud_gateway_call', { tool: 'manage_policy', toolArgs: { action: 'list' } });
    assert.equal(listing.ok, true, JSON.stringify(listing));
    assert.ok(
      !listing.rules.some((rule) => rule.line === 'ECS:CreateServers=allow'),
      'the bridged execute burned its own grant and left no residue',
    );
  }),
);

test(
  'the conflict pre-check sees redaction-mangled rule lines (token-suffixed APIs)',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    // A rule whose line trips the result redactor ('CreateToken' matches
    // the bare token alternative): the listing arrives as
    // 'IAM:CreateToken=<redacted>' while the local grant line is raw.
    // Round-6: the one-sided comparison silently defeated the whole
    // pre-check for exactly the IAM token class; both sides now go
    // through the same redactor.
    const grantArgs = { action: 'add', line: 'IAM:CreateToken=allow', scope: 'session' };
    const plan = await callTool('huaweicloud_gateway_call', { tool: 'manage_policy', toolArgs: grantArgs });
    const added = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: grantArgs,
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(added.ok, true, JSON.stringify(added));

    const execArgs = { product: 'IAM', api: 'CreateToken' };
    const execPlan = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
    const refused = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: execPlan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(refused.ok, false, 'the mangled listing must still read as a conflict');
    assert.match(String(refused.error), /already exists/);
    assert.match(String(refused.error), /Remove the conflicting rule first/);
  }),
);

test(
  'the conflict pre-check matches the gateway semantic key: spacing and case',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    // Round-7: the gateway's remove matches on its semantic rule key
    // (source-verified), so 'ECS : CreateServers = allow' is the SAME
    // rule to the gateway as 'ECS:CreateServers=allow'. The literal
    // comparison previously missed it while the bridge's cleanup still
    // deleted the operator's rule. (Inline '#' comments are NOT valid
    // add lines — the gateway and the fake both reject them now — so
    // this test exercises spacing and case only.)
    const spaced = 'ECS : CreateServers = allow';
    const grantArgs = { action: 'add', line: spaced, scope: 'session' };
    const plan = await callTool('huaweicloud_gateway_call', { tool: 'manage_policy', toolArgs: grantArgs });
    const added = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: grantArgs,
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(added.ok, true, JSON.stringify(added));

    const execArgs = { product: 'ECS', api: 'CreateServers' };
    const execPlan = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
    const refused = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: execPlan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(refused.ok, false, 'a semantically equal spaced rule is a conflict');
    assert.match(String(refused.error), /already exists/);

    // And the lowercase variant too: 'ecs:createservers=allow'.
    const lower = { action: 'add', line: 'ecs:createservers=allow', scope: 'session' };
    const lowerPlan = await callTool('huaweicloud_gateway_call', { tool: 'manage_policy', toolArgs: lower });
    const lowerAdded = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: lower,
      approvalToken: lowerPlan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(lowerAdded.ok, true, JSON.stringify(lowerAdded));
    const refusedAgain = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: execPlan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(refusedAgain.ok, false, 'the lowercase spelling is the same semantic rule');
  }),
);

test(
  'distinct token-suffixed rules do not cross-conflict through the redaction boundary',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    // Round-8: the shared wildcard sentinel made every redaction-mangled
    // rule one semantic key, so an unrelated IAM:CreateAccessKey grant
    // falsely conflicted with an IAM:DeleteAccessKey execute (probe: the
    // remediation dead-looped on remove). Unparseable keys are per-line
    // now: the equal-pair match still works, the cross-pair does not.
    const grantArgs = { action: 'add', line: 'IAM:CreateAccessKey=allow', scope: 'session' };
    const plan = await callTool('huaweicloud_gateway_call', { tool: 'manage_policy', toolArgs: grantArgs });
    const added = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: grantArgs,
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(added.ok, true, JSON.stringify(added));

    // A DIFFERENT token-suffixed API: both lines mangle to
    // '...<redacted>' in the listing, but their keys stay distinct.
    const execArgs = { product: 'IAM', api: 'DeleteAccessKey' };
    const execPlan = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
    const notConflicted = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: execPlan.approvalToken,
      approvedByUser: true,
    });
    assert.ok(!/already exists/.test(String(notConflicted.error)), 'a different rule is not a conflict');
    assert.ok(
      notConflicted.ok === true || /safety policy/.test(String(notConflicted.error)),
      'the bridge proceeds (the fake denies the ungranted API, which is the point)',
    );
  }),
);

test(
  'a file-layer policy line is a conflict (the text layer is load-bearing)',
  withGatewayEnv({ FAKE_POLICY: '1', FAKE_POLICY_TEXT_ONLY: '1' }, async () => {
    // Round-7 probe: the gateway's list exposes rules in BOTH layers
    // (array = overlay + file-with-scope-permanent, text = raw file).
    // FAKE_POLICY_TEXT_ONLY deliberately reduces the array to overlay-only
    // so this test proves the consumer reads the policy TEXT branch —
    // without the knob, an array-only reader passes too and the test
    // proves nothing. The devkit state home's policy file backs the
    // fake's file layer.
    const policyDir = join(stateHome, '.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp');
    mkdirSync(policyDir, { recursive: true });
    const policyPath = join(policyDir, 'policy');
    writeFileSync(policyPath, 'ECS : CreateServers = allow\n');
    try {
      const execArgs = { product: 'ECS', api: 'CreateServers' };
      const execPlan = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
      const refused = await callTool('huaweicloud_gateway_call', {
        tool: 'execute_api',
        toolArgs: execArgs,
        approvalToken: execPlan.approvalToken,
        approvedByUser: true,
      });
      assert.equal(refused.ok, false, 'the text-only file layer still reads as a conflict');
      assert.match(String(refused.error), /already exists/);
    } finally {
      writeFileSync(policyPath, '');
    }
    // With the file cleared, a fresh approval bridges (the overlay grant
    // authorizes; the file layer contributes nothing).
    const execArgs = { product: 'ECS', api: 'CreateServers' };
    const fresh = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
    const bridging = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: fresh.approvalToken,
      approvedByUser: true,
    });
    assert.equal(bridging.ok, true, JSON.stringify(bridging));
  }),
);

test(
  'a listing failure is its own refusal, not a false conflict',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    // Round-7: the fail-closed branch previously reported "a policy rule
    // already exists" for a dead listing, sending the agent to remove a
    // rule that does not exist. Hide manage_policy from the callable set
    // while keeping it in tools/list (the drift gate only checks the
    // called tool), so the pre-check's listing fails with Unknown tool.
    process.env.FAKE_HIDE_CALLABLE = 'manage_policy';
    try {
      const execArgs = { product: 'ECS', api: 'CreateServers' };
      const execPlan = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
      assert.equal(execPlan.requiresApproval, true);
      const refused = await callTool('huaweicloud_gateway_call', {
        tool: 'execute_api',
        toolArgs: execArgs,
        approvalToken: execPlan.approvalToken,
        approvedByUser: true,
      });
      assert.equal(refused.ok, false, 'a failed listing refuses the bridge');
      assert.match(String(refused.error), /policy listing failed/);
      assert.match(String(refused.error), /Unknown tool|error/i);
      assert.ok(!/already exists/.test(String(refused.error)), 'the failure must not masquerade as a conflict');
    } finally {
      delete process.env.FAKE_HIDE_CALLABLE;
      await _resetOpenMcpSidecar();
    }
  }),
);

test(
  'action spellings bind and forward canonically (ADD does not burn the approval)',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    // Round-7: classify normalized the action but the token bound and the
    // forward carried the RAW spelling — an 'ADD' approval died at the
    // gateway after consume. The mint now normalizes both action and
    // scope; the gateway receives the canonical form.
    const minted = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: ' ADD ', line: 'ECS:ActNorm=allow', scope: ' ONCE ' },
    });
    assert.equal(minted.requiresApproval, true);
    assert.equal(minted.toolArgs.action, 'add', 'the echoed action is normalized');
    assert.equal(minted.toolArgs.scope, 'once');

    const replay = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'ADD', line: 'ECS:ActNorm=allow', scope: 'Once' },
      approvalToken: minted.approvalToken,
      approvedByUser: true,
    });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.received.action, 'add', 'the gateway received the canonical action (asserted on the raw echo)');
    assert.equal(replay.received.scope, 'once', 'the gateway received the canonical scope');
  }),
);

test(
  'an operator deny rule refuses the replay without burning the token',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    const policyPath = join(stateHome, '.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp', 'policy');
    const execArgs = { product: 'ECS', api: 'CreateServers' };
    const plan = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
    assert.equal(plan.requiresApproval, true);
    writeFileSync(policyPath, 'ECS:CreateServers=deny\n');
    try {
      const refused = await callTool('huaweicloud_gateway_call', {
        tool: 'execute_api',
        toolArgs: execArgs,
        approvalToken: plan.approvalToken,
        approvedByUser: true,
      });
      assert.equal(refused.ok, false);
      assert.match(String(refused.error), /operator policy denies this call \(ECS:CreateServers=deny\)/);
    } finally {
      writeFileSync(policyPath, '');
    }
    const bridged = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(bridged.ok, true, JSON.stringify(bridged));
    assert.deepEqual(bridged.executed, { product: 'ECS', api: 'CreateServers' }, 'the token survived the refusal');
  }),
);

test('a live surface without execute_api degrades to deny, not a token demand', async () => {
  const savedPolicy = process.env.FAKE_POLICY;
  const savedHide = process.env.FAKE_HIDE_TOOLS;
  process.env.FAKE_POLICY = '1';
  delete process.env.FAKE_HIDE_TOOLS;
  await _resetOpenMcpSidecar();
  try {
    const execArgs = { product: 'ECS', api: 'CreateServers' };
    const plan = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
    assert.equal(plan.requiresApproval, true, 'with the tool live, the first call mints');

    process.env.FAKE_HIDE_TOOLS = 'execute_api';
    await _resetOpenMcpSidecar();
    const firstCall = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
    assert.equal(firstCall.ok, false);
    assert.equal(firstCall.classification, 'deny');
    assert.equal(firstCall.requiresApproval, undefined, 'drift denies; it does not demand consent');
    assert.match(String(firstCall.error), /drift/);

    const replay = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.classification, 'deny', 'the classify deny fires before the token is consumed');
    assert.match(String(replay.error), /drift/);

    delete process.env.FAKE_HIDE_TOOLS;
    await _resetOpenMcpSidecar();
    const bridged = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(bridged.ok, true, JSON.stringify(bridged));
    assert.deepEqual(
      bridged.executed,
      { product: 'ECS', api: 'CreateServers' },
      'the token survived the drift denials',
    );
  } finally {
    if (savedPolicy === undefined) delete process.env.FAKE_POLICY;
    else process.env.FAKE_POLICY = savedPolicy;
    if (savedHide === undefined) delete process.env.FAKE_HIDE_TOOLS;
    else process.env.FAKE_HIDE_TOOLS = savedHide;
    await _resetOpenMcpSidecar();
  }
});

test(
  'native mode delegates execute_api to the gateway policy engine',
  withGatewayEnv({ FAKE_POLICY: '1', HUAWEICLOUD_OPENMCP_APPROVAL: 'native' }, async () => {
    const result = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: { product: 'ECS', api: 'CreateServers' },
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.requiresApproval, undefined, 'native mode never mints');
    assert.match(String(result.error), /safety policy/);
    assert.equal(result.reason, String(result.error), 'the gateway denial envelope is preserved verbatim');
  }),
);

test(
  'a CLI-trimmed configuration keeps gateway writes behind the token gate',
  withGatewayEnv({ FAKE_POLICY: '1' }, () =>
    withDevkitPacks('core,huaweicloud-open-mcp', async () => {
      const result = await callTool('huaweicloud_gateway_call', {
        tool: 'transform_data',
        toolArgs: { sql: 'select 1' },
      });
      assert.equal(result.ok, false);
      assert.equal(result.requiresApproval, true, 'the write path exists only through the approval token');
    })(),
  ),
);

test('the surface cache follows the sidecar lifecycle', async () => {
  await _resetOpenMcpSidecar();
  try {
    assert.equal(_gatewaySurface(), null, 'no spawn yet: unknown surface');
    await callTool('huaweicloud_search_apis', { query: 'surface' });
    const surface = _gatewaySurface();
    assert.ok(surface, 'a successful spawn populates the cache');
    assert.ok(surface.has('search_apis'));
    assert.ok(surface.has('failing_tool'), "the cache mirrors the child's full tools/list, not the devkit projection");
  } finally {
    await _resetOpenMcpSidecar();
    assert.equal(_gatewaySurface(), null, 'reset clears the cache with the singleton');
  }
});

test(
  'gateway_list_tools writes through to the surface cache the classifier reads',
  withGatewayEnv({ FAKE_FAIL_LIST_ONCE: '1' }, async () => {
    // The spawn's own tools/list fails (advisory: the cache stays null and
    // calls still work); the drift report's successful list is then the
    // ONLY thing that can arm the classifier's cache.
    const passthrough = await callTool('huaweicloud_gateway_call', {
      tool: 'search_apis',
      toolArgs: { query: 'write-through' },
    });
    assert.equal(passthrough.ok, true, JSON.stringify(passthrough));
    assert.equal(_gatewaySurface(), null, 'the failed spawn-time list leaves the cache unknown');

    const report = await callTool('huaweicloud_gateway_list_tools', {});
    assert.equal(report.ok, true, JSON.stringify(report));
    const surface = _gatewaySurface();
    assert.ok(surface, 'the report populated the cache');
    assert.ok(surface.has('search_apis'), 'with the real names');
    assert.ok(!surface.has('execute_api'), 'and without the policy tools the default fake hides');
  }),
);

test('resolveGatewaySpawnArgs rejects relative operator policy/audit paths', () => {
  for (const key of ['HUAWEICLOUD_MCP_POLICY_FILE', 'HUAWEICLOUD_MCP_AUDIT_FILE']) {
    assert.throws(
      () => resolveGatewaySpawnArgs({ HOME: '/h', [key]: 'relative/policy' }),
      new RegExp(`${key} must be an absolute path`),
      `${key} relative is refused`,
    );
  }
  // Absolute values pass validation (the policy one still drives pin-unless-env).
  const plan = resolveGatewaySpawnArgs({ HOME: '/h', HUAWEICLOUD_MCP_POLICY_FILE: '/opt/gw-policy' });
  assert.ok(!plan.args.includes('--policy'));
});

test(
  'gateway_call rejects non-object toolArgs explicitly instead of coercing',
  withGatewayEnv({}, async () => {
    for (const bad of ['a string', 42, ['array'], null]) {
      const result = await callTool('huaweicloud_gateway_call', { tool: 'search_apis', toolArgs: bad });
      assert.equal(result.ok, false);
      assert.match(String(result.error), /toolArgs must be an object/);
    }
    // undefined behaves as an empty object (the MCP optional-field case).
    const fine = await callTool('huaweicloud_gateway_call', { tool: 'list_products' });
    assert.equal(fine.ok, true, JSON.stringify(fine));
  }),
);

test('error envelopes cross the normalization boundary redacted', async () => {
  // failing_tool echoes its arguments as key=value text inside an
  // isError:true envelope — the shape validation failures take when they
  // echo the offending input. The secret must not survive the boundary.
  const result = await callOpenMcpTool('failing_tool', { adminPass: 'Secret123', note: 'plain' });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /adminPass=<redacted>/);
  assert.ok(!String(result.error).includes('Secret123'), 'the plaintext secret never crosses');
  assert.match(String(result.error), /note=plain/, 'non-secret content survives verbatim');
});

test('JSON-shaped error envelopes redact through the object walk', async () => {
  // json_error_tool echoes its arguments as JSON inside isError:true —
  // the strongest redaction shape, since the text parses and the key-name
  // walk applies instead of the string patterns.
  const result = await callOpenMcpTool('json_error_tool', { adminPass: 'Secret123', note: 'plain' });
  assert.equal(result.ok, false);
  const errorText = String(result.error);
  assert.match(errorText, /"adminPass":\s*"<redacted>"/);
  assert.ok(!errorText.includes('Secret123'), 'the plaintext secret never crosses in JSON form either');
  assert.match(errorText, /"note":\s*"plain"/, 'non-secret keys survive the walk');
});

test(
  'a doubly-refused bridge leaves no residue grant behind',
  withGatewayEnv({ FAKE_POLICY: '1', FAKE_REFUSE_EXECUTE: '1' }, async () => {
    const execArgs = { product: 'ECS', api: 'CreateServers' };
    const plan = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
    assert.equal(plan.requiresApproval, true);
    const refused = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(refused.ok, false);
    // attempt 2 is the retry evidence: a no-retry bridge would surface
    // attempt 1 and leave identical residue state.
    assert.match(String(refused.error), /safety policy/, 'the refusal surfaces, not a hang or a loop');
    assert.match(String(refused.error), /attempt 2/, 'the refusal surfaced is the SECOND forward');

    // The bridge added its once-grant, was refused, re-added under the
    // retry, was refused again — the finally must remove BOTH adds or a
    // standing authorization for exactly this product:api survives.
    const listing = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'list' },
    });
    assert.equal(listing.ok, true, JSON.stringify(listing));
    assert.ok(
      !listing.rules.some((rule) => rule.line === 'ECS:CreateServers=allow'),
      'no residue grant may survive a refused bridge',
    );
  }),
);

test(
  'a non-refusal failure is never re-sent: one approval, one forward',
  withGatewayEnv({ FAKE_POLICY: '1', FAKE_BROKEN_EXECUTE: '1' }, async () => {
    const execArgs = { product: 'ECS', api: 'CreateServers' };
    const plan = await callTool('huaweicloud_gateway_call', { tool: 'execute_api', toolArgs: execArgs });
    assert.equal(plan.requiresApproval, true);
    const broken = await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(broken.ok, false);
    assert.match(String(broken.error), /gateway exploded/);
    assert.match(String(broken.error), /attempt 1/, 'unknown execution state must not be re-sent');
  }),
);

test(
  'the token binds the normalized scope; either spelling replays successfully',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    // ' ONCE ' passes classify (normalized) — the mint echo and the token
    // must both carry 'once' (round-5: the gateway stored a spelling its
    // burn semantics never matched). Round-6: the replay normalizes too,
    // so following the note ("your ORIGINAL unredacted toolArgs") cannot
    // waste the approval on a spelling mismatch.
    const minted = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'add', line: 'ECS:NormScope=allow', scope: ' ONCE ' },
    });
    assert.equal(minted.requiresApproval, true);
    assert.equal(minted.toolArgs.scope, 'once', 'the echoed scope is the normalized form');

    const replayRaw = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'add', line: 'ECS:NormScope=allow', scope: ' ONCE ' },
      approvalToken: minted.approvalToken,
      approvedByUser: true,
    });
    assert.equal(replayRaw.ok, true, JSON.stringify(replayRaw));
    assert.equal(replayRaw.scope, 'once', 'the raw spelling replays; the gateway receives the canonical form');

    const mintedMixed = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'add', line: 'ECS:NormScope2=allow', scope: 'Once' },
    });
    const replayMixed = await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'add', line: 'ECS:NormScope2=allow', scope: 'ONCE' },
      approvalToken: mintedMixed.approvalToken,
      approvedByUser: true,
    });
    assert.equal(replayMixed.ok, true, 'any classify-accepted spelling hashes to the same normalized bound form');
    assert.equal(replayMixed.scope, 'once');
  }),
);
