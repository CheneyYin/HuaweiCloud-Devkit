import { spawn, spawnSync } from 'node:child_process';

import type { RunRequest } from './types.ts';

// Shared driver plumbing. Every driver owns the same agent-independent
// mechanics: a shared model-env requirement vocabulary, a PATH probe, and a
// detached process-group spawn whose whole tree (agent → MCP server → fake
// children) can be torn down on timeout or abort — the RunRequest.signal
// contract every adapter owes. Agent-specific knowledge (config shape,
// invocation flags, final-text extraction) stays in the adapter.

const APIKEY_ENV_VARS = ['E2E_APIKEY', 'E2E_TEST_API_KEY'] as const;

function apiKeyEnvVar(): string | null {
  for (const key of APIKEY_ENV_VARS) {
    if (process.env[key]) return key;
  }
  return null;
}

// Model and provider stay pinned per run so failures are attributable.
// The key may ride either spelling; the caller resolves which one.
export function requiredModelEnv(): { missing: string[]; apiKeyVar: string } {
  const key = apiKeyEnvVar();
  const apiKeyVar = key ?? 'E2E_APIKEY';
  const missing = ['E2E_PROVIDER_ID', 'E2E_PROVIDER_BASEURL', 'E2E_MODEL'].filter((name) => !process.env[name]);
  if (!key) missing.push(APIKEY_ENV_VARS.join(' or '));
  return { missing, apiKeyVar };
}

export function resolveCommand(name: string): string | null {
  const direct = spawnSync(name, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (direct.status === 0 || direct.stdout) return name;
  return null;
}

// Detached headless run: capture the streams, resolve on exit, and kill the
// whole process group when the case budget fires or the runner aborts. The
// caller derives finalText from whichever surface its agent exposes.
export function runHeadlessAgent(
  command: string,
  args: string[],
  req: RunRequest,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: req.cwd,
      env: req.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // the tree may already be gone
      }
    }, req.timeoutMs);
    req.signal.addEventListener(
      'abort',
      () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // best-effort tree teardown
        }
      },
      { once: true },
    );
    child.on('error', (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
