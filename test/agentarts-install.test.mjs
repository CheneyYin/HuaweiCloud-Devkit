import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  AGENTARTS_SDK_MIRROR,
  agentartsVenvBin,
  agentartsVenvDir,
  pinnedSdkVersion,
} from '../plugins/huaweicloud-core/src/agentarts-cli.mjs';
import { installAgentartsSdk, removeAgentartsVenv } from '../plugins/huaweicloud-core/src/agentarts-install.mjs';

// The installer's invariants (docs/agentarts-pr0-findings.md traps 1-2):
// pip runs through the VENV's own python — never a PATH pip — and the
// agentarts BINARY is never executed (any first execution writes HOME
// files). Tests inject `run` and `python`, so no real interpreter is needed.
const PYTHON_OK = { installed: true, version: '3.12', ok: true };

function withScratchHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'agentarts-install-'));
  const previousHome = process.env.HUAWEICLOUD_HOME;
  const previousBin = process.env.AGENTARTS_BIN;
  process.env.HUAWEICLOUD_HOME = home;
  delete process.env.AGENTARTS_BIN;
  try {
    return fn(home);
  } finally {
    if (previousHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = previousHome;
    if (previousBin === undefined) delete process.env.AGENTARTS_BIN;
    else process.env.AGENTARTS_BIN = previousBin;
    rmSync(home, { recursive: true, force: true });
  }
}

// The success-path CLI-existence check reads the real filesystem: represent
// the completed venv before calling the installer.
function scaffoldVenvCli() {
  mkdirSync(dirname(agentartsVenvBin()), { recursive: true });
  writeFileSync(agentartsVenvBin(), 'stub', { mode: 0o755 });
}

function recordingRunner(statusFor) {
  const calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args, options });
    return { status: statusFor(calls.length, file, args), error: null };
  };
  return { calls, run };
}

const venvPythonPath = () =>
  join(agentartsVenvDir(), process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python'));

test('installAgentartsSdk venv-creates then pip-installs the pinned spec via the venv python', () => {
  withScratchHome(() => {
    scaffoldVenvCli();
    const { calls, run } = recordingRunner(() => 0);
    const result = installAgentartsSdk({ run, python: PYTHON_OK });
    assert.equal(result.ok, true);
    assert.equal(result.usedMirror, true);
    assert.equal(result.pinned, pinnedSdkVersion());
    // venv creation via the system python…
    assert.equal(calls[0].file, process.platform === 'win32' ? 'python' : 'python3');
    assert.deepEqual(calls[0].args, ['-m', 'venv', agentartsVenvDir()]);
    // …then pip through the VENV's own python with the mirror and the pin.
    assert.equal(calls[1].file, venvPythonPath());
    assert.deepEqual(calls[1].args, [
      '-m',
      'pip',
      'install',
      `agentarts-sdk==${pinnedSdkVersion()}`,
      '-i',
      AGENTARTS_SDK_MIRROR,
    ]);
  });
});

test('installAgentartsSdk NEVER executes the agentarts binary (first-run HOME-write traps)', () => {
  withScratchHome(() => {
    scaffoldVenvCli();
    const { calls, run } = recordingRunner(() => 0);
    installAgentartsSdk({ run, python: PYTHON_OK });
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.ok(!/(^|[\\/])agentarts(\.exe)?$/.test(call.file), `installer executed the CLI binary: ${call.file}`);
    }
  });
});

test('a mirror failure falls back to official PyPI exactly once', () => {
  withScratchHome(() => {
    scaffoldVenvCli();
    const { calls, run } = recordingRunner((index) => (index === 2 ? 1 : 0));
    const result = installAgentartsSdk({ run, python: PYTHON_OK });
    assert.equal(result.ok, true);
    assert.equal(result.usedMirror, false);
    assert.equal(calls.length, 3);
    assert.ok(calls[1].args.includes('-i'));
    assert.ok(calls[1].args.includes(AGENTARTS_SDK_MIRROR));
    assert.ok(!calls[2].args.includes('-i'));
    assert.ok(!calls[2].args.includes(AGENTARTS_SDK_MIRROR));
  });
});

test('missing or too-old Python fails at the python step without spawning anything', () => {
  withScratchHome(() => {
    for (const python of [
      { installed: false, version: null, ok: false },
      { installed: true, version: '3.9', ok: false },
    ]) {
      const { calls, run } = recordingRunner(() => 0);
      const result = installAgentartsSdk({ run, python });
      assert.equal(result.ok, false);
      assert.equal(result.step, 'python');
      assert.match(result.reason, /Python/);
      assert.equal(calls.length, 0);
    }
  });
});

test('venv, pip, and missing-CLI failures map to their steps', () => {
  withScratchHome(() => {
    const isVenv = (args) => args[1] === 'venv';
    // venv creation fails.
    let result = installAgentartsSdk({
      run: (file, args) => (isVenv(args) ? { status: 1 } : { status: 0 }),
      python: PYTHON_OK,
    });
    assert.equal(result.step, 'venv');
    assert.equal(result.ok, false);
    // both pip attempts fail.
    result = installAgentartsSdk({
      run: (file, args) => (isVenv(args) ? { status: 0 } : { status: 1 }),
      python: PYTHON_OK,
    });
    assert.equal(result.step, 'pip');
    assert.equal(result.ok, false);
    // pip succeeds but the CLI file never appeared (no scaffold).
    result = installAgentartsSdk({ run: () => ({ status: 0 }), python: PYTHON_OK });
    assert.equal(result.step, 'cli');
    assert.equal(result.ok, false);
  });
});

test('re-running over an existing venv converges (idempotent)', () => {
  withScratchHome(() => {
    scaffoldVenvCli();
    const { calls, run } = recordingRunner(() => 0);
    const first = installAgentartsSdk({ run, python: PYTHON_OK });
    const second = installAgentartsSdk({ run, python: PYTHON_OK });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    // `python -m venv` over an existing venv and `pip install <satisfied
    // spec>` both succeed on re-runs — no error state survives.
    assert.equal(calls.length, 4);
  });
});

test('removeAgentartsVenv removes the venv and is a no-op when absent', () => {
  withScratchHome(() => {
    assert.deepEqual(removeAgentartsVenv(), {
      removed: false,
      dir: agentartsVenvDir(),
      reason: 'not-found',
    });
    mkdirSync(agentartsVenvDir(), { recursive: true });
    writeFileSync(join(agentartsVenvDir(), 'pyvenv.cfg'), '');
    const result = removeAgentartsVenv();
    assert.equal(result.removed, true);
    assert.equal(result.dir, agentartsVenvDir());
    assert.ok(!existsSync(agentartsVenvDir()));
  });
});
