import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The layout roots + version + small shared utils of the payload family (the
// install-payload.ts internals split). The __dirname one-climb derivation is
// root-level depth-safe: this module sits at src/ ROOT level, so PLUGIN_ROOT
// resolves identically in the src tree, the dist tsc tree, and any consumer —
// never move it into a src/<subdir>/ file (the bundle depth trap) and never
// make it a two-level climb. Every other payload-* sibling imports this leaf;
// no sibling imports the face.

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(__dirname, '..');
export const PACKAGE_ROOT = resolve(PLUGIN_ROOT, '..', '..');

// Every per-agent deploy runs in one of two modes; the word suffix keeps
// the deploy log lines ('installed' vs ' updated') uniform across agents.
export type DeployMode = 'install' | 'update';
export const deployWord = (mode: DeployMode): string => (mode === 'update' ? ' updated' : '');

// The installed package's version — one read for the whole setup-cli graph
// (the banner, the generated plugin-dir package.json, and doctor's
// X-HW-Client-Version comparisons). Missing or corrupt package.json keeps
// the 0.0.0 default.
export const pkgVersion: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, '..', '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // main-thread restriction or unavailable Atomics - fall back to a busy wait
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // spin
    }
  }
}
