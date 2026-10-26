// Installed-version reading for the update machinery: the package.json
// candidates plus the plugin-manifest fallbacks (#576). Root-level on purpose:
// selfDir() climbs exactly one level, which resolves the plugin root
// identically in the src tree, the dist tree, and the esbuild bundle (the
// skill-disclosure.ts doctrine). Part of the src/update-* family behind the
// src/update-check.ts re-export face.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function selfDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

// Plugin manifests also carry the version and are kept in sync with package.json
// by `npm run validate`. Codex marketplace installs (`.codex/plugins/cache/...`)
// contain only the plugin directory — no package.json — so fall back to these
// manifests when neither candidate package.json exists (#576).
const VERSION_MANIFEST_RELS = [
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.workbuddy-plugin/plugin.json',
  '.hermes-plugin/plugin.json',
  'openclaw.plugin.json',
];

// JSON boundary: non-object payloads (null, numbers) fold to null — the previous
// inline property access threw and was caught, same observable result.
function readJsonVersion(file: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const version = (parsed as Record<string, unknown>).version;
    return typeof version === 'string' && version ? version : null;
  } catch {
    return null;
  }
}

export function readInstalledVersion(): string | null {
  const pluginRoot = resolve(selfDir(), '..');
  const packageRoot = resolve(pluginRoot, '..', '..');
  for (const base of [pluginRoot, packageRoot]) {
    const version = readJsonVersion(join(base, 'package.json'));
    if (version) return version;
  }
  for (const rel of VERSION_MANIFEST_RELS) {
    const version = readJsonVersion(join(pluginRoot, rel));
    if (version) return version;
  }
  return null;
}
