// Local hwlink ws-exec fake. Speaks the product's binary protocol via the
// PRODUCT's own packet codec (hwlink-packet.ts — vendored upstream ISC code,
// byte-pinned by test/ws-exec-protocol.test.ts) and the product's marker
// vocabulary (fake-shell.ts). This module owns the server lifecycle, the
// connection wiring, and the packet dispatch; the terminal-session protocol
// lives in terminal-protocol.ts and the tunnel relay (plus the in-fake HTTP
// file server) in tunnel-relay.ts. The client connects with subprotocol
// 'devenv' (Node's global WebSocket FAILS the handshake if the server does
// not echo it) — handleProtocols selects it.
//
// Recording channel: every connection (source, username, per-command
// intents, close kind) — the ws expectation surface. 'unknown' intents are
// recorded distinctly so cases can gate zero-unknown (fake drift = red).
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { OpCode, parsePacket, type HwlinkPacket } from '../../../plugins/huaweicloud-core/src/ws-exec/hwlink-packet.ts';
import { FakeFs } from './fake-shell.ts';
import { handleTunnelCreate, handleTunnelData } from './tunnel-relay.ts';
import { drainTerminalBuffer } from './terminal-protocol.ts';

export interface WsCommandRecording {
  intent: string;
  exitCode: number;
}

export interface WsConnectionRecording {
  source: number | null;
  username: string | null;
  commands: WsCommandRecording[];
  close: 'graceful' | 'abrupt' | null;
}

// Per-connection state, shared by the dispatcher here and the session-kind
// modules (terminal-protocol.ts, tunnel-relay.ts).
export interface ConnState {
  recording: WsConnectionRecording;
  socket: WebSocket;
  // Byte-stream accumulator: command blobs are terminated by the client's
  // done line, NEVER by ws-message boundaries (60KB single-line commands
  // arrive as ~8 packets).
  input: string;
  readyNonce: string | null;
  // The terminal channel's identifier from the client's 0xfb open — the
  // client's mux routes incoming packets BY IDENTIFIER, so responses must
  // echo it (an identifier-0 reply is silently dropped).
  identifier: number | null;
  // Tunnel sub-connections (tunnel sessions never open a terminal):
  // identifier → HTTP-over-stream state for the in-fake file server.
  tunnels: Map<number, { buffer: Buffer }>;
}

export class WsFake {
  readonly connections: WsConnectionRecording[] = [];
  // ONE fake machine: terminal sessions and tunnel sessions share the
  // filesystem and the process table — deployFileServer runs on the
  // terminal session, the tunnel connects from another ws connection.
  private readonly fs = new FakeFs();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;

  async start(): Promise<void> {
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ server, handleProtocols: () => 'devenv' });
    wss.on('connection', (socket, req) => this.handleConnection(socket, req));
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.wss = wss;
    this.port = (server.address() as { port: number }).port;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/hwlink`;
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    const server = this.server;
    if (!wss || !server) return;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.wss = null;
    this.server = null;
  }

  private handleConnection(socket: WebSocket, req: import('node:http').IncomingMessage): void {
    const source = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('source');
    const recording: WsConnectionRecording = {
      source: source !== null && /^\d+$/.test(source) ? Number(source) : null,
      username: null,
      commands: [],
      close: null,
    };
    this.connections.push(recording);
    const state: ConnState = {
      recording,
      socket,
      input: '',
      readyNonce: null,
      identifier: null,
      tunnels: new Map(),
    };
    socket.on('message', (data) => {
      try {
        this.handlePacket(state, parsePacket(data as Uint8Array));
      } catch {
        // A malformed frame is a protocol bug worth surfacing as an unknown
        // command, not a server crash.
        recording.commands.push({ intent: 'unknown', exitCode: -1 });
      }
    });
    socket.on('close', (code) => {
      recording.close = code === 1000 ? 'graceful' : 'abrupt';
    });
    socket.on('error', () => {
      recording.close = recording.close ?? 'abrupt';
    });
  }

  private handlePacket(state: ConnState, packet: HwlinkPacket): void {
    const op = packet.operation;
    if (op === OpCode.OpNewCmdTerminal) {
      // Fire-and-forget terminal open: payload is the username; the
      // identifier is the channel address every reply must carry.
      state.identifier = packet.identifier;
      state.recording.username = new TextDecoder().decode(packet.data ?? new Uint8Array(0));
      return;
    }
    if (op === OpCode.OpCmdTerminalResize || op === OpCode.OpCmdTerminalInit) {
      // Resize (sent when the client has initial cols/rows) and the init
      // ack are transport plumbing — silently ignored, never recorded.
      return;
    }
    // --- tunnel ops (tunnel sessions carry no terminal channel) ---
    if (op === OpCode.OpCreateTcpTunnel) {
      handleTunnelCreate(this.fs, state, packet);
      return;
    }
    if (op === OpCode.OpDisconnect) {
      state.tunnels.delete(packet.identifier);
      return;
    }
    if ((op & 0xff) === OpCode.OpTcpTunnelData) {
      handleTunnelData(this.fs, state, packet);
      return;
    }
    const isTerminalData =
      op === OpCode.OpCmdTerminalData || op === (OpCode.OpSubStreamPong | OpCode.OpCmdTerminalData);
    if (!isTerminalData) {
      // Anything else is unexpected at this layer — record it visibly.
      state.recording.commands.push({ intent: `op:0x${op.toString(16)}`, exitCode: 0 });
      return;
    }
    state.input += new TextDecoder().decode(packet.data ?? new Uint8Array(0));
    drainTerminalBuffer(state, this.fs);
  }
}
