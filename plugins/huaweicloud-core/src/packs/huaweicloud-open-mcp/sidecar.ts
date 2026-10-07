import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

const stats = { spawns: 0, lastPid: null as number | null };

interface PendingEntry {
  resolve: (_value: unknown) => void;
  reject: (_error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class OpenMcpSidecar {
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
    // A write landing in the window between the child's OS-level death and
    // Node's 'exit' delivery EPIPEs asynchronously on this socket; without a
    // listener that error is unhandled and takes down the whole server.
    // Routing it into onExit rejects the in-flight call fast instead.
    child.stdin.on('error', () => this.onExit('sidecar stdin write failed'));
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
    if (message.error) entry.reject(new Error(message.error.message || 'open-mcp gateway error'));
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
    // Only the current singleton's death clears it: a stale child (a
    // handshake-failure orphan being killed, or a reset victim exiting
    // late) must not drop a healthy replacement.
    if (currentSidecar === this) {
      currentSidecar = null;
      sidecarPromise = null;
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.alive) {
      // The caller holds a reference from before the child died; writing
      // would be silently dropped and burn the full timeout.
      return Promise.reject(new Error('open-mcp gateway sidecar is dead; the next call respawns it'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`open-mcp gateway ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    if (!this.alive) return;
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  // SIGTERM → SIGKILL escalation, the hcloud-cli.ts supervision pattern:
  // a child that ignores SIGTERM still dies, and the escalation timer is
  // cleared the moment the exit lands.
  kill(): void {
    if (!this.alive) return;
    this.child.kill('SIGTERM');
    const force = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    this.child.once('exit', () => clearTimeout(force));
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

let sidecarPromise: Promise<OpenMcpSidecar> | null = null;
// The resolved instance behind sidecarPromise; onExit compares against it so
// a stale child's late exit cannot clear a healthy replacement.
let currentSidecar: OpenMcpSidecar | null = null;

// Supported install paths, in resolution order: OPENMCP_BIN (absolute path
// to the gateway binary; tests point it at the fake fixture) → a persistent
// install on disk (~/.local/bin covers pip --user, pipx, and uv tool
// install; the PATH lookup covers venvs) → the uvx fallback, which runs the
// gateway with no persistent install at all. uvx fetches and caches the
// package on first run, so a cold first call can exceed the handshake
// timeout; the next call retries against the warm cache. Modeled on
// findHcloudBin/resolveHcloudCommand: the agent harness PATH can differ
// from the installer shell's, so resolution happens at spawn time, not
// install time. The env parameter follows the resolveEnabledPacks(env)
// precedent so tests can pin HOME/PATH deterministically.
export interface GatewayCommand {
  command: string;
  argsPrefix: string[];
}

export function resolveGatewayCommand(env: NodeJS.ProcessEnv = process.env): GatewayCommand | null {
  const envBin = env.OPENMCP_BIN;
  if (envBin && existsSync(envBin)) return { command: envBin, argsPrefix: [] };
  const home = process.platform === 'win32' ? homedir() : env.HOME || homedir();
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const candidate = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  if (existsSync(candidate)) return { command: candidate, argsPrefix: [] };
  const onPath = lookupOnPath('huaweicloud-open-mcp', env);
  if (onPath) return { command: onPath, argsPrefix: [] };
  // uvx last: it works with nothing installed, but a persistent binary is
  // preferred (no first-run download, no cache staleness). uvx itself
  // typically lives in ~/.local/bin — the exact directory the agent
  // harness PATH often misses — so it is probed there before PATH.
  const uvxCandidate = join(home, '.local', 'bin', `uvx${exeSuffix}`);
  if (existsSync(uvxCandidate)) return { command: uvxCandidate, argsPrefix: ['huaweicloud-open-mcp'] };
  const uvx = lookupOnPath('uvx', env);
  if (uvx) return { command: uvx, argsPrefix: ['huaweicloud-open-mcp'] };
  return null;
}

function lookupOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const lookup =
    process.platform === 'win32'
      ? spawnSync('where.exe', [name], { encoding: 'utf8', timeout: 5000, env })
      : spawnSync('which', [name], { encoding: 'utf8', timeout: 5000, env });
  const hit = lookup.status === 0 ? (lookup.stdout || '').trim().split('\n')[0] : '';
  return hit || null;
}

async function spawnSidecar(): Promise<OpenMcpSidecar> {
  const gateway = resolveGatewayCommand();
  if (!gateway) {
    throw new Error(
      'huaweicloud-open-mcp gateway not found. Install it with pip (`pip install huaweicloud-open-mcp`) or keep `uvx` on PATH to run it without a persistent install (`uv tool install huaweicloud-open-mcp` also works). OPENMCP_BIN can point at the gateway binary directly.',
    );
  }
  const gatewayArgs = ['--mode', 'openapi', '--elicitation', 'off'];
  // The gateway's logging defaults to a RELATIVE logs/ path that it mkdirs
  // at boot: bare, it would drop a logs/ directory into whatever cwd the
  // MCP server inherited (the user's project) and die outright on a
  // read-only cwd. Pin it to tmpdir unless the operator already configured
  // the gateway's own env var (args outrank env there).
  if (!process.env.HUAWEICLOUD_MCP_LOG_FILE) {
    gatewayArgs.push('--log-file', join(tmpdir(), 'huaweicloud-open-mcp.log'));
  }
  const child = spawn(gateway.command, [...gateway.argsPrefix, ...gatewayArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  stats.spawns += 1;
  stats.lastPid = child.pid ?? null;
  const sidecar = new OpenMcpSidecar(child);
  try {
    await sidecar.handshake();
  } catch (error) {
    // A failed handshake must not leak the child: the parent holds its
    // stdin pipe open, so an un-killed orphan stays alive — and pins the
    // event loop — for the process lifetime, once per retry.
    sidecar.kill();
    throw error;
  }
  return sidecar;
}

export function openMcpSidecar(): Promise<OpenMcpSidecar> {
  if (!sidecarPromise) {
    sidecarPromise = spawnSidecar()
      .then((sidecar) => {
        currentSidecar = sidecar;
        return sidecar;
      })
      .catch((error) => {
        sidecarPromise = null; // spawn or handshake failed: the next call retries
        throw error;
      });
  }
  return sidecarPromise;
}

export interface OpenMcpToolResult {
  ok: boolean;
  tool: string;
  [key: string]: unknown;
}

// The gateway's wire envelope reports refusals as {ok:false, reason} inside
// a SUCCESSFUL tools/call result, while every other pack surfaces failures
// as {ok:false, error}. Map reason into error so callers and telemetry see
// one failure shape; reason is kept for gateway fidelity.
function withErrorKey(result: OpenMcpToolResult): OpenMcpToolResult {
  if (result.ok === false && result.error === undefined && typeof result.reason === 'string') {
    return { ...result, error: result.reason };
  }
  return result;
}

// One proxied tools/call, normalized to the devkit result shape. The
// gateway is the authoritative validator of its own tool inputs; the zod
// schemas in tools.ts are a thin boundary guard, so unexpected extras pass
// through and errors surface as {ok:false} rather than throws.
export async function callOpenMcpTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<OpenMcpToolResult> {
  try {
    const sidecar = await openMcpSidecar();
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
      return { ok: false, tool: name, error: text || 'open-mcp gateway tool error' };
    }
    if (raw.structuredContent && typeof raw.structuredContent === 'object') {
      return withErrorKey({ ok: true, tool: name, ...raw.structuredContent });
    }
    const text = (raw.content || [])
      .map((part) => part.text || '')
      .join('\n')
      .trim();
    try {
      return withErrorKey({ ok: true, tool: name, ...(JSON.parse(text) as Record<string, unknown>) });
    } catch {
      return { ok: true, tool: name, raw: text };
    }
  } catch (error) {
    return { ok: false, tool: name, error: error instanceof Error ? error.message : String(error) };
  }
}

// Test hooks, same convention as _resetHintConsumption in mcp-protocol.ts.
// lastPid records the most recent spawn attempt's child pid so tests can
// assert orphan-freedom (no live process left) after failure paths.
export function _openMcpSidecarStats(): { spawns: number; alive: boolean; lastPid: number | null } {
  return { spawns: stats.spawns, alive: sidecarPromise !== null, lastPid: stats.lastPid };
}

export async function _resetOpenMcpSidecar(): Promise<void> {
  const promise = sidecarPromise;
  currentSidecar = null;
  sidecarPromise = null;
  if (!promise) return;
  try {
    const sidecar = await promise;
    sidecar.kill();
  } catch {
    // spawn or handshake already failed; spawnSidecar's catch killed the child
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
