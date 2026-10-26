// The project upload orchestration, extracted from session-manager: archive
// creation (git archive when available, else tar with the exclude expansion),
// streaming md5, local archive cleanup, and uploadProjectWithSession — the
// retry loop over the HTTP-tunnel transport, the md5 verify, the remote
// extract with the traverse-permission fixup, and the file-server cleanup.
// The transport lives in upload-transport.ts; the path classification and
// retry constants in upload-file.ts. session-manager.ts re-exports
// uploadProjectWithSession as the stable public face.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync, statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { execWithSession } from './hwlink-connection.ts';
import { UPLOAD_MAX_RETRIES, classifyLocalUploadPath } from './upload-file.ts';
import {
  UPLOAD_LOG_PATH,
  cleanupFileServer,
  errorMessage,
  rotateUploadLog,
  uploadLog,
  uploadViaHttpTunnel,
  type UploadProjectOptions,
  type UploadTunnelResponse,
} from './upload-transport.ts';

const execFileAsync = promisify(execFile);

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

interface UploadProjectResult {
  ok: boolean;
  localDir: string;
  remotePath: string;
  bytes: number;
  md5: string;
  md5Verified: boolean;
  extracted: boolean;
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
  const localError = classifyLocalUploadPath(localDir, 'directory');
  if (localError) {
    throw localError;
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
