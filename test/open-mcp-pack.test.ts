import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { createDevkitMcpServer, createLinkedDevkitServers } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';
import {
  callOpenMcpTool,
  resolveGatewayCommand,
  _openMcpSidecarStats,
  _resetOpenMcpSidecar,
} from '../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/sidecar.ts';

// The five huaweicloud-open-mcp pack lifecycle invariants from the pack-system decision
// record, driven through the real dispatch surfaces with a fake gateway
// (test/fixtures/fake-open-mcp-sidecar.mjs). The Node suite never depends on
// Python or uv: OPENMCP_BIN points every spawn at the fixture.

const root = fileURLToPath(new URL('..', import.meta.url));
const fakeSidecar = join(root, 'test', 'fixtures', 'fake-open-mcp-sidecar.mjs');
process.env.OPENMCP_BIN = fakeSidecar;

const OPEN_MCP_TOOLS = new Set([
  'huaweicloud_search_apis',
  'huaweicloud_list_products',
  'huaweicloud_get_product',
  'huaweicloud_list_apis',
  'huaweicloud_get_api',
  'huaweicloud_get_api_examples',
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

test('pack meta discloses the huaweicloud-open-mcp pack with its six proxy tools and the restart tool', async () => {
  const info = await callTool('huaweicloud_pack_info', { pack: 'huaweicloud-open-mcp' });
  assert.equal(info.ok, true);
  assert.equal(info.enabled, true);
  assert.equal(info.tools.length, 7);
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
