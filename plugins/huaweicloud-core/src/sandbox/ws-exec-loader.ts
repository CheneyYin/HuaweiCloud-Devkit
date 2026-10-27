// The ws-exec runtime loader, extracted from session-manager: resolves the
// untyped ws-exec barrel across the three runtime layouts (source,
// compiled mirror, bundled server entry), models its structural surface, and
// exposes loadWsExec/firstExisting for the sandbox siblings. This module is a
// src/sandbox SUBDIR module — the __dirname one-climb discipline below is what
// the structure guard pins; it resolves identically in all three layouts
// because every src/sandbox sibling sits at the same depth.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Result shape returned by ws-exec's exec / executeHwlinkCommand. `error` is
// never set by ws-exec (failures reject), but the existing fallbacks read it.
export interface HwlinkExecResult {
  stdout: string;
  exitCode: number;
  url?: string;
  source?: number;
  username?: string;
  command?: string;
  error?: string;
}

export interface HwlinkTerminalSession {
  state: 'opening' | 'ready' | 'closed';
  exec(_command: string, _options?: { timeoutMs?: number }): Promise<HwlinkExecResult>;
  close(): void;
}

export interface HwlinkMultiplexer {
  readyState: number;
  onClose?: () => void;
  onError?: (_error: unknown) => void;
  close(): void;
}

export interface HwlinkTunnelChannel {
  localPort: number;
  ready: Promise<unknown>;
  attach(_mux: HwlinkMultiplexer): void;
  close(): void;
}

// Structural surface of the untyped ws-exec barrel resolved by
// resolveWsExecIndexUrl() (index.js in dist, index.ts in-repo). Only the members
// this module calls are modeled; the dynamic import is cast to this shape (same
// pattern as proxy-agent.ts's UndiciModule cast). The cast is honest because the
// target is our own bundled module, not parsed/untrusted data.
export interface WsExecModule {
  connectHwlinkTerminalSession(_options: {
    url: string;
    source: unknown;
    username: string;
    timeoutMs?: number;
    WebSocketImpl: unknown;
  }): Promise<HwlinkTerminalSession>;
  executeHwlinkCommand(_options: {
    url: string;
    source: unknown;
    username: string;
    command: string;
    timeoutMs: number;
    WebSocketImpl: unknown;
  }): Promise<HwlinkExecResult>;
  HwlinkWebSocketMultiplexer: new (
    _url: string,
    _source: unknown,
    _options: { WebSocketImpl: unknown; protocol: string },
  ) => HwlinkMultiplexer;
  HwlinkTunnelChannel: new (_options: { localPort: number; remotePort: number }) => HwlinkTunnelChannel;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Asset and barrel paths must resolve in three layouts: source (src/sandbox,
// Node type-stripping), compiled mirror (dist/sandbox/*.js), and the bundled
// server entry (dist/mcp-server.js inlines this module, so __dirname is dist/
// itself and subdirectory assets sit one level below it).
export function firstExisting(...candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Both call sites pass literal, non-empty candidate lists; the last entry is the fallback.
  return candidates[candidates.length - 1]!;
}

// ws-exec's sources are TypeScript, but runtime entry points read the compiled
// dist barrel. Prefer the compiled barrel (dist/sandbox -> dist/ws-exec, or the
// bundled entry -> dist/ws-exec) and fall back to the source barrel for
// in-repo runs (src/sandbox -> src/ws-exec, stripped by Node outside
// node_modules).
export function resolveWsExecIndexUrl(): string {
  const barrel = firstExisting(
    join(__dirname, '..', 'ws-exec', 'index.js'),
    join(__dirname, 'ws-exec', 'index.js'),
    join(__dirname, '..', 'ws-exec', 'index.ts'),
  );
  return pathToFileURL(barrel).href;
}

export async function loadWsExec(): Promise<WsExecModule> {
  return (await import(resolveWsExecIndexUrl())) as WsExecModule;
}
