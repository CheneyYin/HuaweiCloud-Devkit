import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPolicy as loadPolicyFrom, type Policy } from './policy.ts';

export type { Policy };

// This module lives at src/safety/ — a src SUBDIR — so it runs in three
// layouts with different __dirname depths: the tsc tree (dist/safety/), the
// source tree under the hook's type-stripping fallback (src/safety/), and
// the esbuild bundle, where every inlined module sees the bundle file's own
// URL (dist/mcp-server.js — one level shallower than the tsc shape). A
// fixed-depth '..' climb resolves differently across those shapes, so the
// plugin root is found BY MARKER (the policy.json file this family reads),
// the same doctrine resolvePluginDir applies in telemetry.ts.
function pluginRootDir(startDir: string): string {
  for (const candidate of [join(startDir, '..'), join(startDir, '..', '..')]) {
    if (existsSync(join(candidate, 'safety', 'policy.json'))) return candidate;
  }
  return join(startDir, '..', '..');
}

export function defaultPolicyPath(): string {
  return join(pluginRootDir(dirname(fileURLToPath(import.meta.url))), 'safety', 'policy.json');
}

// The public loadPolicy keeps its no-argument default (the shipped policy);
// the loader in policy.ts stays layout-free with a required path.
export function loadPolicy(path: string = defaultPolicyPath()): Policy {
  return loadPolicyFrom(path);
}

export const DEFAULT_POLICY: Policy = loadPolicy(defaultPolicyPath());
