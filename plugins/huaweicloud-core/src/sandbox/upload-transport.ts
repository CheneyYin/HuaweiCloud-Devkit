// The sandbox file-server + HTTP-tunnel upload transport, extracted from
// session-manager: embeds and deploys the Python file server on the sandbox,
// opens a dedicated hwlink tunnel channel, and drives the archive POST and
// the health wait through the raw-socket client in tunnel-http.ts, with the
// best-effort diagnostics in upload-diagnostics.ts. upload-project.ts imports
// this transport for the project orchestration; nothing here is part of the
// session-manager public face.

import { readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTunnelSession, execWithSession } from './hwlink-connection.ts';
import { firstExisting, loadWsExec, type HwlinkExecResult } from './ws-exec-loader.ts';
import { UPLOAD_LOG_PATH, errorMessage, uploadLog } from './upload-diagnostics.ts';
import { uploadViaTunnel, waitForServerReady, type UploadTunnelResponse } from './tunnel-http.ts';

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
