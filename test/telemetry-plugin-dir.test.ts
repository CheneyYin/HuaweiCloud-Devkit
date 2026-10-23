import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { resolvePluginDir } from '../plugins/huaweicloud-core/src/telemetry/telemetry.ts';
import { fixtureDir } from './fixture-dir.ts';

// The plugin-dir resolver behind AGENT_TELEMETRY_DIR, pinned across every
// runtime shape the module executes in. The regression this file guards:
// the esbuild bundle collapses each inlined module's import.meta.url to the
// bundle file (<plugin>/dist/mcp-server.js), so a depth-based join would
// resolve one level too high and drop the telemetry dir into the codex
// plugin cache's version PARENT — codex 0.162.1 then resolved the stray
// 'telemetry' sibling as the version and stopped loading the plugin's
// manifest and .mcp.json (installed+enabled in `codex plugin list`, no MCP
// server in any session).

test('resolvePluginDir: esbuild bundle shape (dist/mcp-server.js)', () => {
  const root = fixtureDir('devkit-telemetry-bundle-');
  // The bundle's __dirname is dist/ itself; dist existing under the plugin
  // root is the marker.
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'mcp-server.js'), '');
  assert.equal(resolvePluginDir(join(root, 'dist')), root);
});

test('resolvePluginDir: tsc tree shape (dist/telemetry/telemetry.js)', () => {
  const root = fixtureDir('devkit-telemetry-tsc-');
  mkdirSync(join(root, 'dist', 'telemetry'), { recursive: true });
  writeFileSync(join(root, 'dist', 'telemetry', 'telemetry.js'), '');
  assert.equal(resolvePluginDir(join(root, 'dist', 'telemetry')), root);
});

test('resolvePluginDir: raw source checkout shape (src/telemetry, no dist)', () => {
  const root = fixtureDir('devkit-telemetry-src-');
  mkdirSync(join(root, 'src', 'telemetry'), { recursive: true });
  writeFileSync(join(root, 'src', 'telemetry', 'telemetry.ts'), '');
  // A raw checkout has no dist/; safety/ at the plugin root is the marker.
  mkdirSync(join(root, 'safety'));
  writeFileSync(join(root, 'safety', 'policy.json'), '{}');
  assert.equal(resolvePluginDir(join(root, 'src', 'telemetry')), root);
});

test('resolvePluginDir: codex cache layout never resolves the version parent', () => {
  const cacheRoot = fixtureDir('devkit-telemetry-codex-');
  const versionDir = join(cacheRoot, 'huaweicloud-devkit', 'huaweicloud-devkit', '2.0.0');
  mkdirSync(join(versionDir, 'dist'), { recursive: true });
  writeFileSync(join(versionDir, 'dist', 'mcp-server.js'), '');
  mkdirSync(join(versionDir, 'safety'));
  writeFileSync(join(versionDir, 'safety', 'policy.json'), '{}');
  // The bundle runs from <version>/dist; the resolved plugin dir must be the
  // version dir itself, never its parent — the parent is where codex scans
  // for version dirs, so a telemetry dir there is the poisoning sibling.
  const resolved = resolvePluginDir(join(versionDir, 'dist'));
  assert.equal(resolved, versionDir);
  assert.notEqual(resolved, join(cacheRoot, 'huaweicloud-devkit', 'huaweicloud-devkit'));
});

test('resolvePluginDir: markerless start falls back to the two-up join', () => {
  const root = fixtureDir('devkit-telemetry-fallback-');
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  assert.equal(resolvePluginDir(join(root, 'a', 'b')), root);
});
