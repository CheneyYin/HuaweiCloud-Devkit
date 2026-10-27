// Shared harness plumbing for the runner family: repo paths, the output
// channel, the gitignored model-config loader, and the stale-temp
// self-healing sweep. Every runner family module starts from these.
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
export const TEMP_PREFIX = 'hwc-e2e-';

export function packageJson(): { version: string; kooCliVersion: string } {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; kooCliVersion: string };
}

export function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

// Local, gitignored model config (test/e2e/.env): KEY=VALUE lines, no
// interpolation. Loaded only for vars not already in the environment, so an
// explicit env or CI secret always wins over the file. Values never appear
// in runner output or the report — only var names in probe errors.
export function loadDotEnv(): void {
  const dotenv = join(root, 'test', 'e2e', '.env');
  if (!existsSync(dotenv)) return;
  for (const line of readFileSync(dotenv, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// Signal death (SIGKILL and friends) skips every exit handler, so a crashed
// nightly can leak throwaway homes. The next run sweeps them: same prefix,
// older than a day — self-healing instead of accumulating.
export function sweepStaleTempDirs(): void {
  const dir = tmpdir();
  const dayMs = 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    const full = join(dir, entry);
    try {
      if (Date.now() - statSync(full).mtimeMs > dayMs) rmSync(full, { recursive: true, force: true });
    } catch {
      // best-effort sweep
    }
  }
}
