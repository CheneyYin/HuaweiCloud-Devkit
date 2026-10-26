// The sandbox file-server + HTTP-tunnel upload transport, extracted from
// session-manager: embeds and deploys the Python file server on the sandbox,
// opens a dedicated hwlink tunnel channel, drives the raw-socket POST with its
// hand-rolled HTTP/1.1 parsing, waits for server health, and owns the
// best-effort upload log. upload-project.ts imports this transport for the
// project orchestration; nothing here is part of the session-manager public
// face.

import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createConnection as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { asRecord } from '../lib/as-record.ts';
import { createTunnelSession, execWithSession } from './hwlink-connection.ts';
import { firstExisting, loadWsExec, type HwlinkExecResult } from './ws-exec-loader.ts';

// Thrown values cross the JS boundary as `unknown` under strict mode; only a
// non-empty message string is surfaced (same pattern as update-check.ts).
export function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message) return message;
  }
  return undefined;
}

export interface UploadTunnelResponse {
  bytes?: number;
  md5?: string;
  [key: string]: unknown;
}

export interface UploadProjectOptions {
  exclude?: string[];
  sandboxPort?: number;
  verify?: boolean;
  extract?: boolean;
}

// The embedded file-server asset resolves from this module's own directory —
// same three-layout discipline (source / compiled mirror / bundled entry) as
// the ws-exec barrel in ws-exec-loader.ts; the structure guard's one-climb
// rule covers this derivation too.
const __dirname = dirname(fileURLToPath(import.meta.url));

const SANDBOX_FILE_SERVER_SCRIPT = readFileSync(
  firstExisting(join(__dirname, 'sandbox-file-server.py'), join(__dirname, 'sandbox', 'sandbox-file-server.py')),
  'utf8',
);

const TUNNEL_READY_TIMEOUT_MS = 30000;
const SERVER_HEALTH_MAX_RETRIES = 30;
const SERVER_HEALTH_INTERVAL_MS = 1000;
export const UPLOAD_LOG_PATH = join(tmpdir(), 'sandbox-upload.log');

export function uploadLog(message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  console.error(line.trimEnd());
  try {
    appendFileSync(UPLOAD_LOG_PATH, line);
  } catch {
    // best-effort by design: a failed log-file append must never fail the caller
  }
}

export function rotateUploadLog(maxBytes = 100 * 1024): void {
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

export async function cleanupFileServer(workspaceId: string, username: string): Promise<void> {
  const pidFile = '/tmp/sandbox-file-server.pid';
  const scriptPath = '/tmp/sandbox-file-server.py';
  await execWithSession(workspaceId, `kill $(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile} ${scriptPath}`, username);
}

export async function uploadViaHttpTunnel(
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
