import { spawnSync } from 'node:child_process';

import { resolveAgentartsCommand, pinnedSdkVersion } from './agentarts-cli.mjs';

const VERSION_OUTPUT_RE = /^agentarts version:\s*(\S+)/m;

// Process-level probe cache: the CLI's install state does not change within
// a server process, and an uncached probe would add a Python interpreter
// cold-start (and a worst-case 5s hang) to every auth_status call.
let cachedProbe = null;

// Probe the agentarts CLI: resolve AGENTARTS_BIN || PATH, run `--version`
// (local metadata, no cloud call), and compare against the pinned
// agentartsSdkVersion (resolved by pinnedSdkVersion — policy.json first,
// package.json fallback, never throws). Mirrors the hcloud probe contract:
// structured result, never throws.
export function probeAgentarts(options = {}) {
  if (cachedProbe && !options.force) return cachedProbe;
  const executable = resolveAgentartsCommand();
  const timeoutMs = options.timeoutMs ?? 5_000;
  let result;
  try {
    result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  } catch {
    cachedProbe = {
      installed: false,
      executable,
      reason: 'probe-failed',
      version: null,
      versionMatches: null,
      pinned: pinnedSdkVersion(),
    };
    return cachedProbe;
  }
  if (result.error) {
    cachedProbe = {
      installed: false,
      executable,
      reason: 'not-found',
      version: null,
      versionMatches: null,
      pinned: pinnedSdkVersion(),
    };
    return cachedProbe;
  }
  const match = VERSION_OUTPUT_RE.exec(`${result.stdout}\n${result.stderr}`);
  if (!match) {
    cachedProbe = {
      installed: true,
      executable,
      reason: 'version-unreadable',
      version: null,
      versionMatches: null,
      pinned: pinnedSdkVersion(),
    };
    return cachedProbe;
  }
  const version = match[1];
  const pinned = pinnedSdkVersion();
  cachedProbe = {
    installed: true,
    executable,
    reason: null,
    version,
    versionMatches: pinned ? version === pinned : null,
    pinned,
  };
  return cachedProbe;
}

function probePython() {
  const bin = process.platform === 'win32' ? 'python' : 'python3';
  try {
    const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (result.error) return { installed: false, version: null, ok: false };
    const match = /Python (\d+)\.(\d+)/.exec(`${result.stdout}\n${result.stderr}`);
    if (!match) return { installed: true, version: null, ok: false };
    const major = Number(match[1]);
    const minor = Number(match[2]);
    // agentarts-sdk requires Python 3.10+ (SDK README).
    return { installed: true, version: `${major}.${minor}`, ok: major > 3 || (major === 3 && minor >= 10) };
  } catch {
    return { installed: false, version: null, ok: false };
  }
}

function probeDocker() {
  try {
    const result = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    return { installed: !result.error && result.status === 0, reason: result.error ? 'not-found' : null };
  } catch {
    return { installed: false, reason: 'probe-failed' };
  }
}

// Full agentarts environment check for doctor and auth_status reporting.
// Every check is advisory (soft): agentarts is an optional dependency of the
// toolkit, so doctor warns instead of failing the run.
export function checkAgentarts(options = {}) {
  const cli = probeAgentarts(options);
  const python = probePython();
  const docker = probeDocker();
  const warnings = [];
  const nextSteps = [];
  if (!cli.installed) {
    warnings.push('agentarts CLI not found');
    nextSteps.push(
      `pip install agentarts-sdk==${cli.pinned || 'the pinned version'} (set AGENTARTS_BIN when installed outside PATH)`,
    );
  } else if (cli.pinned && cli.versionMatches === false) {
    warnings.push(`agentarts ${cli.version} != pinned ${cli.pinned}`);
    nextSteps.push(`pip install agentarts-sdk==${cli.pinned}`);
  }
  if (cli.installed && !python.ok) {
    warnings.push(
      python.installed ? `Python ${python.version} < 3.10 (agentarts-sdk requirement)` : 'Python not found',
    );
    nextSteps.push('Install Python 3.10+ and recreate the agentarts venv');
  }
  if (cli.installed && !docker.installed) {
    warnings.push('Docker not found — agentarts launch (image build) will not work');
    nextSteps.push('Install Docker (https://docs.docker.com/engine/install/)');
  }
  return {
    ok: warnings.length === 0,
    advisory: true,
    cli,
    python,
    docker,
    warnings,
    nextSteps,
  };
}
