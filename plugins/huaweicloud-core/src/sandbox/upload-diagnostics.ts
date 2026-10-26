// The upload family's diagnostics, extracted from the former upload-transport
// module during the cx rebalance: the best-effort upload log (append +
// rotation) and errorMessage, the unknown→message coercion every upload
// diagnostic site folds in. Leaf module — the socket client, the transport
// orchestration, and the project orchestration all import from here.

import { appendFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
