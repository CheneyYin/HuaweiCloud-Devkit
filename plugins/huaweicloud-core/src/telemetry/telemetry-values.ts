// Event shaping for the telemetry family: value sanitization (the public
// sanitizeValue), the key→capability classification, the hook-event JSON
// narrowing, and buildEvent — plus the os snapshot every event carries.
// Stateless beyond the deterministic os snapshot: identity and version
// fields arrive through the context's state and pluginVersion.
import { type as osType, release as osRelease } from 'node:os';

import { asText } from '../lib/as-text.ts';
import type { TelemetryContext, TelemetryEvent, TelemetryEventInput } from './telemetry-types.ts';

const MAX_VALUE_LENGTH = 255;

const osTypeStr = osType();
const osVersionStr = osRelease();

export function sanitizeValue(value: unknown): string {
  let text = typeof value === 'string' ? value : value == null ? '' : asText(value);
  text = text.replace(/[\r\n\t]+/g, ' ').trim();
  if (text.length > MAX_VALUE_LENGTH) {
    text = text.slice(0, MAX_VALUE_LENGTH - 3) + '...';
  }
  return text;
}

function capabilityFromKey(key: string): string | undefined {
  if (key.startsWith('tool:')) return 'mcp';
  if (key.startsWith('cli:')) return 'cli';
  return undefined;
}

export function buildEvent(ctx: TelemetryContext, raw: TelemetryEventInput): TelemetryEvent {
  const event: TelemetryEvent = {
    key: raw.key,
    value: sanitizeValue(raw.value),
    installId: ctx.state.installId,
    userHash: ctx.state.userHash,
    version: ctx.pluginVersion,
    harness: ctx.state.agentHarness,
    agentVersion: ctx.state.agentVersion,
    os: osTypeStr,
    osVersion: osVersionStr,
  };
  const cap = raw.capability || capabilityFromKey(raw.key);
  if (cap) event.capability = cap;
  return event;
}

// Hook-event JSON arrives as text; only an object carrying a non-empty string
// key is accepted. Malformed lines are dropped rather than queued.
export function toTelemetryEventInput(value: unknown): TelemetryEventInput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== 'string' || record.key === '') return null;
  const input: TelemetryEventInput = { key: record.key, value: record.value };
  if (typeof record.capability === 'string') input.capability = record.capability;
  return input;
}

// Family-internal: the machine finger (identity-stamps.ts) folds the same
// os snapshot into its factor, so the snapshot has exactly one home.
export { osTypeStr };
