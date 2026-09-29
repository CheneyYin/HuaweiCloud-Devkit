import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'plugins', 'huaweicloud-core', 'dist');
const distServer = join(distDir, 'mcp-server.js');

test('dist bundle answers framed tools/list with clean stdout', () => {
  assert.ok(existsSync(distServer), 'dist bundle missing — run npm run build');
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const framed = `Content-Length: ${Buffer.byteLength(request, 'utf8')}\r\n\r\n${request}`;
  const run = spawnSync(process.execPath, [distServer], { input: framed, encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, `bundle exited ${run.status}: ${run.stderr}`);
  assert.match(run.stdout, /"result"/, 'no JSON-RPC result in stdout');
  assert.match(run.stdout, /huaweicloud_/, 'no huaweicloud_ tools in response');
  assert.doesNotMatch(run.stdout, /listening on/, 'bundle stdout polluted with non-protocol output');
});

test('dist bundle inlines server modules and ships a sourcemap', () => {
  const bundle = readFileSync(distServer, 'utf8');
  assert.doesNotMatch(bundle, /import\s+[^;]+from\s+['"]\.\//, 'relative import left unbundled');
  assert.doesNotMatch(bundle, /import\(\s*['"]\.\//, 'relative dynamic import left unbundled');
  assert.ok(existsSync(`${distServer}.map`), 'bundle sourcemap missing');
  assert.ok(!existsSync(join(distDir, 'mcp-server-remote.js')), 'remote entry must ship only inside the bundle');
});

test('dist bundle serves --transport remote', async () => {
  const child = spawn(process.execPath, [distServer, '--transport', 'remote', '--port', '0'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const address = await new Promise<{ host: string; port: number }>((resolvePromise, rejectPromise) => {
      let out = '';
      const timer = setTimeout(
        () => rejectPromise(new Error(`remote bundle never reported listening: ${out}`)),
        10_000,
      );
      child.stdout.on('data', (chunk) => {
        out += chunk.toString();
        const match = out.match(/listening on ([0-9.]+):(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolvePromise({ host: match[1], port: Number(match[2]) });
        }
      });
      child.once('error', rejectPromise);
    });
    const res = await fetch(`http://${address.host}:${address.port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'dist-bundle-test', version: '0.0.0' },
        },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.serverInfo.name, 'huaweicloud-devkit');
  } finally {
    child.kill();
  }
});
