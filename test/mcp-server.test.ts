import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

// Never let the spawned stdio server kick off a REAL background KooCLI
// install from inside a test run (cold-cache boxes would download).
process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverPath = join(root, 'plugins', 'huaweicloud-core', 'src', 'mcp-server.ts');

// The version-layout fixtures below copy the generated skills tree (the
// server fail-fasts without it), so the whole file needs it present. One
// guided precondition instead of a raw ENOENT on a fresh checkout.
assert.ok(
  existsSync(join(root, 'plugins', 'huaweicloud-core', 'skills')),
  'generated skills tree missing — run: npm run build',
);

interface ToolDescriptor {
  name: string;
  inputSchema: { properties: Record<string, unknown> };
}

interface JsonRpcResult {
  serverInfo: { name: string; version: string };
  instructions?: string;
  tools: ToolDescriptor[];
  isError: boolean;
  content: { text: string }[];
}

interface JsonRpcResponse {
  id: number | string | null;
  result: JsonRpcResult;
  error: { code: number; message: string };
}

function frame(message: unknown) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function createClient(server = serverPath, envOverrides: Record<string, string | undefined> = {}) {
  // Hermetic boot base: without these, every spawned server's initialize
  // handshake awaits a REAL hdkitGenerateUserHash fetch (3s race against
  // devkit.huaweicloud.com) and fires telemetry POSTs — a real-network
  // latency spike under full-suite load delayed initialize past the
  // split-frame test's 2s deadline (the 2026-10-16 flake). Port 1 on
  // localhost refuses in milliseconds; the hash prewarm is best-effort.
  // envOverrides: undefined deletes the key (the telemetry-ON wiring pin
  // uses that to re-enable the stamp-writing path while keeping the
  // endpoint pinned to the closed port).
  const env: Record<string, string> = {
    ...process.env,
    HDKITSERVICE_ENDPOINT: 'http://127.0.0.1:1/',
    HUAWEICLOUD_DEVKIT_TELEMETRY: 'off',
    HUAWEICLOUD_DEVKIT_SKIP_UPDATE: '1',
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn(process.execPath, [server], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  let buffer = Buffer.alloc(0);
  const pending = new Map<number | string | null, (payload: JsonRpcResponse) => void>();
  const frames: JsonRpcResponse[] = [];

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) throw new Error(`Missing Content-Length header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;
      const payload: JsonRpcResponse = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8'));
      buffer = buffer.subarray(bodyEnd);
      frames.push(payload);
      pending.get(payload.id)?.(payload);
    }
  });

  return {
    raw(data: string) {
      child.stdin.write(data);
    },
    frames() {
      return frames;
    },
    isAlive() {
      return child.exitCode === null;
    },
    request(method: string, params: Record<string, unknown> = {}) {
      const id = Math.floor(Math.random() * 1_000_000);
      child.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
      // The server cold-boots through type stripping (~1.5s observed) plus
      // tool registration; 10s leaves real margin for loaded CI runners
      // (2s produced load-dependent initialize timeouts).
      return new Promise<JsonRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 10_000);
        pending.set(id, (payload) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(payload);
        });
      });
    },
    requestInChunks(method: string, params: Record<string, unknown> = {}, bodyBytesInFirstChunk: number = 1) {
      const id = Math.floor(Math.random() * 1_000_000);
      const payload = frame({ jsonrpc: '2.0', id, method, params });
      const bodyStart = payload.indexOf('\r\n\r\n') + 4;
      const splitAt = bodyStart + bodyBytesInFirstChunk;
      const first = payload.slice(0, splitAt);
      const second = payload.slice(splitAt);
      child.stdin.write(first);
      setTimeout(() => child.stdin.write(second), 50);
      return new Promise<JsonRpcResponse>((resolve, reject) => {
        // Same cold-boot cost the request() helper documents: 2s produced
        // load-dependent timeouts here too once the tool registry grew.
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for split ${method}`)), 10_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
      });
    },
    close() {
      child.kill();
    },
  };
}

test('MCP server initializes, lists tools, and plans CLI commands', async () => {
  const client = createClient();
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    assert.equal(initialized.result.serverInfo.name, 'huaweicloud-devkit');
    // The stdio instruction form states the tree's location outright (no
    // catalog detour), keeps the enablement caveat ahead of the read
    // invitation (a path never implies "on disk == usable"), and names the
    // session-toggle tool this face actually registers. The path is
    // runtime-resolved, so pin it against the generated tree this file
    // already requires — same "must locate the catalogued tree" pin
    // pack-meta-tools holds for the list_skills payload.
    const instructions = initialized.result.instructions ?? '';
    assert.match(instructions, /the skills tree lives at /, 'stdio instructions must state the tree location');
    const marker = 'the skills tree lives at ';
    const suffix = ' (stdio session)';
    const at = instructions.indexOf(marker);
    const end = instructions.indexOf(suffix, at + marker.length);
    const stated = at >= 0 && end > at + marker.length ? instructions.slice(at + marker.length, end) : undefined;
    assert.ok(stated && isAbsolute(stated), 'the stated tree location must be an absolute path');
    assert.ok(
      existsSync(join(stated!, 'huawei-vpc', 'SKILL.md')),
      'the stated tree location must locate the catalogued tree',
    );
    assert.match(instructions, /pack-gated/, 'stdio instructions must carry the enablement caveat');
    assert.match(instructions, /huaweicloud_packs_configure/, 'stdio instructions must name the session-toggle tool');
    assert.match(
      instructions,
      /To load a skill, attempt the direct read first/,
      'stdio instructions must lead the load procedure with the attempt-first imperative',
    );
    assert.doesNotMatch(
      instructions,
      /When your file tools reach the tree/,
      'stdio instructions must not carry the evaluative reachability conditional',
    );
    assert.match(
      instructions,
      /If a direct read of the tree fails or is denied, load the skill with huaweicloud_retrieve_skill instead/,
      'stdio instructions must teach the reactive fallback sentence',
    );

    const listed = await client.request('tools/list');
    const toolNames = new Set(listed.result.tools.map((tool) => tool.name));
    assert.ok(toolNames.has('huaweicloud_plan_cli_command'));
    assert.ok(toolNames.has('huaweicloud_list_operations'));
    assert.ok(toolNames.has('huaweicloud_run_approved_command'));
    assert.ok(toolNames.has('huaweicloud_show_profile_redacted'));
    assert.ok(toolNames.has('huaweicloud_auth_status'));
    assert.ok(toolNames.has('huaweicloud_auth_sync'));
    assert.ok(toolNames.has('huaweicloud_sandbox_check_user'));
    assert.ok(toolNames.has('huaweicloud_sandbox_connect'));

    const runReadonly = listed.result.tools.find((tool) => tool.name === 'huaweicloud_run_readonly_command');
    assert.ok(Object.hasOwn(runReadonly!.inputSchema.properties, 'timeoutMs'));

    const planned = await client.request('tools/call', {
      name: 'huaweicloud_plan_cli_command',
      arguments: { args: ['ECS', 'NovaListServers'] },
    });
    assert.equal(planned.result.isError, false);
    assert.match(planned.result.content[0].text, /NovaListServers/);
  } finally {
    client.close();
  }
});

test('MCP server returns JSON-RPC -32601 for unknown methods (#650 D9-2)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const response = await client.request('tools/unknown_xyz');
    assert.ok(response.error, 'expected an error response');
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /Method not found/);
  } finally {
    client.close();
  }
});

test('MCP server returns -32700 and keeps serving after a malformed frame (#643)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    client.raw('Content-Length: 5\r\n\r\n{bad!');

    // Same budget class as request()/requestInChunks above: the server
    // cold-boots through type stripping and under machine load a 3s poll
    // deadline produced load-dependent flakes in full-suite runs.
    const deadline = Date.now() + 10_000;
    let parseError;
    while (Date.now() < deadline) {
      parseError = client.frames().find((p) => p.error && p.error.code === -32700);
      if (parseError) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(parseError, 'expected a -32700 Parse error frame');
    assert.equal(parseError.error.code, -32700);
    assert.equal(parseError.id, null, 'parse error has null id');

    const listed = await client.request('tools/list');
    assert.ok(Array.isArray(listed.result.tools), 'server still serves valid requests after a parse error');
    assert.equal(client.isAlive(), true, 'malformed frame must not kill the process');
  } finally {
    client.close();
  }
});

test('MCP server returns -32700 for a malformed newline-delimited frame (#643)', async () => {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  try {
    child.stdin.write('{bad!\n');
    // Same budget class as request()/requestInChunks above: the server
    // cold-boots through type stripping and under machine load a 3s poll
    // deadline produced load-dependent flakes in full-suite runs.
    const deadline = Date.now() + 10_000;
    let line = '';
    while (Date.now() < deadline) {
      line = out.split('\n').find((l) => l.includes('-32700')) || '';
      if (line) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(line, 'expected a newline-delimited -32700 frame');
    const payload = JSON.parse(line);
    assert.equal(payload.error.code, -32700);
    assert.equal(payload.id, null);
    assert.equal(child.exitCode, null, 'malformed newline frame must not kill the process');
  } finally {
    child.kill();
  }
});

test('MCP server returns isError tool results for tools/call missing required params (#704, SDK semantics)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    // Since the SDK migration, validation failures are isError CallToolResults
    // (the SDK high-level server wraps McpError InvalidParams), not JSON-RPC
    // -32602 error responses. The migration decision is recorded in the SDK
    // migration plan; this pins the new contract.
    const single = await client.request('tools/call', { name: 'huaweicloud_plan_cli_command', arguments: {} });
    assert.ok(single.result, 'missing required param must return a tool result');
    assert.equal(single.result.isError, true, 'missing required param must set isError');
    assert.match(single.result.content[0].text, /args/);

    const multi = await client.request('tools/call', { name: 'huaweicloud_run_approved_command', arguments: {} });
    assert.ok(multi.result, 'missing required params must return a tool result');
    assert.equal(multi.result.isError, true, 'missing required params must set isError');
    const text = multi.result.content.map((c) => c.text || '').join(' ');
    assert.match(text, /args/);
    assert.match(text, /approvalToken/);
    assert.match(text, /approvedByUser/);
  } finally {
    client.close();
  }
});

test('MCP server returns isError tool results for tools/call with unknown tool name (#704, SDK semantics)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const response = await client.request('tools/call', { name: 'huaweicloud_nonexistent', arguments: {} });
    assert.ok(response.result, 'unknown tool must return a tool result');
    assert.equal(response.result.isError, true, 'unknown tool must set isError');
    assert.match(response.result.content[0].text, /not found/);
  } finally {
    client.close();
  }
});

test('MCP server does not require params for tools without required fields (#704)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    // explain_error has no required fields and must still return a result.
    const response = await client.request('tools/call', { name: 'huaweicloud_explain_error', arguments: {} });
    assert.ok(response.result, 'expected a result, not an error');
    assert.equal(response.result.isError, false);
  } finally {
    client.close();
  }
});

test('MCP server reports version from plugin package.json in installed layout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-version-'));
  try {
    const pluginRoot = join(dir, 'huaweicloud-plugins');
    cpSync(join(root, 'plugins', 'huaweicloud-core', 'dist'), join(pluginRoot, 'dist'), { recursive: true });
    cpSync(join(root, 'plugins', 'huaweicloud-core', 'safety'), join(pluginRoot, 'safety'), { recursive: true });
    // The server fail-fasts on a missing skills tree (verifySkillTree), so
    // a bootable fixture models the full payload a real install ships.
    cpSync(join(root, 'plugins', 'huaweicloud-core', 'skills'), join(pluginRoot, 'skills'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'package.json'),
      JSON.stringify({ name: 'huaweicloud-plugins', version: '9.9.9-test' }),
    );
    const client = createClient(join(pluginRoot, 'dist', 'mcp-server.js'));
    try {
      const initialized = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.0' },
      });
      assert.equal(initialized.result.serverInfo.version, '9.9.9-test');
    } finally {
      client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The codex marketplace cache layout the codex-side tests boot from:
// <dir>/<marketplace>/<plugin>/<version>/ carrying the full payload a real
// install ships. Codex marketplace installs are plain file copies with no
// package.json anywhere in the version-resolution candidate paths (issue
// #576) — the version must come from the plugin manifest, so the fixture
// writes it there. The server fail-fasts on a missing skills tree
// (verifySkillTree), so a bootable fixture models the full payload.
function makeCodexCacheLayout(dir: string, version: string): { marketplace: string; versionDir: string } {
  const marketplace = join(dir, 'huaweicloud-devkit', 'huaweicloud-devkit');
  const versionDir = join(marketplace, version);
  mkdirSync(versionDir, { recursive: true });
  cpSync(join(root, 'plugins', 'huaweicloud-core', 'dist'), join(versionDir, 'dist'), { recursive: true });
  cpSync(join(root, 'plugins', 'huaweicloud-core', 'safety'), join(versionDir, 'safety'), { recursive: true });
  cpSync(join(root, 'plugins', 'huaweicloud-core', 'skills'), join(versionDir, 'skills'), { recursive: true });
  mkdirSync(join(versionDir, '.codex-plugin'), { recursive: true });
  writeFileSync(
    join(versionDir, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'huaweicloud-devkit', version }),
  );
  return { marketplace, versionDir };
}

test('MCP server reports version from plugin manifest in Codex cache layout (#576)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-codex-'));
  try {
    const { versionDir: codexRoot } = makeCodexCacheLayout(dir, '1.1.5-codex');
    const client = createClient(join(codexRoot, 'dist', 'mcp-server.js'));
    try {
      const initialized = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex', version: '0.153.4' },
      });
      assert.equal(initialized.result.serverInfo.version, '1.1.5-codex');
    } finally {
      client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('telemetry ON in Codex cache layout: stamps land inside the version dir, never the parent (bundle wiring)', async () => {
  // The wiring pin for the telemetry-sibling incident: the bug was never in
  // resolvePluginDir's join logic (telemetry-plugin-dir.test.ts pins that
  // pure function) — it was WHICH startDir the esbuild bundle implicitly
  // passes (import.meta.url flattened to dist/mcp-server.js, __dirname =
  // dist/). Only booting the real built bundle in the codex-cache layout
  // executes that wiring. The #576 test above boots the same layout but
  // pins telemetry off — which is exactly why the sibling writes stayed
  // invisible to the suite while the bug shipped. Here telemetry is ON
  // (the stamp-writing path), the endpoint stays pinned to the closed port
  // (hermetic), and the global telemetry root is redirected into the
  // fixture so nothing touches the real home.
  const dir = mkdtempSync(join(tmpdir(), 'hwc-codex-tel-'));
  try {
    const { marketplace, versionDir: codexRoot } = makeCodexCacheLayout(dir, '2.0.0-test');
    const client = createClient(join(codexRoot, 'dist', 'mcp-server.js'), {
      HUAWEICLOUD_DEVKIT_TELEMETRY: undefined,
      HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/',
      HUAWEICLOUD_DEVKIT_HOME: join(dir, 'devkit-home'),
    });
    try {
      const initialized = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex', version: '0.162.1' },
      });
      assert.equal(initialized.result.serverInfo.version, '2.0.0-test');
    } finally {
      client.close();
    }
    // The incident assertion pair: the telemetry dir (initTelemetry ->
    // trackInstall writes install-counter) must exist INSIDE the version
    // dir, and the version PARENT — the directory codex scans for version
    // dirs — must carry no 'telemetry' sibling. A depth regression in the
    // bundle flips exactly this pair.
    assert.ok(existsSync(join(codexRoot, 'telemetry')), 'telemetry dir must land inside the version dir');
    assert.ok(
      existsSync(join(codexRoot, 'telemetry', 'install-counter')),
      'initTelemetry must have written its install counter inside the version dir',
    );
    assert.ok(
      !existsSync(join(marketplace, 'telemetry')),
      'no telemetry sibling in the version parent — codex resolves that stray as the plugin version and stops loading the plugin',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP server waits for incomplete Content-Length frames instead of spinning', async () => {
  const client = createClient();
  try {
    const payload = {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'split-client', version: '0.0.0' },
    };

    const initialized = await client.requestInChunks('initialize', payload, 8);

    assert.equal(initialized.result.serverInfo.name, 'huaweicloud-devkit');
  } finally {
    client.close();
  }
});

test('MCP server returns -32600 for valid JSON that is not a request object', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    client.raw(frame('a bare json string'));
    client.raw(frame(null));
    client.raw(frame([1, 2, 3]));

    // Same budget class as request()/requestInChunks above: the server
    // cold-boots through type stripping and under machine load a 3s poll
    // deadline produced load-dependent flakes in full-suite runs.
    const deadline = Date.now() + 10_000;
    let invalidRequest;
    while (Date.now() < deadline) {
      invalidRequest = client.frames().find((p) => p.error && p.error.code === -32600);
      if (invalidRequest) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(invalidRequest, 'expected a -32600 Invalid Request frame');
    assert.equal(invalidRequest.id, null);
    assert.equal(client.isAlive(), true, 'non-object JSON must not kill the process');

    // An id-bearing message with no method must also get a visible reply,
    // not silence (the SDK would drop it and the client would hang). The
    // reply echoes the request id so the failure is correlatable.
    client.raw(frame({ jsonrpc: '2.0', id: 42 }));
    const deadline2 = Date.now() + 10_000;
    let methodNotFound;
    while (Date.now() < deadline2) {
      methodNotFound = client.frames().find((p) => p.error && p.error.code === -32601);
      if (methodNotFound) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(methodNotFound, 'expected a -32601 for an id-bearing no-method message');
    assert.equal(methodNotFound.id, 42, 'the -32601 reply must echo the request id');
  } finally {
    client.close();
  }
});

test('MCP server waits for a frame header split across chunks', async () => {
  const client = createClient();
  try {
    // Split inside the "Content-Length" token itself: the first chunk is a
    // partial header prefix, the second carries the rest of the header plus
    // the body. Consuming the prefix as a JSON line would emit a spurious
    // -32700 and permanently desync framing.
    const payload = {
      jsonrpc: '2.0',
      id: 77,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'header-split-client', version: '0.0.0' },
      },
    };
    const framed = frame(payload);
    const splitAt = 'Content-Len'.length;
    client.raw(framed.slice(0, splitAt));
    setTimeout(() => client.raw(framed.slice(splitAt)), 50);

    // Same budget class as request()/requestInChunks above: the server
    // cold-boots through type stripping and under machine load a 3s poll
    // deadline produced load-dependent flakes in full-suite runs.
    const deadline = Date.now() + 10_000;
    let response;
    while (Date.now() < deadline) {
      response = client.frames().find((p) => p.id === 77);
      if (response) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(response, 'expected the initialize response after the split header arrived');
    assert.equal(response.result.serverInfo.name, 'huaweicloud-devkit');
    assert.ok(
      !client.frames().some((p) => p.error && p.error.code === -32700),
      'a split header must not produce a parse error',
    );
  } finally {
    client.close();
  }
});

test('tools/call accepts string numerics and passes unknown keys through (#530 leniency)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    // timeoutMs as a string must reach normalizeNumericArgs, which owns the
    // accept/reject decision — the zod boundary declares the leniency. A bad
    // string is still rejected by the tool itself with its #530 message.
    const ok = await client.request('tools/call', {
      name: 'huaweicloud_list_operations',
      arguments: { service: 'ECS', timeoutMs: '9999', unknownExtra: 'kept' },
    });
    assert.ok(ok.result, `expected a result: ${JSON.stringify(ok).slice(0, 300)}`);

    const bad = await client.request('tools/call', {
      name: 'huaweicloud_list_operations',
      arguments: { service: 'ECS', timeoutMs: 'not-a-number' },
    });
    assert.ok(bad.result, 'bad numeric string must produce a tool result');
    assert.equal(bad.result.isError, true, 'normalizeNumericArgs still rejects garbage strings');
    assert.match(bad.result.content[0].text, /timeoutMs/);

    // Unknown keys survive the passthrough boundary and reach callTool: the
    // plan tool echoes the full command back.
    const planned = await client.request('tools/call', {
      name: 'huaweicloud_plan_cli_command',
      arguments: { args: ['ECS', 'NovaListServers'], unknownExtra: 'kept' },
    });
    assert.ok(planned.result, `expected a plan result: ${JSON.stringify(planned).slice(0, 300)}`);
    assert.equal(planned.result.isError, false);
    assert.match(planned.result.content[0].text, /NovaListServers/);
  } finally {
    client.close();
  }
});

test('tools/call works with arguments omitted entirely', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const response = await client.request('tools/call', {
      name: 'huaweicloud_list_regions',
    });
    assert.ok(response.result, 'omitted arguments must not fail validation');
    assert.equal(response.result.isError, false);
  } finally {
    client.close();
  }
});

test('ping is auto-answered by the SDK protocol layer', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const response = await client.request('ping', {});
    assert.ok(response.result !== undefined, 'ping must return a result');
  } finally {
    client.close();
  }
});
