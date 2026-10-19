import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import type { AgentDriver, DriverContext, DriverProbe, RunRequest, RunResult } from './types.ts';
import { opencodeSeamVersionSupported } from '../../../plugins/huaweicloud-core/src/lib/opencode-permission-seam.ts';

// opencode adapter. Auth is a dedicated E2E key injected via env
// (E2E_APIKEY or E2E_TEST_API_KEY) — real auth files are never copied into
// throwaway dirs. Model and provider are pinned per run so nightly failures
// are attributable (model drift is a suite event, not a mystery).
const APIKEY_ENV_VARS = ['E2E_APIKEY', 'E2E_TEST_API_KEY'] as const;

function apiKeyEnvVar(): string | null {
  for (const key of APIKEY_ENV_VARS) {
    if (process.env[key]) return key;
  }
  return null;
}

function requiredEnv(): { missing: string[]; apiKeyVar: string } {
  const apiKeyVar = apiKeyEnvVar();
  const apiKeyVarFinal = apiKeyVar ?? 'E2E_APIKEY';
  const missing = ['E2E_PROVIDER_ID', 'E2E_PROVIDER_BASEURL', 'E2E_MODEL'].filter((key) => !process.env[key]);
  if (!apiKeyVar) missing.push(APIKEY_ENV_VARS.join(' or '));
  return { missing, apiKeyVar: apiKeyVarFinal };
}

function resolveCommand(name: string): string | null {
  const direct = spawnSync(name, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (direct.status === 0 || direct.stdout) return name;
  return null;
}

// The free-choice skill cases exercise the direct-read default, which needs
// the installer's permission seam to land (outside-workspace reads are
// gated; an unapproved ask has no interactive approver under `opencode run`).
// The seam writes only on opencode at or above the measured floor (1.19.0,
// a knowledge boundary), so the driver refuses to run on older binaries —
// a loud skip, never a silent no-allow posture that would misattribute
// fallback behavior to the teaching. The floor check is imported from the
// seam's pure module (no drift when the floor moves), and the probe spawn
// pins XDG_CONFIG_HOME to a throwaway dir — opencode initializes its config
// root on every run, and the probe must not touch the developer's real one.
function opencodeVersionSupported(): { ok: boolean; detail: string } {
  let probeRoot: string;
  try {
    probeRoot = mkdtempSync(join(tmpdir(), 'devkit-e2e-opencode-'));
  } catch {
    return { ok: false, detail: 'could not create a probe temp dir' };
  }
  try {
    const r = spawnSync('opencode', ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, XDG_CONFIG_HOME: probeRoot },
    });
    const out = r.stdout?.toString() ?? '';
    const version = /v?\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
    if (!opencodeSeamVersionSupported(version)) {
      return {
        ok: false,
        detail: `opencode ${version ?? '(unparsable: ' + (out.trim() || 'no output') + ')'} predates the measured permission-seam floor`,
      };
    }
    return { ok: true, detail: `opencode ${version}` };
  } finally {
    try {
      rmSync(probeRoot, { recursive: true, force: true });
    } catch {
      // best-effort: a leftover probe dir is inert
    }
  }
}

function opencodeConfigFile(home: string): string {
  const jsonc = join(home, '.config', 'opencode', 'opencode.jsonc');
  if (existsSync(jsonc)) return jsonc;
  return join(home, '.config', 'opencode', 'opencode.json');
}

export const opencodeDriver: AgentDriver = {
  id: 'opencode',
  installTarget: 'opencode',

  probe(): DriverProbe {
    const command = resolveCommand('opencode');
    if (!command) {
      return { ok: false, detail: 'opencode binary not found on PATH', command: null };
    }
    const version = opencodeVersionSupported();
    if (!version.ok) {
      return { ok: false, command, detail: `${version.detail} — the free-choice skill cases need the permission seam` };
    }
    const { missing, apiKeyVar } = requiredEnv();
    if (missing.length > 0) {
      return {
        ok: false,
        command,
        detail: `missing environment: ${missing.join(', ')}. Set a dedicated E2E key (never the real auth file) plus provider/model pins.`,
      };
    }
    return { ok: true, command, detail: `opencode ready, ${version.detail} (auth via ${apiKeyVar})` };
  },

  prepare(ctx: DriverContext): NodeJS.ProcessEnv {
    const providerId = process.env.E2E_PROVIDER_ID!;
    const baseURL = process.env.E2E_PROVIDER_BASEURL!;
    const model = process.env.E2E_MODEL!;
    const apiKeyVar = requiredEnv().apiKeyVar;
    const apiKey = process.env[apiKeyVar];
    const configPath = opencodeConfigFile(ctx.home);
    mkdirSync(dirname(configPath), { recursive: true });
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      } catch {
        config = {};
      }
    }
    const provider = (config.provider as Record<string, unknown> | undefined) ?? {};
    provider[providerId] = {
      npm: '@ai-sdk/openai-compatible',
      name: providerId,
      options: {
        baseURL,
      },
      models: {
        [model]: { name: model },
      },
    };
    config.provider = provider;
    config.model = `${providerId}/${model}`;
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    // Auth rides opencode's own storage shape (auth.json in XDG data, which
    // the env policy relocates into the throwaway home). The key is read
    // from the environment and lands only here, 0600, never in output.
    const authDir = join(ctx.home, '.local', 'share', 'opencode');
    mkdirSync(authDir, { recursive: true });
    const authPath = join(authDir, 'auth.json');
    let auth: Record<string, unknown> = {};
    if (existsSync(authPath)) {
      try {
        auth = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>;
      } catch {
        auth = {};
      }
    }
    auth[providerId] = { type: 'api', key: apiKey };
    writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600, encoding: 'utf8' });
    return {};
  },

  async runPrompt(req: RunRequest): Promise<RunResult> {
    return new Promise<RunResult>((resolveRun) => {
      const child = spawn('opencode', ['run', req.prompt], {
        cwd: req.cwd,
        env: req.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveRun({
          exitCode,
          stdout,
          stderr,
          finalText: stdout.trim() ? stdout : null,
        });
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
  },
};
