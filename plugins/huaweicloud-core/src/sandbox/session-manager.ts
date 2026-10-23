import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection as netConnect } from 'node:net';
import {
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  rmSync,
  createReadStream,
  appendFileSync,
  unlinkSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { asRecord } from '../lib/as-record.ts';
import { createConnection, getCredentials } from '../lib/hdkit/hwlink-api.ts';
import { getWebSocketImpl } from '../proxy/proxy-agent.ts';
import { trackSandboxConnect, trackSandboxDisconnect } from '../telemetry/telemetry.ts';

const execFileAsync = promisify(execFile);

// Thrown values cross the JS boundary as `unknown` under strict mode; only a
// non-empty message string is surfaced (same pattern as update-check.ts).
function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message) return message;
  }
  return undefined;
}

// Mirrors the original `error.code || error.name || 'unknown'` fallback.
function errorLabel(error: unknown): string {
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === 'string' && record.code) return record.code;
    if (typeof record.name === 'string' && record.name) return record.name;
  }
  if (error instanceof Error && error.name) return error.name;
  return 'unknown';
}

// Result shape returned by ws-exec's exec / executeHwlinkCommand. `error` is
// never set by ws-exec (failures reject), but the existing fallbacks read it.
interface HwlinkExecResult {
  stdout: string;
  exitCode: number;
  url?: string;
  source?: number;
  username?: string;
  command?: string;
  error?: string;
}

interface HwlinkTerminalSession {
  state: 'opening' | 'ready' | 'closed';
  exec(_command: string, _options?: { timeoutMs?: number }): Promise<HwlinkExecResult>;
  close(): void;
}

interface HwlinkMultiplexer {
  readyState: number;
  onClose?: () => void;
  onError?: (_error: unknown) => void;
  close(): void;
}

interface HwlinkTunnelChannel {
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
interface WsExecModule {
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

interface TunnelSession {
  mux: HwlinkMultiplexer;
  close: () => void;
}

interface UploadTunnelResponse {
  bytes?: number;
  md5?: string;
  [key: string]: unknown;
}

interface UploadFileResult {
  ok: boolean;
  localPath: string;
  remotePath: string;
  bytes: number;
  chunks: number;
  md5: string;
  md5Verified: boolean;
}

interface UploadProjectOptions {
  exclude?: string[];
  sandboxPort?: number;
  verify?: boolean;
  extract?: boolean;
}

interface UploadProjectResult {
  ok: boolean;
  localDir: string;
  remotePath: string;
  bytes: number;
  md5: string;
  md5Verified: boolean;
  extracted: boolean;
}

interface DeployNginxOptions {
  nginxType?: string;
  port?: number;
  project?: string;
  outputDir?: string;
  nodePort?: number;
  publicPort?: number;
  configName?: string;
}

interface DeployNginxResult {
  ok: boolean;
  error?: string;
  nginxType: string;
  port: number;
  nodePort: number | undefined;
  outputPath: string;
  projectPath: string;
  configPath: string;
  verification?: { configPath: string; nginxTest: string };
  exitCode: number;
  stdout: string;
  nextStep: string;
  warning: string | undefined;
}

interface DeployCheckOptions {
  port: number;
  project: string;
  outputDir: string;
  frameworkType?: string;
}

interface DeployCheckEntry {
  status: string;
  detail: string;
}

interface DeployCheckResult {
  ok: boolean;
  complete: boolean;
  checkType: string;
  checks: Record<string, DeployCheckEntry>;
  score: { pass: number; total: number } | null;
  publicUrl: string | undefined;
  missingSteps: string | undefined;
  parseWarning: string | undefined;
  rawOutput: string | undefined;
  nextStep: string;
  remediation: string | undefined;
}

// Public tunnel URL domain for the DevBridge s2 gateway. The pre-migration Huawei Cloud
// bridge domain was retired in Sep 2026 and now serves a 「服务已迁移」 placeholder page with
// HTTP 200 — never construct tunnel URLs from it. Exported for devbridge-tunnel.ts (the
// DevBridge-owned module keeps the single copy).
export const DEVBRIDGE_TUNNEL_DOMAIN = 'devbridge-s2.hwtunnel.com';
// Migration placeholder page marker — a tunnel URL returning this body must be treated as unreachable.
export const DEVBRIDGE_MIGRATION_MARKER = '服务已迁移';
// Gateway-level tunnel error bodies. "tunnel not found" was verified live
// against the s2 gateway (Oct 2026: 404, text/plain, body "tunnel not found\n");
// the other two are the gateway's documented contract:
//   404 "tunnel not found"    — no live host session on the gateway (host process dead or
//                               tunnel deleted); the tunnel RECORD may still exist in `list`
//   404 "port not configured" — the URL's port is not registered on the tunnel
//   502 "bad gateway"         — host session alive, but the registered port has no local service
// A bare status check cannot distinguish these from app-generated 404/502 responses, so the
// checks below match the exact body AND gate on the HTTP status code.
export const DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER = 'tunnel not found';
export const DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER = 'port not configured';
export const DEVBRIDGE_BAD_GATEWAY_MARKER = 'bad gateway';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Asset and barrel paths must resolve in three layouts: source (src/sandbox,
// Node type-stripping), compiled mirror (dist/sandbox/*.js), and the bundled
// server entry (dist/mcp-server.js inlines this module, so __dirname is dist/
// itself and subdirectory assets sit one level below it).
function firstExisting(...candidates: string[]): string {
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

export const TUNNEL_URL_PATTERN = /TUNNEL_URL:(https:\/\/[A-Za-z0-9_-]+-\d+\.devbridge-s2\.hwtunnel\.com)/;

async function loadWsExec(): Promise<WsExecModule> {
  return (await import(resolveWsExecIndexUrl())) as WsExecModule;
}

let currentWorkspaceId: string | null = process.env.HW_WORKSPACE_ID || null;

function getCurrentWorkspaceId(): string | null {
  return currentWorkspaceId;
}

function setWorkspaceId(id: string | null): void {
  if (id && id !== currentWorkspaceId) {
    trackSandboxConnect();
  }
  currentWorkspaceId = id;
  // Node coerces env assignments to strings (`null` -> "null"); String() keeps
  // that behavior while satisfying the typed ProcessEnv setter.
  process.env.HW_WORKSPACE_ID = String(id);
}

const sessions = new Map<string, HwlinkTerminalSession>();

// The signed-connection prologue every hwlink session flavor shares:
// credentials, the hdkit connection request, the proxy-aware WebSocket
// implementation, and the ws-exec runtime.
async function openHwlinkConnection(workspaceId: string) {
  const { ak, sk, securitytoken } = getCredentials();
  const { wsUrl, source } = await createConnection(workspaceId, ak, sk, securitytoken);
  const WebSocketImpl = await getWebSocketImpl(wsUrl);
  const wsExec = await loadWsExec();
  return { wsUrl, source, WebSocketImpl, wsExec };
}

// The side-effecting half of getSession: credentials, the hdkit connection
// request, and the ws-exec spawn. Split out so the cache orchestration in
// getSession is the only logic that reads and writes the sessions Map.
async function connectTerminalSession(
  workspaceId: string,
  username: string,
  timeoutMs?: number,
): Promise<HwlinkTerminalSession> {
  const { wsUrl, source, WebSocketImpl, wsExec } = await openHwlinkConnection(workspaceId);
  return await wsExec.connectHwlinkTerminalSession({
    url: wsUrl,
    source,
    username,
    timeoutMs,
    WebSocketImpl,
  });
}

let sessionConnector = connectTerminalSession;

// Test seam for the session cache: tests drive execWithSession (the real
// interface) with only the side-effecting connector replaced.
export function _setSessionConnectorForTests(
  connector: ((_workspaceId: string, _username: string, _timeoutMs?: number) => Promise<HwlinkTerminalSession>) | null,
): void {
  sessionConnector = connector ?? connectTerminalSession;
}

async function getSession(workspaceId: string, username: string, timeoutMs?: number): Promise<HwlinkTerminalSession> {
  const key = `${workspaceId}:${username}`;
  const existing = sessions.get(key);
  // A cached session whose transport died (state 'closed') would fail every
  // exec with the closed-before-marker error until an explicit
  // close_session; evict it and reconnect instead.
  if (existing) {
    if (existing.state !== 'closed') return existing;
    sessions.delete(key);
  }

  const session = await sessionConnector(workspaceId, username, timeoutMs);
  sessions.set(key, session);
  return session;
}

async function createTunnelSession(workspaceId: string, username: string, timeoutMs = 30000): Promise<TunnelSession> {
  const { wsUrl, source, WebSocketImpl, wsExec } = await openHwlinkConnection(workspaceId);
  const mux = new wsExec.HwlinkWebSocketMultiplexer(wsUrl, source, { WebSocketImpl, protocol: 'devenv' });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('tunnel session WebSocket open timeout'));
    }, timeoutMs);
    const interval = setInterval(() => {
      if (mux.readyState === 1) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve();
      } else if (mux.readyState === 3) {
        clearTimeout(timer);
        clearInterval(interval);
        reject(new Error('tunnel session WebSocket closed'));
      }
    }, 100);
    mux.onClose = () => {
      clearTimeout(timer);
      clearInterval(interval);
      reject(new Error('tunnel session WebSocket closed'));
    };
    mux.onError = (err) => {
      clearTimeout(timer);
      clearInterval(interval);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
  });

  return { mux, close: () => mux.close() };
}

export async function execOneShot(
  workspaceId: string,
  command: string,
  username: string,
  timeoutMs: number,
): Promise<HwlinkExecResult> {
  const { wsUrl, source, WebSocketImpl, wsExec } = await openHwlinkConnection(workspaceId);
  return await wsExec.executeHwlinkCommand({
    url: wsUrl,
    source,
    username,
    command,
    timeoutMs,
    WebSocketImpl,
  });
}

export async function execWithSession(
  workspaceId: string,
  command: string,
  username: string,
  timeoutMs?: number,
): Promise<HwlinkExecResult> {
  const session = await getSession(workspaceId, username, timeoutMs);
  return await session.exec(command, { timeoutMs });
}

export const UPLOAD_CHUNK_SIZE = 30000;

export const UPLOAD_BATCH_SIZE = 2;

export const UPLOAD_MAX_RETRIES = 3;

export function splitBase64Chunks(base64: string, chunkSize = UPLOAD_CHUNK_SIZE): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < base64.length; offset += chunkSize) {
    chunks.push(base64.slice(offset, offset + chunkSize));
  }
  return chunks;
}

export function formatPortConflictWarning(basePort: number, targetPort: number): string | undefined {
  return targetPort !== basePort ? `Port ${basePort} is in use — auto-assigned port ${targetPort}` : undefined;
}

export function formatPortDriftWarning(basePort: number, targetPort: number): string | undefined {
  if (targetPort === basePort) return undefined;
  return `Port ${basePort} was occupied — nginx now listens on port ${targetPort}. Any DevBridge tunnel bound to port ${basePort} is detached: run "devbridge port create <tunnelId> -p ${targetPort} --protocol http -a" and restart "devbridge host" for the new port.`;
}

export async function resolveProxyNodePort(
  nodePort: number | undefined,
  nginxListenPort: number,
  isPortInUse: (candidate: number) => Promise<boolean>,
): Promise<number> {
  const baseCandidate = nodePort && nodePort !== nginxListenPort ? nodePort : nginxListenPort + 1;
  let candidate = baseCandidate;
  for (
    let attempt = 0;
    attempt < 10 && (candidate === nginxListenPort || (await isPortInUse(candidate)));
    attempt += 1
  ) {
    candidate += 1;
  }
  return candidate;
}

export function buildExposeRemediation(port: number): string {
  return `In the sandbox: source /tmp/hw_creds.sh; source /tmp/hw_api_key 2>/dev/null; devbridge delete-all; devbridge create <name>; devbridge port create <tunnelId> -p ${port} --protocol http -a; if command -v setsid >/dev/null 2>&1; then setsid nohup devbridge host <tunnelId> -p ${port} -e 72 > /tmp/host.log 2>&1 < /dev/null & else nohup devbridge host <tunnelId> -p ${port} -e 72 > /tmp/host.log 2>&1 < /dev/null & fi; disown 2>/dev/null || true; If deploy_nginx reported a different (auto-incremented) port in its "port" field, use THAT port instead of the one shown here. Full procedure in huawei-sandbox skill, Step 7 (Expose via DevBridge).`;
}

export async function uploadFileWithSession(
  workspaceId: string,
  localPath: string,
  remotePath: string,
  username = 'root',
  timeoutMs = 30000,
): Promise<UploadFileResult> {
  if (!existsSync(localPath)) {
    throw new Error(`sandbox upload: local file not found: ${localPath}`);
  }
  if (!statSync(localPath).isFile()) {
    throw new Error(`sandbox upload: path is not a regular file: ${localPath}`);
  }
  const content = readFileSync(localPath);
  const base64 = content.toString('base64');
  const expectedMd5 = createHash('md5').update(content).digest('hex');
  const chunks = splitBase64Chunks(base64);
  const tmp = `${remotePath}.b64tmp`;

  const reset = await execWithSession(workspaceId, `rm -f "${tmp}"`, username, timeoutMs);
  if (reset.exitCode !== 0) {
    throw new Error(`sandbox upload: failed to reset temp file: ${reset.stdout || reset.error || reset.exitCode}`);
  }

  for (let batchStart = 0; batchStart < chunks.length; batchStart += UPLOAD_BATCH_SIZE) {
    const batch = chunks.slice(batchStart, batchStart + UPLOAD_BATCH_SIZE);
    const combinedChunk = batch.join('');
    const batchNum = Math.floor(batchStart / UPLOAD_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(chunks.length / UPLOAD_BATCH_SIZE);
    const cmd = `printf '%s' '${combinedChunk}' >> "${tmp}"`;

    let batchOk = false;
    let lastError: string | number | undefined;
    for (let retry = 0; retry < UPLOAD_MAX_RETRIES; retry++) {
      const res = await execWithSession(workspaceId, cmd, username, timeoutMs);
      if (res.exitCode === 0) {
        batchOk = true;
        break;
      }
      lastError = res.stdout || res.error || res.exitCode;
      console.error(`  upload retry ${retry + 1}/${UPLOAD_MAX_RETRIES} for batch ${batchNum}/${totalBatches}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!batchOk) {
      throw new Error(`sandbox upload: failed writing batch ${batchNum}/${totalBatches}: ${lastError}`);
    }
    if (batchNum % 10 === 0 || batchNum === totalBatches) {
      console.error(`  upload progress: batch ${batchNum}/${totalBatches}`);
    }
  }

  const decode = await execWithSession(
    workspaceId,
    `base64 -d "${tmp}" > "${remotePath}" && rm -f "${tmp}"`,
    username,
    timeoutMs,
  );
  if (decode.exitCode !== 0) {
    throw new Error(
      `sandbox upload: failed decoding to ${remotePath}: ${decode.stdout || decode.error || decode.exitCode}`,
    );
  }

  const verify = await execWithSession(workspaceId, `md5sum "${remotePath}"`, username, timeoutMs);
  let md5Verified = false;
  if (verify.exitCode === 0) {
    const remoteMd5 = stripTerminalEscapes(verify.stdout).trim().split(/\s+/)[0];
    md5Verified = remoteMd5 === expectedMd5;
    if (!md5Verified) {
      throw new Error(
        `sandbox upload: md5 mismatch for ${remotePath} (expected ${expectedMd5}, got ${remoteMd5 || 'none'})`,
      );
    }
  }

  return {
    ok: true,
    localPath,
    remotePath,
    bytes: content.length,
    chunks: chunks.length,
    md5: expectedMd5,
    md5Verified,
  };
}

const SANDBOX_FILE_SERVER_SCRIPT = readFileSync(
  firstExisting(join(__dirname, 'sandbox-file-server.py'), join(__dirname, 'sandbox', 'sandbox-file-server.py')),
  'utf8',
);

const TUNNEL_READY_TIMEOUT_MS = 30000;
const SERVER_HEALTH_MAX_RETRIES = 30;
const SERVER_HEALTH_INTERVAL_MS = 1000;
const UPLOAD_LOG_PATH = join(tmpdir(), 'sandbox-upload.log');

function uploadLog(message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  console.error(line.trimEnd());
  try {
    appendFileSync(UPLOAD_LOG_PATH, line);
  } catch {
    // best-effort by design: a failed log-file append must never fail the caller
  }
}

function rotateUploadLog(maxBytes = 100 * 1024): void {
  try {
    if (existsSync(UPLOAD_LOG_PATH)) {
      const stat = statSync(UPLOAD_LOG_PATH);
      if (stat.size > maxBytes) {
        unlinkSync(UPLOAD_LOG_PATH);
      }
    }
  } catch {
    // best-effort: a failed rotation only leaves an oversized log file
  }
}

function generateUploadToken(): string {
  return randomBytes(16).toString('hex');
}

async function createTarGz(localDir: string, exclude: string[] = []): Promise<string> {
  const archiveName = `${basename(localDir)}.tar.gz`;
  const archiveDir = join(tmpdir(), `sandbox-upload-${Date.now()}`);
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, archiveName);

  const hasGit = existsSync(join(localDir, '.git'));
  if (hasGit) {
    await execFileAsync('git', [
      '-C',
      localDir,
      'archive',
      '--format=tar.gz',
      `--prefix=${basename(localDir)}/`,
      `--output=${archivePath}`,
      'HEAD',
    ]);
  } else {
    const args: string[] = [];
    for (const pattern of exclude) {
      if (pattern.startsWith('**/')) {
        const base = pattern.slice(3);
        for (let depth = 0; depth <= 4; depth++) {
          const prefix = depth === 0 ? '' : '*/'.repeat(depth);
          args.push('--exclude', `${prefix}${base}`);
        }
      } else {
        args.push('--exclude', pattern);
      }
    }
    args.push('-czf', archivePath, '-C', dirname(localDir), basename(localDir));
    await execFileAsync('tar', args);
  }

  return archivePath;
}

async function computeMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(filePath)
      .on('data', (chunk: string | Buffer) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function cleanupLocalArchive(archivePath: string): void {
  try {
    rmSync(dirname(archivePath), { recursive: true, force: true });
  } catch {
    // best-effort: a leftover temp archive dir is harmless
  }
}

async function deployFileServer(
  workspaceId: string,
  username: string,
  port = 8888,
  token = '',
): Promise<HwlinkExecResult> {
  const scriptPath = '/tmp/sandbox-file-server.py';
  const pidFile = '/tmp/sandbox-file-server.pid';
  uploadLog(`deployFileServer: killing old server (pidFile=${pidFile})`);
  await execWithSession(workspaceId, `kill $(cat ${pidFile} 2>/dev/null) 2>/dev/null; rm -f ${pidFile}`, username);
  const b64 = Buffer.from(SANDBOX_FILE_SERVER_SCRIPT).toString('base64');
  uploadLog(`deployFileServer: writing script (${b64.length} b64 chars)`);
  await execWithSession(workspaceId, `echo '${b64}' | base64 -d > ${scriptPath}`, username);
  const cmd = token
    ? `python3 ${scriptPath} ${port} ${token} & echo $! > ${pidFile}`
    : `python3 ${scriptPath} ${port} & echo $! > ${pidFile}`;
  uploadLog(`deployFileServer: starting server on port ${port}`);
  const startResult = await execWithSession(workspaceId, cmd, username);
  uploadLog(
    `deployFileServer: start result exitCode=${startResult.exitCode} stdout=${JSON.stringify(startResult.stdout?.slice(0, 200))}`,
  );
  return startResult;
}

async function uploadViaTunnel(
  localPort: number,
  archivePath: string,
  archiveSize: number,
  archiveRemotePath: string,
  uploadToken: string,
  timeoutMs: number,
): Promise<UploadTunnelResponse> {
  const archiveBuffer = readFileSync(archivePath);
  const headers = [
    'POST /upload HTTP/1.1',
    'Host: localhost',
    'Content-Type: application/octet-stream',
    `Content-Length: ${archiveSize}`,
    `X-Target-Path: ${archiveRemotePath}`,
    `X-Upload-Token: ${uploadToken}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  return new Promise<UploadTunnelResponse>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      }
    };
    const timer = setTimeout(() => done(() => reject(new Error(`upload timeout after ${timeoutMs}ms`))), timeoutMs);
    const sock = netConnect({ host: '127.0.0.1', port: localPort }, () => {
      sock.write(headers);
      sock.write(archiveBuffer);
    });
    let respBuf = Buffer.alloc(0);
    let contentLength = -1;
    let headerEnd = -1;
    // One settlement path for both completions (full body per Content-Length,
    // or whatever arrived when the socket closed): status check, logging,
    // and JSON parsing live here so the two triggers cannot drift.
    const settleResponse = (resp: string, body: string): void => {
      const statusLine = resp.split('\r\n')[0] || '';
      const statusCode = parseInt(statusLine.split(' ')[1]!, 10);
      if (!statusCode || statusCode < 200 || statusCode >= 300) {
        uploadLog(`uploadViaTunnel: POST failed with HTTP ${statusCode}: ${body.slice(0, 200)}`);
        reject(new Error(`upload HTTP ${statusCode}: ${body}`));
        return;
      }
      try {
        resolve(asRecord(JSON.parse(body)));
      } catch {
        reject(new Error(`invalid JSON response: ${body.slice(0, 200)}`));
      }
    };
    sock.on('data', (chunk) => {
      respBuf = Buffer.concat([respBuf, chunk]);
      if (contentLength < 0) {
        const resp = respBuf.toString();
        headerEnd = resp.indexOf('\r\n\r\n');
        if (headerEnd > 0) {
          const headerBlock = resp.slice(0, headerEnd);
          const clMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
          if (clMatch) contentLength = parseInt(clMatch[1]!, 10);
        }
      }
      if (contentLength >= 0 && headerEnd > 0) {
        const bodyReceived = respBuf.length - (headerEnd + 4);
        if (bodyReceived >= contentLength) {
          done(() => {
            const resp = respBuf.toString();
            settleResponse(resp, resp.slice(headerEnd + 4, headerEnd + 4 + contentLength));
          });
        }
      }
    });
    sock.on('close', () => {
      done(() => {
        const resp = respBuf.toString();
        const he = resp.indexOf('\r\n\r\n');
        settleResponse(resp, he > 0 ? resp.slice(he + 4) : '');
      });
    });
    sock.on('error', (err) => {
      done(() => {
        uploadLog(`uploadViaTunnel: socket error: ${err.message}`);
        reject(err);
      });
    });
  });
}

async function waitForServerReady(localPort: number): Promise<void> {
  for (let i = 0; i < SERVER_HEALTH_MAX_RETRIES; i++) {
    try {
      uploadLog(`waitForServerReady: attempt ${i + 1}, checking http://localhost:${localPort}/health`);
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (val: boolean): void => {
          if (!settled) {
            settled = true;
            sock.destroy();
            resolve(val);
          }
        };
        const sock = netConnect({ host: '127.0.0.1', port: localPort }, () => {
          sock.write('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
        });
        let resp = '';
        sock.on('data', (c) => {
          resp += c.toString();
          if (resp.includes('200 OK')) done(true);
        });
        sock.on('close', () => done(resp.includes('200 OK')));
        sock.on('error', () => done(false));
        setTimeout(() => done(false), 3000);
      });
      if (ok) {
        uploadLog(`waitForServerReady: server ready on port ${localPort} after ${i} retries`);
        return;
      }
      uploadLog(`waitForServerReady: health check returned non-200 (retry ${i + 1})`);
    } catch (error) {
      uploadLog(`waitForServerReady: health check failed: ${errorMessage(error)} (retry ${i + 1})`);
    }
    await new Promise((r) => setTimeout(r, SERVER_HEALTH_INTERVAL_MS));
  }
  throw new Error(
    `sandbox file server not ready after ${SERVER_HEALTH_MAX_RETRIES * SERVER_HEALTH_INTERVAL_MS}ms (log: ${UPLOAD_LOG_PATH})`,
  );
}

async function cleanupFileServer(workspaceId: string, username: string): Promise<void> {
  const pidFile = '/tmp/sandbox-file-server.pid';
  const scriptPath = '/tmp/sandbox-file-server.py';
  await execWithSession(workspaceId, `kill $(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile} ${scriptPath}`, username);
}

async function uploadViaHttpTunnel(
  workspaceId: string,
  archivePath: string,
  archiveRemotePath: string,
  username: string,
  timeoutMs: number,
  options: UploadProjectOptions,
): Promise<UploadTunnelResponse> {
  const sandboxPort = options.sandboxPort || 8888;
  const uploadToken = generateUploadToken();
  const archiveSize = statSync(archivePath).size;

  uploadLog(
    `uploadViaHttpTunnel: start (archive=${archivePath}, size=${archiveSize}, remotePath=${archiveRemotePath})`,
  );

  uploadLog(`uploadViaHttpTunnel: deploying file server on sandbox port ${sandboxPort}`);
  await deployFileServer(workspaceId, username, sandboxPort, uploadToken);

  uploadLog(`uploadViaHttpTunnel: creating dedicated tunnel session`);
  const tunnelSession = await createTunnelSession(workspaceId, username);

  uploadLog(`uploadViaHttpTunnel: creating tunnel channel (localPort=0, remotePort=${sandboxPort})`);
  const wsExec = await loadWsExec();
  const tunnel = new wsExec.HwlinkTunnelChannel({
    localPort: 0,
    remotePort: sandboxPort,
  });
  tunnel.attach(tunnelSession.mux);

  uploadLog(`uploadViaHttpTunnel: waiting for tunnel ready (timeout=${TUNNEL_READY_TIMEOUT_MS}ms)`);
  try {
    await Promise.race([
      tunnel.ready,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`tunnel ready timeout after ${TUNNEL_READY_TIMEOUT_MS}ms`)),
          TUNNEL_READY_TIMEOUT_MS,
        ),
      ),
    ]);
    uploadLog(`uploadViaHttpTunnel: tunnel ready, localPort=${tunnel.localPort}`);
  } catch (tunnelReadyError) {
    uploadLog(`uploadViaHttpTunnel: TUNNEL READY FAILED: ${errorMessage(tunnelReadyError)}`);
    tunnel.close();
    throw new Error(
      `HTTP tunnel failed to establish: ${errorMessage(tunnelReadyError)}. ` +
        `This means the WebSocket port-forwarding channel to sandbox port ${sandboxPort} could not be opened. ` +
        `Common causes: (1) Python file server not running on sandbox, (2) sandbox port ${sandboxPort} blocked, ` +
        `(3) hwlink multiplexer channel rejected. ` +
        `Diagnostic log: ${UPLOAD_LOG_PATH}`,
      { cause: tunnelReadyError },
    );
  }

  try {
    uploadLog(`uploadViaHttpTunnel: waiting for server health on localhost:${tunnel.localPort}`);
    await waitForServerReady(tunnel.localPort);

    uploadLog(`uploadViaHttpTunnel: sending POST with ${archiveSize} bytes`);
    const result = await uploadViaTunnel(
      tunnel.localPort,
      archivePath,
      archiveSize,
      archiveRemotePath,
      uploadToken,
      timeoutMs,
    );
    uploadLog(`uploadViaHttpTunnel: upload complete (bytes=${result.bytes}, md5=${result.md5})`);
    return result;
  } catch (uploadError) {
    uploadLog(`uploadViaHttpTunnel: UPLOAD FAILED: ${errorMessage(uploadError)}`);
    throw uploadError;
  } finally {
    tunnel.close();
    tunnelSession.close();
  }
}

export async function uploadProjectWithSession(
  workspaceId: string,
  localDir: string,
  remoteDir: string | undefined,
  username = 'root',
  timeoutMs = 300000,
  options: UploadProjectOptions = {},
): Promise<UploadProjectResult> {
  if (!workspaceId) {
    throw new Error(
      'sandbox upload project: workspace_id is required. ' +
        'Set HW_WORKSPACE_ID env var or ensure huaweicloud_sandbox_connect was called first.',
    );
  }
  if (!existsSync(localDir)) {
    throw new Error(`sandbox upload project: local directory not found: ${localDir}`);
  }
  if (!statSync(localDir).isDirectory()) {
    throw new Error(`sandbox upload project: path is not a directory: ${localDir}`);
  }

  rotateUploadLog();

  const projectName = basename(localDir);
  const targetParentDir = remoteDir || '/workspace';
  const archiveRemotePath = `${targetParentDir}/${projectName}.tar.gz`;

  const archivePath = await createTarGz(localDir, options.exclude);
  const archiveSize = statSync(archivePath).size;
  const expectedMd5 = await computeMd5(archivePath);

  uploadLog(`uploadProject: ${localDir} -> ${archiveRemotePath} (archive=${archiveSize} bytes, md5=${expectedMd5})`);

  const SIZE_50MB = 50 * 1024 * 1024;
  if (archiveSize > SIZE_50MB) {
    uploadLog(
      `uploadProject: archive size ${(archiveSize / (1024 * 1024)).toFixed(1)}MB exceeds 50MB. ` +
        `Dependencies or platform binaries may have been included. ` +
        `Ensure exclude list contains "**/node_modules" to match all nesting levels.`,
    );
  }

  let result: UploadTunnelResponse = {};
  let tunnelError: unknown;
  for (let attempt = 0; attempt < UPLOAD_MAX_RETRIES; attempt++) {
    try {
      await cleanupFileServer(workspaceId, username).catch(() => {});
      result = await uploadViaHttpTunnel(workspaceId, archivePath, archiveRemotePath, username, timeoutMs, options);
      tunnelError = null;
      break;
    } catch (error) {
      tunnelError = error;
      const errorType = errorLabel(error);
      uploadLog(
        `uploadProject: attempt ${attempt + 1}/${UPLOAD_MAX_RETRIES} failed [${errorType}]: ${errorMessage(error)}`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (tunnelError) {
    uploadLog(`uploadProject: all ${UPLOAD_MAX_RETRIES} attempts failed: ${errorMessage(tunnelError)}`);
    uploadLog(`uploadProject: NOT falling back to base64 (removed). Rethrowing with diagnostics.`);
    cleanupLocalArchive(archivePath);
    throw new Error(
      `sandbox upload failed after ${UPLOAD_MAX_RETRIES} attempts: HTTP tunnel could not transfer the project archive. ` +
        `Archive size: ${(archiveSize / 1024).toFixed(1)}KB. ` +
        `Root cause: ${errorMessage(tunnelError)}. ` +
        `Diagnostic log: ${UPLOAD_LOG_PATH}`,
      { cause: tunnelError },
    );
  }

  if (options.verify !== false && result.md5 && result.md5 !== expectedMd5) {
    throw new Error(`md5 mismatch: expected ${expectedMd5}, got ${result.md5}`);
  }

  if (options.extract !== false) {
    await execWithSession(
      workspaceId,
      `mkdir -p "${targetParentDir}" && tar -xzf "${archiveRemotePath}" -C "${targetParentDir}" && rm -f "${archiveRemotePath}"`,
      username,
      timeoutMs,
    );
    try {
      await execWithSession(
        workspaceId,
        [
          `REAL_PATH=$(readlink -f "${targetParentDir}/${projectName}" 2>/dev/null || echo "${targetParentDir}/${projectName}")`,
          `if [ ! -d "$REAL_PATH" ] && [ -d "${targetParentDir}" ]; then`,
          `  REAL_PATH="${targetParentDir}/${projectName}"`,
          `fi`,
          `chmod -R o+rX "$REAL_PATH" 2>/dev/null || true`,
          `find "$REAL_PATH" -type d -exec chmod o+x {} \\; 2>/dev/null || true`,
          `find "$REAL_PATH" -type f -path "*/node_modules/.bin/*" -exec chmod +x {} \\; 2>/dev/null || true`,
        ].join('\n'),
        username,
        15000,
      );
    } catch {
      // best-effort: the upload already succeeded; the traverse-permission fixup only hardens later nginx serving
    }
  }

  try {
    await cleanupFileServer(workspaceId, username);
  } catch {
    // best-effort: the next deploy's pidfile sweep kills a leftover file server
  }
  cleanupLocalArchive(archivePath);

  return {
    ok: true,
    localDir,
    remotePath: options.extract !== false ? `${targetParentDir}/${projectName}` : archiveRemotePath,
    bytes: result.bytes || 0,
    md5: result.md5 || expectedMd5,
    md5Verified: result.md5 ? result.md5 === expectedMd5 : true,
    extracted: options.extract !== false,
  };
}

// A1 (#935): normalize configName to a bare filename — a path-shaped value
// (e.g. a local path echoed back by a caller) must never splice into a broken
// target like `/etc/nginx/conf.d//root/hc-activity.conf` (nginx never serves
// it, the tunnel answers 502). Only the basename is kept and the `.conf`
// suffix stripped before the path is rebuilt; a pure filename (no separators)
// keeps the previous behavior unchanged.
export function resolveNginxConfigPath(configName: string | undefined, project: string): string {
  const raw = String(configName || project || '');
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || '';
  const name = base.replace(/\.conf$/i, '') || 'default';
  return `/etc/nginx/conf.d/${name}.conf`;
}

export interface ParsedDeployNginxVerify {
  configMissing: boolean;
  nginxTest: string;
  nginxTestOutput: string;
}

// A1 (#935): parse the write-verification block appended to the deploy_nginx
// script. The old flow returned ok:true whenever the deploy script exited 0,
// even when the tee write silently failed — the config file never existed and
// the tunnel answered 502. The verification block emits explicit markers:
//   DB_NGINX_CONFIG_MISSING=1  — the target config file does not exist
//   DB_NGINX_T=PASS|FAIL       — nginx -t verdict, with failure output echoed
//                                as `DB_NGINX_T_OUTPUT: ...` lines
export function parseDeployNginxVerifyOutput(stdout: string | undefined): ParsedDeployNginxVerify {
  const text = String(stdout || '');
  const configMissing = /DB_NGINX_CONFIG_MISSING=1/.test(text);
  const nginxTest = text.match(/^DB_NGINX_T=(\w+)$/m)?.[1] ?? '';
  const nginxTestOutput = (text.match(/^DB_NGINX_T_OUTPUT: .*$/gm) ?? [])
    .map((line) => line.replace(/^DB_NGINX_T_OUTPUT: /, ''))
    .join('\n');
  return { configMissing, nginxTest, nginxTestOutput };
}

export interface DeployNginxVerdict {
  ok: boolean;
  error?: string;
}

// A1 (#935): the deploy verdict. A deploy script exit of 0 alone is NOT proof
// of success — the tee write can fail silently (broken pipe) and nginx -t can
// reject the config. Returns ok:false with an explicit, actionable error for
// any verification failure; a pure function so the verdict is unit-testable.
export function evaluateDeployNginxVerify(
  result: { exitCode: number },
  verify: ParsedDeployNginxVerify,
  configPath: string,
): DeployNginxVerdict {
  const writeVerified = result.exitCode === 0 && !verify.configMissing && verify.nginxTest === 'PASS';
  if (writeVerified) return { ok: true };
  const problems: string[] = [];
  if (result.exitCode !== 0) problems.push(`deploy script exited with code ${result.exitCode}`);
  if (verify.configMissing) problems.push(`nginx config file ${configPath} was not created (tee write failed)`);
  if (verify.nginxTest !== 'PASS')
    problems.push(`nginx -t did not pass${verify.nginxTestOutput ? ` — ${verify.nginxTestOutput}` : ''}`);
  return {
    ok: false,
    error: `sandbox deploy nginx: configuration write verification failed — ${problems.join('; ')}.`,
  };
}

export async function deployNginx(
  workspaceId: string,
  { nginxType, port, project, outputDir, nodePort, publicPort, configName }: DeployNginxOptions,
  username = 'root',
  timeoutMs = 60000,
): Promise<DeployNginxResult> {
  if (!workspaceId) {
    throw new Error('sandbox deploy nginx: workspace_id is required.');
  }
  if (!nginxType || !port || !project || !outputDir) {
    throw new Error('sandbox deploy nginx: nginxType, port, project, and outputDir are required.');
  }

  const nginxCheck = await execOneShot(
    workspaceId,
    'command -v nginx >/dev/null 2>&1 && echo "INSTALLED" || echo "MISSING"',
    username,
    10000,
  );
  if (!String(nginxCheck.stdout || '').includes('INSTALLED')) {
    throw new Error(
      'sandbox deploy nginx: nginx is not installed. Install it first:\n' +
        '  Detect OS: source /etc/os-release && echo $ID\n' +
        '  apt: sudo apt-get update -qq && sudo apt-get install -y -qq nginx\n' +
        '  yum: sudo yum install -y nginx\n' +
        '  dnf: sudo dnf install -y nginx\n' +
        'Alternatively, skip nginx and use Python HTTP server (see nginx-templates.md).',
    );
  }

  const listenPort = publicPort || port;
  const basePort = nginxType === 'proxy' ? listenPort : port;

  let targetPort = basePort;
  const maxPortAttempts = 10;
  for (let offset = 0; offset < maxPortAttempts; offset += 1) {
    targetPort = basePort + offset;
    try {
      const portCheck = await execOneShot(
        workspaceId,
        `ss -tlnp 2>/dev/null | grep -q ":${targetPort} " && echo "IN_USE" || echo "FREE"`,
        username,
        10000,
      );
      if (!String(portCheck.stdout || '').includes('IN_USE')) break;
    } catch {
      // a failed probe reads as in-use; conservatively try the next port
    }
    if (offset === maxPortAttempts - 1) {
      throw new Error(
        `sandbox deploy nginx: all ports ${basePort}-${basePort + maxPortAttempts - 1} are in use. Free a port and try again.`,
      );
    }
  }

  const effectiveNodePort =
    nginxType === 'proxy'
      ? await resolveProxyNodePort(nodePort, targetPort, async (candidate) => {
          const portCheck = await execOneShot(
            workspaceId,
            `ss -tlnp 2>/dev/null | grep -q ":${candidate} " && echo "IN_USE" || echo "FREE"`,
            username,
            10000,
          );
          return String(portCheck.stdout || '').includes('IN_USE');
        })
      : undefined;

  const projectPath = `/workspace/${project}`;
  const outputPath = outputDir.startsWith('/') ? outputDir : `${projectPath}/${outputDir}`;

  const resolveScript = `REAL_PROJECT=$(readlink -f "${projectPath}" 2>/dev/null || echo "${projectPath}")
REAL_OUTPUT="${outputPath}"
if [ "\${REAL_PROJECT}" != "${projectPath}" ]; then
  REL_OUTPUT=$(echo "${outputDir}" | sed "s|${projectPath}/||")
  REAL_OUTPUT="\${REAL_PROJECT}/\${REL_OUTPUT}"
fi`;

  const templates: Record<string, string> = {
    spa: `server {
    listen ${targetPort};
    root ${outputPath};
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}`,
    proxy: `server {
    listen ${targetPort};
    server_name _;
    large_client_header_buffers 4 32k;

    location / {
        proxy_pass http://127.0.0.1:${effectiveNodePort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
        proxy_buffer_size 128k;
        proxy_buffers 4 256k;
        proxy_busy_buffers_size 256k;
    }
}`,
    static: `server {
    listen ${targetPort};
    root ${outputPath};
    index index.html;

    location / {
        try_files $uri $uri.html $uri/ =404;
        autoindex off;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}`,
  };

  const config = templates[nginxType];
  if (!config) {
    throw new Error(`sandbox deploy nginx: unknown nginxType "${nginxType}". Must be one of: spa, proxy, static`);
  }

  // A1 (#935): configName is normalized to a bare filename so a path-shaped
  // value can never produce `/etc/nginx/conf.d//root/xxx.conf` again.
  const configPath = resolveNginxConfigPath(configName, project);

  const cmd = [
    resolveScript,
    `sudo mkdir -p /etc/nginx/conf.d`,
    `sudo tee ${configPath} > /dev/null << 'NGINX_EOF'`,
    config,
    `NGINX_EOF`,
    `# Resolve symlinks for chmod (chmod does not follow symlinks on Linux)`,
    `chmod -R o+rX "$REAL_PROJECT" 2>/dev/null || true`,
    `find "$REAL_PROJECT" -type d -exec chmod o+x {} \\; 2>/dev/null || true`,
    `find "$REAL_PROJECT" -type f -path "*/node_modules/.bin/*" -exec chmod +x {} \\; 2>/dev/null || true`,
    `if pgrep -x nginx > /dev/null 2>&1; then sudo killall -9 nginx 2>/dev/null; sleep 1; fi
    sudo nginx`,
    `# A1 (#935): verify the config write took effect before reporting success`,
    `NGINX_CONFIG_PATH=${configPath}`,
    `if [ ! -f "$NGINX_CONFIG_PATH" ]; then echo "DB_NGINX_CONFIG_MISSING=1"; fi`,
    `NGINX_T_OUTPUT=$(sudo nginx -t 2>&1 || true)`,
    `if echo "$NGINX_T_OUTPUT" | grep -Eq "syntax is ok|test is successful"; then echo "DB_NGINX_T=PASS"; else echo "DB_NGINX_T=FAIL"; echo "$NGINX_T_OUTPUT" | sed "s/^/DB_NGINX_T_OUTPUT: /"; fi`,
  ].join('\n');

  const result = await execOneShot(workspaceId, cmd, username, timeoutMs);

  let tunnelActive = false;
  try {
    // Version-aware: devbridge 0.1.x exposes JSON via `list -j`; 0.2.x removed -j and
    // prints a table whose data rows start with the 8-char base32 tunnel ID.
    const tunnelCheck = await execOneShot(
      workspaceId,
      '(devbridge list -j 2>/dev/null | grep -q \'"tunnelId"\' || devbridge list 2>/dev/null | grep -Eq \'^[a-z2-7]{8}[[:space:]]\') && echo "ACTIVE" || echo "INACTIVE"',
      username,
      10000,
    );
    tunnelActive = String(tunnelCheck.stdout || '').includes('ACTIVE');
  } catch {
    // a failed probe leaves tunnelActive false; the result then carries the incomplete-deployment warning
  }

  const warning =
    [
      !tunnelActive
        ? 'No active DevBridge tunnel — deployment is incomplete. Proceed to Step 7 to expose the app.'
        : undefined,
      formatPortConflictWarning(basePort, targetPort),
      tunnelActive ? formatPortDriftWarning(basePort, targetPort) : undefined,
    ]
      .filter(Boolean)
      .join(' | ') || undefined;

  // A1 (#935): verify the config write before reporting success. A deploy
  // script exit of 0 alone is NOT proof — the tee write can fail silently and
  // nginx -t can reject the config. Any verification failure returns ok:false
  // with an explicit, actionable error.
  const verify = parseDeployNginxVerifyOutput(result.stdout);
  const verdict = evaluateDeployNginxVerify(result, verify, configPath);
  if (!verdict.ok) {
    return {
      ok: false,
      error: verdict.error,
      nginxType,
      port: targetPort,
      nodePort: effectiveNodePort || undefined,
      outputPath,
      projectPath,
      configPath,
      exitCode: result.exitCode,
      stdout: result.stdout,
      nextStep: 'fix_and_retry',
      warning,
    };
  }

  return {
    ok: true,
    nginxType,
    port: targetPort,
    nodePort: effectiveNodePort || undefined,
    outputPath,
    projectPath,
    configPath,
    verification: { configPath, nginxTest: verify.nginxTest },
    exitCode: result.exitCode,
    stdout: result.stdout,
    nextStep: 'expose_via_devbridge',
    warning,
  };
}

// The deploy-check stdout contract as one exported pure function — the
// grammar (`name:PASS`, `SCORE:n/n`, `TUNNEL_URL:`, `VERDICT:COMPLETE`)
// is the product-fake interface for the e2e ws fake, so it is pinned by
// test/ws-exec-protocol.test.ts from BOTH sides (the fake's synthesized
// output must parse through this function).
export interface ParsedDeployCheck {
  checks: Record<string, DeployCheckEntry>;
  complete: boolean;
  score: { pass: number; total: number } | null;
  publicUrl: string | undefined;
  missing: string[];
  parseWarning: string | undefined;
}

// Strip terminal escape sequences from sandbox command output (#946): CSI
// color/cursor codes and OSC shell-integration markers (shells with integration
// enabled wrap EVERY line in \x1b]133;C\x07, which blinds anchored ^DB_...=
// parsers), then normalize \r\n / \r line endings to \n. The single copy —
// every sandbox-output parser entry point (parseDeployCheckOutput and the
// devbridge-tunnel parsers) folds this in instead of re-rolling the regexes.
// Use new RegExp to avoid ESLint no-control-regex on literal control chars in regex.
export function stripTerminalEscapes(text: unknown): string {
  // Callers pass ws-exec stdout (string | undefined at runtime); a non-string
  // input reads as empty, matching the previous `String(stdout || '')` for the
  // cases that matter (empty/undefined) without Object's default stringification.
  const raw = typeof text === 'string' ? text : '';
  const ESC = '\x1b';
  // CSI: parameter bytes 0x30-0x3F (digits ; : < = > ? — `?` for private modes
  // like \x1b[?2026h, `>` for device attributes), then intermediate bytes
  // 0x20-0x2F (e.g. `\x1b[0 q`), then a letter final. A digits-;-only class
  // leaves ?-prefixed sequences intact, blinding the anchored ^KEY= lookups.
  // Known edge: a malformed/truncated CSI followed by data lets the
  // intermediate class consume one leading data char — fail-closed corruption
  // of that field, still preferable to the unstripped escape blinding the line.
  const csiRe = new RegExp(ESC + '\\[[0-9:;<=>?]*[ -/]*[a-zA-Z]', 'g');
  const oscRe = new RegExp(ESC + '\\][^' + ESC + '\x07]*(?:\x07|' + ESC + '\\\\)', 'g');
  return raw
    .replace(csiRe, '')
    .replace(oscRe, '')
    .replace(/\r\n|\r/g, '\n');
}

export function parseDeployCheckOutput(stdout: string): ParsedDeployCheck {
  // Strip ANSI escape sequences (CSI color/cursor codes and OSC shell-integration markers)
  // and normalize line endings to \n to handle all terminal outputs.
  const cleanStdout = stripTerminalEscapes(stdout);
  const checks: Record<string, DeployCheckEntry> = {};
  const lines = cleanStdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^(\w+):(PASS|FAIL|SKIP)\b(.*)/);
    if (m) checks[m[1]!] = { status: m[2]!, detail: (m[3] || '').trim() };
  }
  const scoreMatch = cleanStdout.match(/SCORE:(\d+)\/(\d+)/);
  const tunnelMatch = cleanStdout.match(TUNNEL_URL_PATTERN);
  const complete = /VERDICT:COMPLETE/.test(cleanStdout);

  const missing: string[] = [];
  if (!complete) {
    for (const [key, val] of Object.entries(checks)) {
      if (val.status === 'FAIL') missing.push(key);
    }
  }

  // If checks is empty but score was found, parsing failed — raw output is kept for debugging
  const parseWarning =
    Object.keys(checks).length === 0 && scoreMatch
      ? 'Check output parsing failed — individual check results could not be extracted. See rawOutput for details.'
      : undefined;

  return {
    checks,
    complete,
    score: scoreMatch ? { pass: parseInt(scoreMatch[1]!, 10), total: parseInt(scoreMatch[2]!, 10) } : null,
    publicUrl: tunnelMatch ? tunnelMatch[1] : undefined,
    missing,
    parseWarning,
  };
}

export async function deployCheck(
  workspaceId: string,
  { port, project, outputDir, frameworkType }: DeployCheckOptions,
  username = 'root',
  // Mirrors SANDBOX_TIMEOUT_MS.deploy_check (packs/sandbox/tools.ts): the
  // bounded per-tunnel probing alone can spend 5 × 5s of curl plus devbridge
  // list round-trips. The remaining curls (localhost nginx/fingerprint, the
  // external QR service) are still unbounded — pre-existing; a hang there can
  // still consume the budget, but the probe loop itself now fits.
  timeoutMs = 60000,
): Promise<DeployCheckResult> {
  if (!workspaceId) {
    throw new Error('sandbox deploy check: workspace_id is required.');
  }

  const projectPath = `/workspace/${project}`;
  const outputPath = outputDir.startsWith('/') ? outputDir : `${projectPath}/${outputDir}`;
  const isCrossPlatform = frameworkType === 'cross-platform';

  const checkScript = [
    `echo "=== DEPLOY CHECK ==="`,
    `PASS=0`,
    `TOTAL=0`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} 2>/dev/null)`,
    `if [ -n "$HTTP_CODE" ] && [ "$HTTP_CODE" != "000" ]; then`,
    `  echo "nginx_serving:PASS (port ${port}, HTTP \${HTTP_CODE})"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "nginx_serving:FAIL (port ${port}, no HTTP response)"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `if [ -d "${outputPath}" ] && ls -A "${outputPath}" 2>/dev/null | grep -q .; then`,
    `  echo "output_dir:PASS (${outputPath})"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "output_dir:FAIL (${outputPath} empty or missing)"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `FINGERPRINT_FILE="${outputPath}/.deploy_fingerprint"`,
    `FINGERPRINT_EXPECTED=$(cat "$FINGERPRINT_FILE" 2>/dev/null)`,
    `if [ -n "$FINGERPRINT_EXPECTED" ]; then`,
    `  FINGERPRINT_ACTUAL=$(curl -s http://localhost:${port}/.deploy_fingerprint 2>/dev/null)`,
    `  if [ "$FINGERPRINT_EXPECTED" = "$FINGERPRINT_ACTUAL" ]; then`,
    `    echo "content_verified:PASS"`,
    `    PASS=$((PASS+1))`,
    `  else`,
    `    echo "content_verified:FAIL (fingerprint mismatch — nginx may be serving stale content from a previous deployment)"`,
    `  fi`,
    `else`,
    `  echo "content_verified:SKIP (no fingerprint file)"`,
    `  TOTAL=$((TOTAL-1))`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `DB_TUNNEL_ACTIVE=0`,
    `if devbridge list -j 2>/dev/null | grep -q '"tunnelId"'; then`,
    `  DB_TUNNEL_ACTIVE=1`,
    `elif devbridge list 2>/dev/null | grep -Eq '^[a-z2-7]{8}[[:space:]]'; then`,
    `  DB_TUNNEL_ACTIVE=1`,
    `fi`,
    `if [ "$DB_TUNNEL_ACTIVE" = "1" ]; then`,
    `  echo "devbridge_tunnel:PASS"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "devbridge_tunnel:FAIL"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `TUNNEL_IDS=$(devbridge list -j 2>/dev/null | grep -oP '"tunnelId":\\s*"\\K[^"]+' | head -5)`,
    `if [ -z "$TUNNEL_IDS" ]; then`,
    `  TUNNEL_IDS=$(devbridge list 2>/dev/null | grep -E '^[a-z2-7]{8}[[:space:]]' | awk '{print $1}' | head -5)`,
    `fi`,
    `# Gateway-level tunnel errors have exact text/plain bodies ("tunnel not found"`,
    `# verified live on the s2 gateway): 404 "tunnel not found" = no live host session`,
    `# (the tunnel RECORD may still be in \`list\`); 404 "port not configured" = URL port`,
    `# not registered; 502 "bad gateway" = tunnel alive, local service down. The`,
    `# whole-content comparison (tr strips \\r/\\n, so CRLF forms compare equal) plus`,
    `# status gating avoids flagging app-generated 404/502 pages — a page that`,
    `# merely MENTIONS a marker never matches. No migration-marker grep here: the`,
    `# probe URL is always constructed on the CURRENT gateway domain, which never`,
    `# serves the retired gateway's placeholder — a body grep could only fire on`,
    `# app content (a Chinese page saying 服务已迁移 is a legitimate app). Migration`,
    `# is judged host-log-side by expose_tunnel (DB_MIGRATION). --max-time 5 (vs`,
    `# the expose/verify probes' 10) keeps 5 bounded probes inside the timeout budget.`,
    `probe_tunnel() {`,
    `  local url="$1" code body`,
    `  code=$(curl -s -o /tmp/.dc_tunnel_body -w "%{http_code}" --max-time 5 "$url" 2>/dev/null)`,
    `  PROBE_FAIL_REASON=""`,
    `  if [ -z "$code" ] || [ "$code" = "000" ]; then PROBE_FAIL_REASON="unreachable"; rm -f /tmp/.dc_tunnel_body; return 1; fi`,
    `  body=$(tr -d '\\r\\n' < /tmp/.dc_tunnel_body 2>/dev/null)`,
    `  rm -f /tmp/.dc_tunnel_body`,
    `  if [ "$code" = "404" ] && [ "$body" = "${DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER}" ]; then PROBE_FAIL_REASON="tunnel not found (no live host session on the gateway)"; return 1; fi`,
    `  if [ "$code" = "404" ] && [ "$body" = "${DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER}" ]; then PROBE_FAIL_REASON="port not configured (URL port not registered on the tunnel)"; return 1; fi`,
    `  if [ "$code" = "502" ] && [ "$body" = "${DEVBRIDGE_BAD_GATEWAY_MARKER}" ]; then PROBE_FAIL_REASON="bad gateway (tunnel alive, local service not serving)"; return 1; fi`,
    `  return 0`,
    `}`,
    `# Probe each listed tunnel (bounded to 5) and select the first one that actually`,
    `# serves this port — \`devbridge list\` order is arbitrary, so a stale tunnel listed`,
    `# first must not shadow the live one.`,
    `SELECTED_URL=""`,
    `FIRST_ID=""`,
    `FIRST_REASON=""`,
    `for CAND in $TUNNEL_IDS; do`,
    `  if [ -z "$FIRST_ID" ]; then FIRST_ID="$CAND"; fi`,
    `  CAND_URL="https://\${CAND}-${port}.${DEVBRIDGE_TUNNEL_DOMAIN}"`,
    `  if probe_tunnel "$CAND_URL"; then`,
    `    SELECTED_URL="$CAND_URL"`,
    `    break`,
    `  fi`,
    `  # The FAIL detail pairs the first listed URL with the FIRST probe's reason —`,
    `  # PROBE_FAIL_REASON is overwritten per candidate and would misattribute.`,
    `  if [ -z "$FIRST_REASON" ]; then FIRST_REASON="$PROBE_FAIL_REASON"; fi`,
    `done`,
    `TUNNEL_URL="$SELECTED_URL"`,
    `if [ -n "$SELECTED_URL" ]; then`,
    `  echo "tunnel_url_accessible:PASS ($SELECTED_URL)"`,
    `  PASS=$((PASS+1))`,
    `elif [ -n "$FIRST_ID" ]; then`,
    `  echo "tunnel_url_accessible:FAIL (https://\${FIRST_ID}-${port}.${DEVBRIDGE_TUNNEL_DOMAIN} -> $FIRST_REASON)"`,
    `else`,
    `  echo "tunnel_url_accessible:FAIL (no tunnel)"`,
    `fi`,
    ``,
    `${`
TOTAL=$((TOTAL+1))
if [ -f "${outputPath}/qr.png" ]; then
  echo "qr_code:PASS"
  PASS=$((PASS+1))
else
  # Auto-detect cross-platform from project files (more reliable than frameworkType param)
  PROJ_DIR="/workspace/${project}"
  IS_CROSS=0
  if [ -f "$PROJ_DIR/manifest.json" ] || grep -qE '"@tarojs/taro"|"@dcloudio/uni-app"' "$PROJ_DIR/package.json" 2>/dev/null; then
    IS_CROSS=1
  fi
  if [ $IS_CROSS -eq 0 ] && ( [ -f "$PROJ_DIR/app.config.ts" ] || [ -f "$PROJ_DIR/app.config.js" ] ) && grep -qE "pages|tabBar" "$PROJ_DIR/app.config."* 2>/dev/null; then
    IS_CROSS=1
  fi

  if [ $IS_CROSS -eq 1 ]; then
    if [ -n "$TUNNEL_URL" ]; then
      curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$TUNNEL_URL" 2>/dev/null)" -o "${outputPath}/qr.png" 2>/dev/null
      chmod o+r "${outputPath}/qr.png" 2>/dev/null || true
      if [ -f "${outputPath}/qr.png" ] && [ -s "${outputPath}/qr.png" ]; then
        echo "qr_code:PASS (auto-generated)"
        PASS=$((PASS+1))
      else
        echo "qr_code:FAIL (QR generation failed)"
      fi
    else
      echo "qr_code:FAIL (no tunnel URL for QR generation)"
    fi
  else
    echo "qr_code:SKIP (not a cross-platform project)"
    TOTAL=$((TOTAL-1))
  fi
fi
`}`,
    `echo "SCORE:\${PASS}/\${TOTAL}"`,
    `echo "TUNNEL_URL:\${TUNNEL_URL:-}"`,
    `[ "\${PASS}" = "\${TOTAL}" ] && echo "VERDICT:COMPLETE" || echo "VERDICT:INCOMPLETE"`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await execOneShot(workspaceId, checkScript, username, timeoutMs);
  const stdout = String(result.stdout || '');
  const { checks, complete, score, publicUrl, missing, parseWarning } = parseDeployCheckOutput(stdout);

  const nextStepValue = !complete
    ? missing.includes('devbridge_tunnel') || missing.includes('tunnel_url_accessible')
      ? 'expose_via_devbridge'
      : missing.includes('nginx_serving')
        ? 'configure_nginx'
        : missing.includes('qr_code')
          ? 'generate_qr_code'
          : parseWarning
            ? 'review_raw_output'
            : 'review_checks'
    : 'complete';

  return {
    ok: true,
    complete,
    checkType: isCrossPlatform ? 'cross-platform' : 'standard',
    checks,
    score,
    publicUrl,
    missingSteps: missing.length > 0 ? missing.join(', ') : undefined,
    parseWarning,
    rawOutput: parseWarning ? stdout.trim() : undefined,
    nextStep: nextStepValue,
    remediation: nextStepValue === 'expose_via_devbridge' ? buildExposeRemediation(port) : undefined,
  };
}

export async function closeSession(workspaceId: string, username: string): Promise<boolean> {
  const key = `${workspaceId}:${username}`;
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  try {
    session.close();
  } catch {
    // best-effort: the session is already deregistered; a failed close must not fail disconnect tracking
  }
  trackSandboxDisconnect();
  return true;
}

export async function closeAllSessions(): Promise<void> {
  for (const [key, session] of sessions) {
    sessions.delete(key);
    try {
      session.close();
    } catch {
      // best-effort: one stuck session must not block closing the rest
    }
  }
}

export { getCurrentWorkspaceId, setWorkspaceId };
