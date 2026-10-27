// The hook-event spool seam: the PreToolUse hooks append JSONL lines to
// hook-events.jsonl inside the plugin dir; the server ingests any earlier
// .processing leftover (a crashed run), then renames the live spool to
// .processing for the NEXT ingest to pick up. Malformed lines are dropped;
// an unreadable leftover batch is unrecoverable and cleaned up best-effort.
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';

import type { TelemetryContext } from './telemetry-types.ts';
import { buildEvent, toTelemetryEventInput } from './telemetry-values.ts';

export function ingestHookSpool(ctx: TelemetryContext): void {
  const hookPath = ctx.paths.hookEventsPath;
  const processingPath = hookPath + '.processing';
  if (existsSync(processingPath)) {
    try {
      const lines = readFileSync(processingPath, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed: unknown = JSON.parse(line);
          const input = toTelemetryEventInput(parsed);
          if (input) ctx.state.eventQueue.push(buildEvent(ctx, input));
        } catch {
          // a malformed line is skipped; the rest of the leftover batch still ingests
        }
      }
    } catch {
      // an unreadable leftover batch is unrecoverable; fall through to cleanup
    } finally {
      try {
        unlinkSync(processingPath);
      } catch {
        // best-effort: a failed unlink just retries this leftover on the next ingest
      }
    }
  }
  if (!existsSync(hookPath)) return;
  try {
    renameSync(hookPath, processingPath);
  } catch {
    return;
  }
}
