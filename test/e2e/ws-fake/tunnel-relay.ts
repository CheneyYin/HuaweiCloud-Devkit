// The tunnel-session half of the hwlink fake: sub-connections multiplexed
// over one ws connection (identifier-keyed), carrying HTTP-over-stream for
// the in-fake file server (the sandbox-file-server.py stand-in). /health
// answers raw 200 OK; /upload lands the archive in the fake fs and answers
// the JSON the product consumes (bytes + md5 over the RECEIVED bytes — a
// corruption anywhere in the tunnel chain mismatches the product's local
// hash and it throws). Tunnel relay with a bounded surface: only ports the
// fake shell has "listened" on (a start-fileserver intent) are connectable
// — dstPort is agent-influenced input, and an unbounded relay would connect
// the fake to arbitrary local ports (an SSRF-shaped hole inside the
// harness).
import { createHash } from 'node:crypto';

import {
  OpCode,
  createPacket,
  type HwlinkPacket,
} from '../../../plugins/huaweicloud-core/src/ws-exec/hwlink-packet.ts';
import type { FakeFs } from './fake-shell.ts';
import type { ConnState } from './hwlink-server.ts';

export interface ParsedHttp {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer | null;
  consumed: number;
}

// Minimal HTTP request parser over the tunnel byte stream: complete
// head + (Content-Length) body or nothing (partial stays buffered).
function tryParseHttp(buffer: Buffer): ParsedHttp | null {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const head = buffer.subarray(0, headerEnd).toString('utf8');
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const [method, path] = requestLine.split(' ');
  if (!method || !path) return null;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const contentLength = Number(headers['content-length'] ?? '0');
  const total = headerEnd + 4 + contentLength;
  if (buffer.length < total) return null;
  return {
    method,
    path,
    headers,
    body: contentLength > 0 ? Buffer.from(buffer.subarray(headerEnd + 4, total)) : null,
    consumed: total,
  };
}

function sendRaw(state: ConnState, frame: Uint8Array): void {
  state.socket.send(Buffer.from(frame));
}

function answerFileServer(fs: FakeFs, state: ConnState, request: ParsedHttp): Buffer {
  if (request.method === 'GET' && request.path === '/health') {
    state.recording.commands.push({ intent: 'tunnel:health', exitCode: 0 });
    return Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
  }
  if (request.method === 'POST' && request.path === '/upload') {
    state.recording.commands.push({ intent: 'tunnel:upload', exitCode: 0 });
    const targetPath = request.headers['x-target-path'] ?? '/tmp/upload.bin';
    const body = request.body ?? Buffer.alloc(0);
    fs.write(targetPath, body);
    const md5 = createHash('md5').update(body).digest('hex');
    const json = JSON.stringify({ ok: true, path: targetPath, bytes: body.length, md5 });
    return Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${json.length}\r\n\r\n`),
      Buffer.from(json),
    ]);
  }
  const notFound = JSON.stringify({ ok: false, error: 'not found' });
  return Buffer.concat([
    Buffer.from(`HTTP/1.1 404 Not Found\r\nContent-Length: ${notFound.length}\r\n\r\n`),
    Buffer.from(notFound),
  ]);
}

export function handleTunnelCreate(fs: FakeFs, state: ConnState, packet: HwlinkPacket): void {
  if (!fs.servicePorts.has(packet.dstPort)) {
    sendRaw(
      state,
      createPacket({
        operation: 0x0e << 24,
        identifier: packet.identifier,
        source: packet.source,
        payload: new Uint8Array(0),
      }),
    );
    return;
  }
  state.tunnels.set(packet.identifier, { buffer: Buffer.alloc(0) });
  sendRaw(
    state,
    createPacket({
      operation: OpCode.OpTunnelSuccess,
      identifier: packet.identifier,
      source: packet.source,
      payload: new Uint8Array(0),
    }),
  );
}

export function handleTunnelData(fs: FakeFs, state: ConnState, packet: HwlinkPacket): void {
  const tunnel = state.tunnels.get(packet.identifier);
  if (!tunnel) return;
  tunnel.buffer = Buffer.concat([tunnel.buffer, Buffer.from(packet.data ?? new Uint8Array(0))]);
  // HTTP-over-stream: answer complete requests; keep partial ones
  // buffered (the client chunks tunnel data too).
  while (true) {
    const request = tryParseHttp(tunnel.buffer);
    if (!request) return;
    tunnel.buffer = tunnel.buffer.subarray(request.consumed);
    const response = answerFileServer(fs, state, request);
    sendRaw(
      state,
      createPacket({
        operation: OpCode.OpTcpTunnelData,
        identifier: packet.identifier,
        source: packet.source,
        payload: response,
      }),
    );
  }
}
