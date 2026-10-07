import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { createDevkitMcpServer, createLinkedDevkitServers } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';
import {
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
      assert.equal(names.length, 17, 'core-only tools/list');
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

test('pack meta discloses the huaweicloud-open-mcp pack with its six proxy tools', async () => {
  const info = await callTool('huaweicloud_pack_info', { pack: 'huaweicloud-open-mcp' });
  assert.equal(info.ok, true);
  assert.equal(info.enabled, true);
  assert.equal(info.tools.length, 6);
  for (const entry of info.tools) {
    assert.ok(OPEN_MCP_TOOLS.has(entry.name), `${entry.name} must be one of the six proxy tools`);
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
    const { callOpenMcpTool } = await import('../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/sidecar.ts');
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
