// The spool-file ingest seams. Two JSONL spools converge here, sharing one
// crash-recovery pattern: the PreToolUse hooks' hook-events.jsonl (input-
// shaped lines — {key, value, capability?} — written by hook processes
// that know nothing about the server session, so they are REBUILT with the
// current session's identity via buildEvent) and the exit spool's
// exit-events.jsonl (FULL built events written synchronously by
// spoolEventsForExit at process exit, keeping the exiting session's
// identity — parsed strictly via toTelemetryEvent, never rebuilt).
//
// The shared pattern (crash-recovery convergence): ingest any earlier
// .processing leftover first (a crashed run's claim), then rename the live
// spool to .processing for the NEXT ingest to pick up — the rename is the
// claim, so concurrent processes (multiple agent sessions sharing the
// directory) never double-ingest one file, and writers (hooks, exit paths)
// always append to a fresh live file. Malformed lines are dropped; an
// unreadable leftover batch is unrecoverable and cleaned up best-effort.
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';

import type { TelemetryContext, TelemetryEvent } from './telemetry-types.ts';
import { buildEvent, toTelemetryEvent, toTelemetryEventInput } from './telemetry-values.ts';

export function ingestSpools(ctx: TelemetryContext): void {
  ingestJsonlSpool(ctx, ctx.paths.hookEventsPath, (parsed) => {
    const input = toTelemetryEventInput(parsed);
    return input ? buildEvent(ctx, input) : null;
  });
  ingestJsonlSpool(ctx, ctx.paths.exitEventsPath, toTelemetryEvent);
}

function ingestJsonlSpool(
  ctx: TelemetryContext,
  livePath: string,
  parseLine: (parsed: unknown) => TelemetryEvent | null,
): void {
  const processingPath = livePath + '.processing';
  if (existsSync(processingPath)) {
    try {
      const lines = readFileSync(processingPath, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed: unknown = JSON.parse(line);
          const event = parseLine(parsed);
          if (event) ctx.state.eventQueue.push(event);
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
  if (!existsSync(livePath)) return;
  try {
    renameSync(livePath, processingPath);
  } catch {
    return;
  }
}
