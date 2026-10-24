// Shared fixtures for the secret-vault store and custody tests, extracted
// from secret-vault.test.ts: the ENOENT spawner (store tests), the fake
// keychain spawner (custody tests), and the fresh-root/opts seams.
import { spawnSync } from 'node:child_process';

import { fixtureDir } from './fixture-dir.ts';
import { clearCustodyCache, VaultCustodyError } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { VaultError } from '../plugins/huaweicloud-core/src/lib/secret-vault/store.ts';

// roots. Keychain tiers run against injected fake spawners (the secret-tool /
// security / powershell contracts); the keyfile tier is exercised for real.

export const ENOENT_SPAWN = (() => {
  const impl = () => ({
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException,
  });
  return impl as unknown as typeof spawnSync;
})();

export function fakeKeychainSpawn(stored: { b64?: string } = {}, failureStderr?: string) {
  const impl = (
    _command: string,
    args: string[],
    options: { input?: Buffer | string },
  ): { status: number | null; stdout: string; stderr: string } => {
    const input = options.input === undefined ? '' : Buffer.from(options.input).toString('utf8');
    if (process.platform === 'win32') {
      // The Windows PasswordVault contract (custody.ts windowsRead/Write):
      // powershell.exe -Command - reads the script from stdin; exit 3 is
      // the vault answering with no item, exit 2 a real failure.
      if (input.includes('RetrieveAll')) {
        if (failureStderr !== undefined) return { status: 2, stdout: '', stderr: failureStderr };
        if (stored.b64 === undefined) return { status: 3, stdout: '', stderr: '' };
        return { status: 0, stdout: `${stored.b64}\n`, stderr: '' };
      }
      if (input.includes('ConvertTo-SecureString')) {
        const match = input.match(/-String '([^']+)'/);
        if (match) stored.b64 = match[1]!;
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 2, stdout: '', stderr: `unexpected script: ${input.slice(0, 80)}` };
    }
    if (args[0] === 'lookup') {
      if (failureStderr !== undefined) return { status: 1, stdout: '', stderr: failureStderr };
      // The secret-tool contract: a silent non-zero exit is not-found.
      if (stored.b64 === undefined) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: `${stored.b64}\n`, stderr: '' };
    }
    if (args[0] === 'store') {
      stored.b64 = input.trim();
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected args: ${args.join(' ')}` };
  };
  return impl as unknown as typeof spawnSync;
}

export function freshRoot(): string {
  const root = fixtureDir('secret-vault-');
  clearCustodyCache(root);
  return root;
}

// Every store test injects the ENOENT spawner so a dev machine with a real
// secret-tool never gains a devkit vault-master key from the test run.
export function opts(root: string): { root: string; spawnImpl: typeof spawnSync } {
  return { root, spawnImpl: ENOENT_SPAWN };
}

export function vaultErrorCode(error: unknown): string {
  return error instanceof VaultError || error instanceof VaultCustodyError ? error.code : String(error);
}
