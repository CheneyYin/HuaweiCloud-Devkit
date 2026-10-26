// Identity + stamp lifecycle for the telemetry family: the machine-finger
// / installation-id recovery chain, the cached user hash, the install
// counter, and the DAU / first-use daily stamps. Every function takes the
// face-owned context; nothing here derives paths or keeps module state.
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { unlinkSync } from 'node:fs';

import { ensureDir, getStampUTCDate, getUTCToday, readTextFile, stampExists, writeTextFile } from './telemetry-fs.ts';
import type { TelemetryContext } from './telemetry-types.ts';
import { buildEvent, osTypeStr } from './telemetry-values.ts';

function generateMachineFinger(): string {
  const host = hostname();
  const nets = networkInterfaces();
  let firstMac = '';
  for (const key of Object.keys(nets).sort((a, b) => a.localeCompare(b))) {
    const list = nets[key];
    if (!list) continue;
    const iface = list.find((a) => a.mac && a.mac !== '00:00:00:00:00:00');
    if (iface) {
      firstMac = iface.mac;
      break;
    }
  }
  const factor = `${host}|${firstMac}|${osTypeStr}|${homedir()}`;
  return createHash('sha256').update(factor).digest('hex');
}

// The body of the public generateOrRecoverInstallId (re-exported through
// the face): recover the persisted installation id, or mint one from the
// machine finger (falling back to a random UUID when no finger can be
// derived).
export function recoverInstallId(ctx: TelemetryContext): string {
  const { machineFingerPath, installationIdPath, globalTelemetryDir } = ctx.paths;
  ensureDir(globalTelemetryDir);
  if (stampExists(installationIdPath)) {
    const cached = readTextFile(installationIdPath);
    if (cached) return cached;
  }
  const finger = stampExists(machineFingerPath) ? readTextFile(machineFingerPath) : generateMachineFinger();
  if (!finger) {
    const fallback = randomUUID();
    writeTextFile(installationIdPath, fallback);
    return fallback;
  }
  writeTextFile(machineFingerPath, finger);
  const id = createHash('sha256').update(finger).digest('hex');
  writeTextFile(installationIdPath, id);
  return id;
}

export function loadCachedUserHash(ctx: TelemetryContext): void {
  if (stampExists(ctx.paths.userHashPath)) {
    const cached = readTextFile(ctx.paths.userHashPath);
    if (cached) ctx.state.userHash = cached;
  }
}

// The persistence half of the public cacheUserHash; the in-memory half
// stays in the face, next to the state it mutates.
export function persistUserHash(ctx: TelemetryContext, hash: string): void {
  ensureDir(ctx.paths.globalTelemetryDir);
  writeTextFile(ctx.paths.userHashPath, hash);
}

// The file half of the public clearUserHash.
export function clearUserHashFile(ctx: TelemetryContext): void {
  try {
    unlinkSync(ctx.paths.userHashPath);
  } catch {
    // best-effort: the in-memory hash is already cleared; a leftover file only re-caches it next start
  }
}

// The body of the public trackInstall: bump the persisted install counter
// (consumed by initTelemetry as plugin:install events).
export function recordInstall(ctx: TelemetryContext): void {
  ensureDir(ctx.paths.agentTelemetryDir);

  let count = 0;
  const existing = readTextFile(ctx.paths.installCounterPath);
  if (existing) count = parseInt(existing, 10) || 0;
  writeTextFile(ctx.paths.installCounterPath, String(count + 1));
}

export function consumeInstallCounter(ctx: TelemetryContext): number {
  ensureDir(ctx.paths.agentTelemetryDir);
  const existing = readTextFile(ctx.paths.installCounterPath);
  if (!existing) return 0;
  const count = parseInt(existing, 10) || 0;
  if (count <= 0) return 0;
  writeTextFile(ctx.paths.installCounterPath, '0');
  return count;
}

export function shouldSendFirstUsePing(ctx: TelemetryContext): boolean {
  return !stampExists(ctx.paths.firstUseStampPath);
}

export function checkDauPing(ctx: TelemetryContext): void {
  const today = getUTCToday();
  if (today === ctx.state.lastCheckedDate) return;
  ctx.state.lastCheckedDate = today;
  if (!stampExists(ctx.paths.dauStampPath) || getStampUTCDate(ctx.paths.dauStampPath) !== today) {
    ctx.state.eventQueue.unshift(buildEvent(ctx, { key: 'dau:active_today', value: '1' }));
  }
}
