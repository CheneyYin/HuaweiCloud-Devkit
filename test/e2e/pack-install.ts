// The tarball → prefix install chain: pack the repo, install it into a
// throwaway prefix, and run the installer inside a case session.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { npm, out, root, TEMP_PREFIX } from './harness.ts';

export function npmPackTarball(): string {
  out('[runner] npm pack (staging swap — do not run pack:verify concurrently)');
  const packed = JSON.parse(execFileSync(npm, ['pack', '--json'], { encoding: 'utf8', cwd: root })) as {
    filename: string;
  }[];
  return join(root, packed[0]!.filename);
}

export function installPrefix(tarball: string): string {
  const prefix = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}prefix-`));
  execFileSync(npm, ['install', '--no-audit', '--no-fund', tarball], { cwd: prefix, stdio: 'ignore' });
  return prefix;
}

export function runInstall(
  bin: string,
  home: string,
  workdir: string,
  env: NodeJS.ProcessEnv,
  installTarget: string,
  installPacks?: string,
): void {
  const args = ['install', '--target', installTarget];
  if (installPacks) args.push('--packs', installPacks);
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: workdir,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (res.status !== 0) {
    throw new Error(`install failed (exit ${res.status}): ${String(res.stderr || res.stdout).slice(0, 400)}`);
  }
}
