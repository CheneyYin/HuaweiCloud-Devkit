// The shared client harness for the MCP-server wire tests, extracted
// from mcp-server.test.ts: the env seams, the framing codec, and the spawned
// stdio client. Both wire-test files import it, so every spawned server
// process sees the same hermetic env.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern) so cold-attested calls in this file dispatch without the
// challenge bounce. The challenge itself is pinned where it is the subject
// (tools.test.ts's gate test drives the dance; the selfcheck drives it on
// the wire); the real-model e2e tier never sets this seam.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

// Never let the spawned stdio server kick off a REAL background KooCLI
// install from inside a test run (cold-cache boxes would download).
process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const serverPath = join(root, 'plugins', 'huaweicloud-core', 'src', 'mcp-server.ts');

// The version-layout fixtures below copy the generated skills tree (the
// server fail-fasts without it), so the whole file needs it present. One
// guided precondition instead of a raw ENOENT on a fresh checkout.
assert.ok(
  existsSync(join(root, 'plugins', 'huaweicloud-core', 'skills')),
  'generated skills tree missing — run: npm run build',
);

export interface ToolDescriptor {
  name: string;
  inputSchema: { properties: Record<string, unknown> };
}

export interface JsonRpcResult {
  serverInfo: { name: string; version: string };
  instructions?: string;
  tools: ToolDescriptor[];
  isError: boolean;
  content: { text: string }[];
}

export interface JsonRpcResponse {
  id: number | string | null;
  result: JsonRpcResult;
  error: { code: number; message: string };
}

export function frame(message: unknown) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

export function createClient(server = serverPath, envOverrides: Record<string, string | undefined> = {}) {
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
