// Agent version detection for the telemetry family: the AGENT_VERSION env
// override, the package-tree detectors (DSH, Hermes), and the
// VERSION_DETECTORS dispatch behind AgentDefinition.version. The
// desktop-agent install-location probes (CodeArts, WorkBuddy, OfficeAce)
// and the shared JSON readers live in agent-versions-desktop.ts;
// agent-registry.ts (the data face) re-exports detectVersion unchanged.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentVersionConfig } from './agent-registry.ts';
import {
  detectCodeArtsVersion,
  detectOfficeAceVersion,
  detectWorkBuddyVersion,
  jsonField,
  versionText,
} from './agent-versions-desktop.ts';

function detectDshVersion(): string | null {
  const candidates: string[] = [];
  // Standard npm global location
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  }
  candidates.push(join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  // Hermes-bundled DSH (Windows)
  if (process.env.LOCALAPPDATA) {
    candidates.push(
      join(process.env.LOCALAPPDATA, 'hermes', 'node', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    );
  }
  // DSH_HOME override
  if (process.env.DSH_HOME) {
    candidates.push(join(process.env.DSH_HOME, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    candidates.push(join(process.env.DSH_HOME, 'package.json'));
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        return versionText(jsonField(JSON.parse(readFileSync(p, 'utf8')), 'version'));
      }
    } catch {
      // unreadable or corrupt package.json counts this candidate as absent; version stays unknown
    }
  }
  return null;
}

function detectHermesVersion(): string | null {
  if (process.env.HERMES_VERSION) return process.env.HERMES_VERSION;
  const candidates: string[] = [];
  if (process.env.HERMES_HOME) candidates.push(process.env.HERMES_HOME);
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'hermes', 'hermes-agent'));
  candidates.push(join(homedir(), '.hermes', 'hermes-agent'));
  for (const base of candidates) {
    try {
      const initFile = join(base, 'hermes_cli', '__init__.py');
      if (existsSync(initFile)) {
        const content = readFileSync(initFile, 'utf8');
        const m = content.match(/__version__\s*=\s*['"]([^'"]+)['"]/);
        if (m) return m[1]!;
      }
    } catch {
      // unreadable or corrupt __init__.py counts this candidate as absent; version stays unknown
    }
  }
  return null;
}

const VERSION_DETECTORS: Record<string, () => string | null> = {
  codearts: detectCodeArtsVersion,
  dsh: detectDshVersion,
  hermes: detectHermesVersion,
  workbuddy: detectWorkBuddyVersion,
  officeace: detectOfficeAceVersion,
};

export function detectVersion(versionConfig: AgentVersionConfig | null): string | null {
  if (process.env.AGENT_VERSION) return process.env.AGENT_VERSION;
  if (!versionConfig) return null;
  const fn = VERSION_DETECTORS[versionConfig.type];
  return fn ? fn() : null;
}
