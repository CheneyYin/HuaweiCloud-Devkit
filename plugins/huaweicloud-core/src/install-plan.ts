// The install-target planning family, extracted from setup-cli.ts: agent
// presence detection, the --target parser with auto-detect fallback, and
// resolveInstallTarget (the interactive planning entry). The readline
// prompts live in install-prompts.ts; the generic-MCP-agent path in
// mcp-agent-config.ts.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SUPPORTED_AGENT_TARGETS } from './auth/agent-registration.ts';
import { configRoot, atomcodeHome, hermesHomeDir } from './targets.ts';
import { officeaceCapabilitiesDir } from './officeace-paths.ts';
import { promptSelectAgents, promptZeroDetect, type InstallPlan } from './install-prompts.ts';

function detectAgents(): string[] {
  const checks: Array<[string, () => boolean]> = [
    ['opencode', () => existsSync(configRoot('opencode'))],
    ['codex-desktop', () => existsSync(join(homedir(), '.codex'))],
    ['codearts', () => existsSync(join(homedir(), '.codeartsdoer'))],
    ['codearts-work', () => existsSync(join(homedir(), '.codeartswork'))],
    ['workbuddy', () => existsSync(join(homedir(), '.workbuddy'))],
    [
      'dsh',
      () => {
        const dsh = process.env.DSH_HOME || join(homedir(), '.dsh');
        return existsSync(dsh);
      },
    ],
    // existsSync rejects non-string paths; officeaceCapabilitiesDir() returning
    // null means "no OfficeAce" exactly like the original existsSync(null) did.
    [
      'officeace',
      () => {
        const dir = officeaceCapabilitiesDir();
        return dir !== null && existsSync(dir);
      },
    ],
    ['hermes', () => existsSync(hermesHomeDir())],
    ['openclaw', () => existsSync(join(homedir(), '.openclaw'))],
    ['atomcode', () => existsSync(atomcodeHome())],
  ];
  return checks.filter(([, check]) => check()).map(([name]) => name);
}

function autoDetectTarget(): string {
  const detected = detectAgents();
  if (detected.length === 0) {
    console.error('No supported agent detected.');
    console.error(`Supported: ${SUPPORTED_AGENT_TARGETS.join(', ')} (or "all")`);
    console.error('Use --target <agent> to specify.');
    process.exit(1);
  }
  if (detected.length === 1) return detected[0]!;
  return 'all';
}

export function parseTarget(): string {
  const idx = process.argv.indexOf('--target');
  if (idx < 0) return autoDetectTarget();
  const val = (process.argv[idx + 1] || '').toLowerCase();
  if (val === 'all' || SUPPORTED_AGENT_TARGETS.includes(val)) return val;
  console.error(`Unknown target: ${val}`);
  console.error(`Supported: ${SUPPORTED_AGENT_TARGETS.join(', ')} (or "all")`);
  process.exit(1);
}

export async function resolveInstallTarget(): Promise<InstallPlan> {
  const idx = process.argv.indexOf('--target');
  if (idx >= 0) {
    const val = (process.argv[idx + 1] || '').toLowerCase();
    if (val === 'all' || SUPPORTED_AGENT_TARGETS.includes(val)) {
      return { explicit: true, target: val };
    }
    console.error(`Unknown target: ${val}`);
    console.error(`Supported: ${SUPPORTED_AGENT_TARGETS.join(', ')} (or "all")`);
    process.exit(1);
  }
  const detected = detectAgents();
  if (detected.length === 1) return { explicit: true, target: detected[0] };
  if (detected.length === 0) return promptZeroDetect();
  const chosen = await promptSelectAgents(detected);
  if (!chosen) return { abort: true };
  return { explicit: false, subset: chosen };
}
