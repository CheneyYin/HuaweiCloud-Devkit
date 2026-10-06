import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Process-scope singleton for the huaweicloud-open-mcp sidecar (openapi mode).
//
// Ownership: the sidecar belongs to THIS PROCESS, never to an McpServer
// object. The remote transport constructs and closes a server per HTTP
// request (src/mcp-server-remote.ts), so any lifecycle hooked on server
// construction or close would kill the sidecar once per request. The
// registry imports every pack's handler modules unconditionally, so module
// scope must stay side-effect free: the child spawns lazily on the first
// tool call, which is also what keeps a DEVKIT_PACKS-trimmed server from
// ever spawning it — the tools are not registered, so no call arrives.
//
// Lifetime: the child's stdin is a pipe held by this process. When the
// parent dies the pipe closes and the child sees EOF on stdin — the same
// shutdown signal this devkit's own stdio transport uses — and exits. No
// detached flag, no pidfile.
//
// Protocol: hand-rolled newline-delimited JSON-RPC 2.0 client. Only
// dist/mcp-server.js may import the MCP SDK (esbuild bundles it there), so
// the sidecar speaks the wire protocol directly; initialize +
// notifications/initialized + tools/call is the full surface the proxy
// needs. A per-call timeout rejects the pending entry without killing the
// child: the gateway retries its own HTTP internally, and one slow call
// must not take the server down for the calls after it.

const HANDSHAKE_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LIMIT = 4096;

const stats = { spawns: 0 };

interface PendingEntry {
  resolve: (_value: unknown) => void;
  reject: (_error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class OpenapiSidecar {
  readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  // Named lineBuffer, not buffer: the unicorn no-unsafe-buffer-conversion
  // rule pattern-matches `<x>.buffer.slice(...)` as a TypedArray conversion.
  private lineBuffer = '';
  stderrTail = '';
  alive = true;

  constructor(child: ChildProcess) {
    this.child = child;
    if (!child.stdout || !child.stderr || !child.stdin) throw new Error('sidecar spawned without piped stdio');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    child.on('exit', () => this.onExit('sidecar process exited'));
    child.on('error', (error) => this.onExit(error.message));
  }

  private onStdout(chunk: string): void {
    this.lineBuffer += chunk;
    let newline = this.lineBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.lineBuffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout; the protocol is line-delimited JSON only
    }
    if (typeof message.id !== 'number') return; // server notification: nothing subscribed
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message || 'openapi gateway error'));
    else entry.resolve(message.result);
  }

  private onExit(reason: string): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${reason}${this.stderrTail ? ` (stderr: ${this.stderrTail})` : ''}`));
    }
    this.pending.clear();
    // The singleton is dead: the next call respawns rather than queueing
    // forever against a child that will never answer.
    if (sidecarPromise) {
      const dead = sidecarPromise;
      sidecarPromise = null;
      dead.catch(() => {}); // callers already hold the rejection from their pending entry
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`openapi gateway ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async handshake(): Promise<void> {
    await this.request(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'huaweicloud-devkit', version: '1.0.0' },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
    this.notify('notifications/initialized');
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }
}

let sidecarPromise: Promise<OpenapiSidecar> | null = null;

// uv tool installs land in ~/.local/bin; OPENMCP_BIN overrides everything
// (tests point it at the fake fixture). Modeled on findHcloudBin: the
// agent harness PATH can differ from the installer shell's, so resolution
// happens at spawn time, not install time.
function resolveOpenMcpBin(): string | null {
  const envBin = process.env.OPENMCP_BIN;
  if (envBin && existsSync(envBin)) return envBin;
  const candidate = join(homedir(), '.local', 'bin', 'huaweicloud-open-mcp');
  if (existsSync(candidate)) return candidate;
  const lookup =
    process.platform === 'win32'
      ? spawnSync('where.exe', ['huaweicloud-open-mcp'], { encoding: 'utf8', timeout: 5000 })
      : spawnSync('which', ['huaweicloud-open-mcp'], { encoding: 'utf8', timeout: 5000 });
  const hit = lookup.status === 0 ? (lookup.stdout || '').trim().split('\n')[0] : '';
  return hit || null;
}

async function spawnSidecar(): Promise<OpenapiSidecar> {
  const bin = resolveOpenMcpBin();
  if (!bin) {
    throw new Error(
      'huaweicloud-open-mcp not found. Install it with `uv tool install huaweicloud-open-mcp` (or set OPENMCP_BIN to its absolute path), then run doctor to verify. The openapi pack needs the gateway for API catalog access.',
    );
  }
  const child = spawn(bin, ['--mode', 'openapi', '--elicitation', 'off'], { stdio: ['pipe', 'pipe', 'pipe'] });
  stats.spawns += 1;
  const sidecar = new OpenapiSidecar(child);
  await sidecar.handshake();
  return sidecar;
}

export function openapiSidecar(): Promise<OpenapiSidecar> {
  if (!sidecarPromise) {
    sidecarPromise = spawnSidecar().catch((error) => {
      sidecarPromise = null; // spawn or handshake failed: the next call retries
      throw error;
    });
  }
  return sidecarPromise;
}

export interface OpenapiToolResult {
  ok: boolean;
  tool: string;
  [key: string]: unknown;
}

// One proxied tools/call, normalized to the devkit result shape. The
// gateway is the authoritative validator of its own tool inputs; the zod
// schemas in tools.ts are a thin boundary guard, so unexpected extras pass
// through and errors surface as {ok:false} rather than throws.
export async function callOpenapiTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<OpenapiToolResult> {
  try {
    const sidecar = await openapiSidecar();
    const raw = (await sidecar.call(name, args, timeoutMs)) as {
      content?: Array<{ text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    if (raw.isError) {
      const text = (raw.content || [])
        .map((part) => part.text || '')
        .join('\n')
        .trim();
      return { ok: false, tool: name, error: text || 'openapi gateway tool error' };
    }
    if (raw.structuredContent && typeof raw.structuredContent === 'object') {
      return { ok: true, tool: name, ...raw.structuredContent };
    }
    const text = (raw.content || [])
      .map((part) => part.text || '')
      .join('\n')
      .trim();
    try {
      return { ok: true, tool: name, ...(JSON.parse(text) as Record<string, unknown>) };
    } catch {
      return { ok: true, tool: name, raw: text };
    }
  } catch (error) {
    return { ok: false, tool: name, error: error instanceof Error ? error.message : String(error) };
  }
}

// Test hooks, same convention as _resetHintConsumption in mcp-protocol.ts.
export function _openapiSidecarStats(): { spawns: number; alive: boolean } {
  return { spawns: stats.spawns, alive: sidecarPromise !== null };
}

export async function _resetOpenapiSidecar(): Promise<void> {
  const promise = sidecarPromise;
  sidecarPromise = null;
  if (!promise) return;
  try {
    const sidecar = await promise;
    if (sidecar.alive) sidecar.child.kill();
    await new Promise((resolve) => setTimeout(resolve, 200));
  } catch {
    // already dead or never spawned
  }
}
