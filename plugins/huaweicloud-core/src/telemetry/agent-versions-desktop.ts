// Desktop-agent version probes for the telemetry family: CodeArts,
// WorkBuddy, and OfficeAce — the three harnesses whose versions come from
// product install files (resources/app/package.json,
// install-manifest.json, .office-claw-release.json) at Windows install
// locations: the ProgramFiles/LOCALAPPDATA env bases plus the A:-Z: drive
// scan for off-system-drive installs. The package-tree detectors (DSH,
// Hermes), the shared JSON readers, and the detectVersion dispatch stay in
// agent-versions.ts.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const _codeartsSearchBases = (() => {
  const bases: string[] = [];
  if (process.env.ProgramFiles) bases.push(join(process.env.ProgramFiles, 'CodeArts Agent'));
  if (process.env['ProgramFiles(x86)']) bases.push(join(process.env['ProgramFiles(x86)'], 'CodeArts Agent'));
  if (process.env.ProgramW6432) bases.push(join(process.env.ProgramW6432, 'CodeArts Agent'));
  if (process.env.LOCALAPPDATA) bases.push(join(process.env.LOCALAPPDATA, 'Programs', 'CodeArts'));
  return bases;
})();

// One-property read off unknown parsed JSON, coerced only when truthy so the
// original `|| null` / `|| ''` fallbacks stay intact.
export function jsonField(value: unknown, field: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

// Version-ish fields in product-written JSON (package.json, install-manifest,
// release files): strings and numbers keep the historical truthy String()
// coercion; any other shape counts as absent.
export function versionText(v: unknown): string | null {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' && v) return String(v);
  return null;
}

export function detectCodeArtsVersion(): string | null {
  for (const base of _codeartsSearchBases) {
    const p = join(base, 'resources', 'app', 'package.json');
    try {
      if (existsSync(p)) {
        return versionText(jsonField(JSON.parse(readFileSync(p, 'utf8')), 'version'));
      }
    } catch {
      // unreadable or corrupt package.json counts this candidate as absent; try the next base
    }
  }
  for (let d = 'A'.charCodeAt(0); d <= 'Z'.charCodeAt(0); d++) {
    const drive = String.fromCharCode(d) + ':';
    try {
      const p = join(drive, '/', 'Program Files', 'CodeArts Agent', 'resources', 'app', 'package.json');
      if (existsSync(p)) {
        return versionText(jsonField(JSON.parse(readFileSync(p, 'utf8')), 'version'));
      }
    } catch {
      // unreadable or corrupt package.json counts this drive as absent; try the next
    }
  }
  return null;
}

export function detectWorkBuddyVersion(): string | null {
  const username = process.env.USERNAME || basename(homedir());
  const relPath = join('Users', username, 'AppData', 'Local', 'Programs', 'WorkBuddy');

  function tryBase(base: string): string | null {
    const manifest = join(base, 'resources', 'install-manifest.json');
    try {
      if (existsSync(manifest)) {
        const v = versionText(jsonField(JSON.parse(readFileSync(manifest, 'utf8')), 'appVersion'));
        if (v) return `v${v}`;
      }
    } catch {
      // unreadable or corrupt manifest falls through to the plain version file
    }
    const verFile = join(base, 'version');
    try {
      if (existsSync(verFile)) return readFileSync(verFile, 'utf8').trim() || null;
    } catch {
      // unreadable version file means version unknown; telemetry must never fail
    }
    return null;
  }

  const localApp = join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy');
  const r = tryBase(localApp);
  if (r) return r;

  for (let d = 'A'.charCodeAt(0); d <= 'Z'.charCodeAt(0); d++) {
    const drive = String.fromCharCode(d) + ':';
    const r2 = tryBase(join(drive, '/', relPath));
    if (r2) return r2;
  }

  return null;
}

export function detectOfficeAceVersion(): string | null {
  if (process.env.OFFICEACE_VERSION) return process.env.OFFICEACE_VERSION;

  function tryReleaseAt(base: string): string | null {
    const releaseFile = join(base, '.office-claw-release.json');
    try {
      if (existsSync(releaseFile)) {
        const v = versionText(jsonField(JSON.parse(readFileSync(releaseFile, 'utf8')), 'version'));
        if (v) return `V${v}`;
      }
    } catch {
      // unreadable or corrupt release file means version unknown; telemetry must never fail
    }
    return null;
  }

  // 1. LOCALAPPDATA (works when child process inherits the right env)
  if (process.env.LOCALAPPDATA) {
    const r = tryReleaseAt(join(process.env.LOCALAPPDATA, 'Programs', 'OfficeAce'));
    if (r) return r;
  }

  // 2. Reconstruct LOCALAPPDATA from USERPROFILE (fallback when env differs)
  const up = process.env.USERPROFILE || process.env.HOME || homedir();
  if (up) {
    const r = tryReleaseAt(join(up, 'AppData', 'Local', 'Programs', 'OfficeAce'));
    if (r) return r;
  }

  // 3. Scan all drives (same strategy as WorkBuddy, handles off-system-drive installs)
  const username = process.env.USERNAME || basename(homedir());
  for (let d = 'A'.charCodeAt(0); d <= 'Z'.charCodeAt(0); d++) {
    const drive = String.fromCharCode(d) + ':';
    const r = tryReleaseAt(join(drive, '/', 'Users', username, 'AppData', 'Local', 'Programs', 'OfficeAce'));
    if (r) return r;
  }

  return null;
}
