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
// claim, so concurrent processes claim disjoint files and writers (hooks,
// exit paths) always append to a fresh live file. Delivery is
// AT-LEAST-ONCE, not exactly-once: a failed unlink after a successful
// read (transient FS error) or a cross-process read inside the read→unlink
// window can re-send a batch — bounded duplicate telemetry, no loss
// (pre-existing semantics for the hook spool, inherited by the exit
// spool). Malformed lines are dropped; an unreadable leftover batch is
// unrecoverable and cleaned up best-effort.
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';

import type { TelemetryContext, TelemetryEvent } from './telemetry-types.ts';
import { buildEvent, toTelemetryEvent, toTelemetryEventInput } from './telemetry-values.ts';

// Mirrors event-pipeline's MAX_QUEUE_SIZE — the enqueue path clamps the
// queue there; the ingest path clamps here so the ≤500 invariant holds on
// every writer. A sibling import would create a value-level cycle
// (event-pipeline imports this module), so the value is mirrored and
// pinned equal by the cap behavior test (test/telemetry.test.ts: a
// 600-line spool ingests exactly 500, newest kept — the same keep-newest
// policy the enqueue clamp applies).
const MAX_INGEST_QUEUE = 500;

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
      // Clamp to the queue cap with the same keep-newest policy as the
      // enqueue path: without this, a large recovery (multi-session exit
      // spool accumulation) loads unbounded events, and the NEXT enqueue's
      // clamp would trim oldest-first — silently dropping exactly the
      // recovered events this seam exists to deliver.
      if (ctx.state.eventQueue.length > MAX_INGEST_QUEUE) {
        ctx.state.eventQueue = ctx.state.eventQueue.slice(-MAX_INGEST_QUEUE);
      }
    } catch {
      // an unreadable leftover batch is unrecoverable; fall through to cleanup
    } finally {
      try {
        unlinkSync(processingPath);
      } catch {
        // best-effort: a failed unlink retries this leftover on the next
        // ingest (at-least-once: the already-pushed events may re-send)
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
