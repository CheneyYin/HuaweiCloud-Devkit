// The event pipeline: enqueue (with hook-spool ingestion and the DAU ping),
// the queue caps, the batch flush over fetchWithProxy with timeout and
// bounded retry, the opt-out gate (HUAWEICLOUD_DEVKIT_TELEMETRY=off) and
// the endpoint override, and the stamp touches a successful flush
// performs. State arrives via the face-owned context.
import { fetchWithProxy } from '../proxy/proxy-agent.ts';
import { checkDauPing } from './identity-stamps.ts';
import { ingestHookSpool } from './hook-ingest.ts';
import { touchFile } from './telemetry-fs.ts';
import type { TelemetryContext, TelemetryEvent, TelemetryEventInput } from './telemetry-types.ts';
import { buildEvent } from './telemetry-values.ts';

const MAX_QUEUE_SIZE = 500;
const BATCH_SIZE = 100;
const FETCH_TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;

const DEFAULT_ENDPOINT = 'https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/telemetry/events';

export function isTelemetryEnabled(): boolean {
  return process.env.HUAWEICLOUD_DEVKIT_TELEMETRY !== 'off';
}

function getEndpoint(): string {
  return process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;
}

// The body of the public enqueueEvent (re-exported through the face).
export function enqueueTrackedEvent(ctx: TelemetryContext, raw: TelemetryEventInput): void {
  if (!isTelemetryEnabled()) return;
  if (!ctx.state.installId) return;

  ingestHookSpool(ctx);

  checkDauPing(ctx);

  const event = buildEvent(ctx, raw);
  ctx.state.eventQueue.push(event);

  if (ctx.state.eventQueue.length > MAX_QUEUE_SIZE) {
    ctx.state.eventQueue = ctx.state.eventQueue.slice(ctx.state.eventQueue.length - MAX_QUEUE_SIZE);
  }

  if (ctx.state.eventQueue.length >= BATCH_SIZE) setImmediate(() => flushEvents(ctx));
}

export function flushEvents(ctx: TelemetryContext): void {
  if (ctx.state.isFlushing) return;
  if (ctx.state.eventQueue.length === 0) return;
  ctx.state.isFlushing = true;

  const batch = ctx.state.eventQueue.splice(0, BATCH_SIZE);
  const keys = batch.map((e) => e.key).join(',');
  // The queue was checked non-empty above; splice yields a non-empty batch.
  ctx.debugLog(
    `FLUSH start events=${batch.length} harness=${batch[0]!.harness} agentVersion=${batch[0]!.agentVersion} keys=[${keys}]`,
  );

  const endpoint = getEndpoint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  fetchWithProxy(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch.map(({ _retries, ...rest }) => rest)),
    signal: controller.signal,
  })
    .then((resp) => {
      clearTimeout(timer);
      ctx.debugLog(`POST status=${resp.status} events=${batch.length}`);
      if (resp.ok) {
        for (const event of batch) {
          if (event.key === 'dau:active_today') touchFile(ctx.paths.dauStampPath);
          if (event.key === 'plugin:install') touchFile(ctx.paths.installStampPath);
          if (event.key === 'plugin:first_use') touchFile(ctx.paths.firstUseStampPath);
        }
      } else if (resp.status >= 400 && resp.status < 500) {
        ctx.debugLog(`POST status=${resp.status} dropping ${batch.length} events (client error)`);
      } else {
        requeueEvents(ctx, batch);
      }
      ctx.state.isFlushing = false;
    })
    .catch((error: unknown) => {
      clearTimeout(timer);
      ctx.debugLog(`POST FAIL err=${error instanceof Error ? error.message : String(error)} events=${batch.length}`);
      requeueEvents(ctx, batch);
      ctx.state.isFlushing = false;
    });
}

function requeueEvents(ctx: TelemetryContext, batch: TelemetryEvent[]): void {
  const kept: TelemetryEvent[] = [];
  for (const event of batch) {
    const retries = event._retries || 0;
    if (retries >= MAX_RETRIES) {
      ctx.debugLog(`DROP event key=${event.key} after ${MAX_RETRIES} retries`);
      continue;
    }
    event._retries = retries + 1;
    kept.push(event);
  }
  if (kept.length > 0) ctx.state.eventQueue = [...kept, ...ctx.state.eventQueue];
}
