import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { AGENTARTS_SDK_MIRROR, agentartsVenvBin, agentartsVenvDir, pinnedSdkVersion } from './agentarts-cli.mjs';
import { probePython } from './agentarts-doctor.mjs';

// Devkit-managed agentarts-sdk install (PR6). Opt-in only — the SDK stays an
// optional dependency (doctor is advisory, never fails a run). Measured
// invariants behind the shape (docs/agentarts-pr0-findings.md):
// - pip runs through the VENV's own python (`<venv>/python -m pip`), never a
//   PATH pip: the SDK cannot slide into the user's site-packages.
// - the agentarts BINARY is never executed here. Any first execution (even
//   --version) writes ~/.bashrc, ~/.bash_completions/, ~/.agentarts/, and
//   ~/.huaweicloud/application_id (traps 1-2). Success is verified by the
//   CLI file's existence.
// - mirror-first with ONE official-PyPI fallback (a fresh pin can lag on the
//   mirror; the same posture as the README's npm-mirror guidance).
// - idempotent: `python -m venv` over an existing venv and
//   `pip install <already-satisfied spec>` both converge on re-runs.
const VENV_TIMEOUT_MS = 120_000;
const PIP_TIMEOUT_MS = 300_000;

export function installAgentartsSdk(options = {}) {
  const run =
    options.run || ((file, args, spawnOptions) => spawnSync(file, args, { ...spawnOptions, windowsHide: true }));
  const python = options.python || probePython();
  if (!python.installed || !python.ok) {
    return {
      ok: false,
      step: 'python',
      reason: python.installed
        ? `Python ${python.version} < 3.10 (agentarts-sdk requirement)`
        : 'Python 3.10+ not found',
    };
  }

  const venvDir = agentartsVenvDir();
  const venvPython = join(
    venvDir,
    process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python'),
  );
  const pin = pinnedSdkVersion();
  const spec = pin ? `agentarts-sdk==${pin}` : 'agentarts-sdk';
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';

  const created = run(pythonBin, ['-m', 'venv', venvDir], { stdio: 'inherit', timeout: VENV_TIMEOUT_MS });
  if (created.status !== 0) {
    return {
      ok: false,
      step: 'venv',
      reason: created.error ? created.error.message : `python -m venv exited ${created.status}`,
      venvDir,
    };
  }

  const pipArgs = ['-m', 'pip', 'install', spec];
  let install = run(venvPython, [...pipArgs, '-i', AGENTARTS_SDK_MIRROR], {
    stdio: 'inherit',
    timeout: PIP_TIMEOUT_MS,
  });
  let usedMirror = true;
  if (install.status !== 0) {
    usedMirror = false;
    install = run(venvPython, pipArgs, { stdio: 'inherit', timeout: PIP_TIMEOUT_MS });
  }
  if (install.status !== 0) {
    return {
      ok: false,
      step: 'pip',
      reason: install.error ? install.error.message : `pip install exited ${install.status}`,
      venvDir,
    };
  }

  const cliBin = agentartsVenvBin();
  if (!existsSync(cliBin)) {
    return {
      ok: false,
      step: 'cli',
      reason: 'pip reported success but the agentarts CLI is missing from the venv',
      venvDir,
    };
  }
  return { ok: true, venvDir, cliBin, usedMirror, pinned: pin };
}

// Inverse of installAgentartsSdk for the global-uninstall flow
// (--clean-agentarts / --clean-global / the interactive prompt).
export function removeAgentartsVenv() {
  const dir = agentartsVenvDir();
  if (!existsSync(dir)) return { removed: false, dir, reason: 'not-found' };
  rmSync(dir, { recursive: true, force: true });
  return { removed: true, dir };
}
