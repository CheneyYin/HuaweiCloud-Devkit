// The base64 single-file upload family, extracted from session-manager: chunk
// constants, the local-path classification (#953), the remote-parent mkdir
// reset, and uploadFileWithSession (chunked printf appends + decode + md5
// verify over the cached exec session). session-manager.ts re-exports the
// public names; upload-project.ts imports the shared classify/retry constants.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { execWithSession } from './hwlink-connection.ts';
import { stripTerminalEscapes } from './sandbox-output.ts';

interface UploadFileResult {
  ok: boolean;
  localPath: string;
  remotePath: string;
  bytes: number;
  chunks: number;
  md5: string;
  md5Verified: boolean;
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

// #953: classify a local upload path BEFORE reading it — distinguish
// missing file (accurate "not found") from missing PARENT directory (the
// report case: agents hand the MCP server a path from another machine or a
// nonexistent tree). The parent-missing error names the directory and the
// copy-to-tmpdir escape hatch; the DevKit server reads files from the
// machine it runs on, not the agent's machine.
export function classifyLocalUploadPath(localPath: string, kind: 'file' | 'directory' = 'file'): Error | null {
  const expected = kind === 'directory' ? 'directory' : 'regular file';
  const prefix = kind === 'directory' ? 'sandbox upload project' : 'sandbox upload';
  if (existsSync(localPath)) {
    const stat = statSync(localPath);
    const matches = kind === 'directory' ? stat.isDirectory() : stat.isFile();
    if (!matches) {
      return new Error(`${prefix}: path is not a ${expected}: ${localPath}`);
    }
    return null;
  }
  const parent = dirname(localPath);
  if (!existsSync(parent)) {
    return new Error(
      `${prefix}: directory not found: ${parent}. The DevKit MCP server reads files from ` +
        `the machine it runs on. Verify the path, or first copy the ${expected} to the local ` +
        `temp directory (${tmpdir()}) and upload from there.`,
    );
  }
  return new Error(`${prefix}: local ${expected} not found: ${localPath}`);
}

// #953: reset command for uploadFileWithSession. mkdir -p the remote parent BEFORE any
// chunk writes — the `printf >>` appends land in "${remotePath}.b64tmp" next to the
// target, so an absent directory (e.g. /workspace/game2048/) would fail the very first
// batch. This aligns base64-path behavior with upload_project's file server (which
// already makedirs). Paths are double-quoted for SPACES only — remote_path is
// agent-supplied and $/"/` shapes are not sanitized here (same house quoting as every
// other upload splice site; not a privilege boundary — exec_one_shot runs arbitrary
// commands as the same principal). "path with spaces" is covered by tests.
export function buildUploadResetCommand(remotePath: string, tmpPath: string): string {
  return `mkdir -p "$(dirname "${remotePath}")" && rm -f "${tmpPath}"`;
}

export async function uploadFileWithSession(
  workspaceId: string,
  localPath: string,
  remotePath: string,
  username = 'root',
  timeoutMs = 30000,
): Promise<UploadFileResult> {
  const localError = classifyLocalUploadPath(localPath, 'file');
  if (localError) {
    throw localError;
  }
  const content = readFileSync(localPath);
  const base64 = content.toString('base64');
  const expectedMd5 = createHash('md5').update(content).digest('hex');
  const chunks = splitBase64Chunks(base64);
  const tmp = `${remotePath}.b64tmp`;

  const reset = await execWithSession(workspaceId, buildUploadResetCommand(remotePath, tmp), username, timeoutMs);
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
