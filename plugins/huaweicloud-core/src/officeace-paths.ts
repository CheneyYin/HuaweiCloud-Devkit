// Shared OfficeAce config-root resolution used by both the installer
// (setup-cli.ts) and the MCP runtime (tools.ts), so skills are installed
// to and read from the same location (#559).
//
// OfficeAce exposes no API for the plugin to query the current user or
// install directory, so the root is located by probing. The probe result is
// persisted in a marker file so a non-standard directory (entered via prompt,
// whose OFFICE_CLAW_CONFIG_ROOT env does not survive across processes) is
// still found by later uninstall/update runs.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';

function markerPath(): string {
  return join(process.env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud', 'devkit-officeace-root.json');
}

function sqliteSibling(dir: string): string {
  return join(resolve(dir, '..'), 'data', 'mcp-connectors.sqlite');
}

// A directory is a usable OfficeAce config root when it exists and carries
// OfficeAce evidence — capabilities.json, the connector DB, or DevKit's own
// installed artifacts. Deliberately more lenient than "capabilities.json must
// exist" so uninstall/update still find the root after it was removed.
export function isUsableOfficeaceRoot(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false;
  return (
    existsSync(join(dir, 'capabilities.json')) ||
    existsSync(sqliteSibling(dir)) ||
    existsSync(join(dir, 'skills')) ||
    existsSync(join(dir, 'huaweicloud-plugins'))
  );
}

export function readOfficeaceRootMarker(): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath(), 'utf8'));
    const root =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'root' in parsed
        ? parsed.root
        : undefined;
    return typeof root === 'string' && isUsableOfficeaceRoot(root) ? root : null;
  } catch {
    return null;
  }
}

export function writeOfficeaceRootMarker(root: string): void {
  try {
    mkdirSync(dirname(markerPath()), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({ root, savedAt: new Date().toISOString() }, null, 2));
  } catch {
    // best-effort: a missing marker just means later runs re-probe for the OfficeAce root
  }
}

// The Windows-side system probe shared by the installer (setup-cli.ts) and
// the MCP-side detection (auth/agent-registration.ts): the OfficeAce install
// dir from the HKCU registry. The caller owns the root-usable predicate and
// the env/marker/skip ordering around the probe.
export function readOfficeaceRegistryInstallDir(): string | null {
  if (platform() !== 'win32') return null;
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\SOFTWARE\\OfficeAce\\OfficeAce', '/v', 'InstallDir'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (r.status === 0) {
      const m = r.stdout.match(/InstallDir\s+REG_SZ\s+(.+)/);
      if (m) return m[1]!.trim();
    }
  } catch {
    // best-effort probe: reg query failure just means no registry install dir
  }
  return null;
}

// Registry install dir plus the standard Program Files bases, parameterized
// by the caller's root-usable predicate — the installer accepts any OfficeAce
// evidence (isUsableOfficeaceRoot), agent-registration requires
// capabilities.json. Order (registry before Program Files) matches both
// call sites' original inline probes.
export function probeOfficeaceSystemDirs(rootUsable: (dir: string) => boolean): string | null {
  const regDir = readOfficeaceRegistryInstallDir();
  if (regDir) {
    const dir = join(regDir, '.office-claw');
    if (rootUsable(dir)) return dir;
  }
  if (platform() === 'win32') {
    const bases: Array<string | undefined> = [process.env.ProgramFiles, 'C:\\Program Files', 'D:\\Program Files'];
    if (process.env.LOCALAPPDATA) bases.push(join(process.env.LOCALAPPDATA, 'Programs'));
    for (const base of bases) {
      if (!base) continue;
      const dir = join(base, 'OfficeAce', '.office-claw');
      if (rootUsable(dir)) return dir;
    }
  }
  return null;
}
