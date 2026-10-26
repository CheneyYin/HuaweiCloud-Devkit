// Structure guards for the detect-framework family split (REPORT-detfw.md):
// detect-framework.ts is the stable public face — a pure re-export — while
// the internals live in the src/detect-framework-* siblings (the
// safety-policy.ts precedent). These guards pin the face ownership and the
// family layering so a future extraction cannot drift them without
// rewriting this file: the table and pkg readers stay leaves, the matcher
// returns specs (never shaped results), and the scan orchestration owns
// detectFramework plus the sub-app recursion.
import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './structure-helpers.ts';

const FACE = 'src/detect-framework.ts';
const TABLE = 'src/detect-framework-table.ts';
const PKG = 'src/detect-framework-pkg.ts';
const MATCH = 'src/detect-framework-match.ts';
const SCAN = 'src/detect-framework-scan.ts';

test('detect-framework face is the pure re-export of the public surface', () => {
  const face = readSource(FACE);
  // The direct importers (src/packs/discovery/tools.ts for the
  // huaweicloud_detect_framework tool, test/detect-framework.test.ts) import
  // these names from src/detect-framework.ts — the face re-exports every
  // pre-split public export from the scan module, nothing else.
  assert.match(
    face,
    /export \{ detectFramework, type SubApp, type FrameworkDetection \} from '\.\/detect-framework-scan\.ts';/,
  );
  // The face owns no implementation: no orchestration, no spec table, no
  // result types (they moved to the family siblings).
  assert.doesNotMatch(face, /function detectFramework\(/);
  assert.doesNotMatch(face, /const FRAMEWORKS = \{/);
  assert.doesNotMatch(face, /interface (SubApp|FrameworkDetection|FrameworkSpec) \{/);
});

test('the table and pkg-reader siblings keep their canonical ownership and stay leaves', () => {
  const table = readSource(TABLE);
  assert.match(table, /export interface FrameworkSpec \{/);
  assert.match(table, /const FRAMEWORKS = \{/);
  assert.match(table, /\} satisfies Record<string, FrameworkSpec>;/);
  const pkg = readSource(PKG);
  for (const name of [
    'readPkg',
    'detectPackageManager',
    'collectDeps',
    'readVitepressOutDir',
    'resolveAngularOutput',
  ]) {
    assert.match(pkg, new RegExp(`export function ${name}\\(`), `${name} must stay owned by the pkg sibling`);
  }
  // Layering: the data table and the readers import no family module, so
  // the family stays acyclic (table/pkg leaves, match above them, scan on
  // top). Sibling imports here would also drag the pack-boundaries face
  // contract into the bundle graph sideways. Code-shaped check: prose
  // mentions of sibling filenames in doctrine comments are fine, import
  // statements are not.
  for (const [name, src] of [
    ['table', table],
    ['pkg', pkg],
  ] as const) {
    assert.ok(!/^import .+detect-framework-/m.test(src), `${name} must not import a detect-framework sibling`);
  }
});

test('match owns the spec chain and returns specs, never shaped results', () => {
  const match = readSource(MATCH);
  assert.match(match, /export function matchFrameworkSpec\(/);
  // The spec-returning contract: the matcher may not build results (that
  // is the scan module's job) — keeps the branch chain free of the
  // packageManager/rootDir plumbing and its complexity budget honest.
  assert.doesNotMatch(match, /frameworkResult|patchCommands/);
  // The chain's known anchors stay in match (order is pinned by
  // test/detect-framework.test.ts's detection matrix).
  assert.match(match, /'react-scripts' in deps \|\|/);
  assert.match(match, /const hasEntry = entryPoints\.some\(\(p\) => existsSync\(join\(projectPath, p\)\)\);/);
});

test('scan owns detectFramework, the sub-app recursion, and the command patching', () => {
  const scan = readSource(SCAN);
  assert.match(scan, /export function detectFramework\(projectPath: string\): FrameworkDetection \| null \{/);
  // scanSubApps recurses into detectFramework — it must stay in the same
  // module as it (a sibling placement would need a value cycle or injection).
  assert.match(scan, /function scanSubApps\(projectPath: string\): SubApp\[\] \{/);
  assert.match(scan, /const result = detectFramework\(subPath\);/);
  assert.match(scan, /function patchCommands\(result: FrameworkDetection, pm: string\): FrameworkDetection \{/);
  assert.match(
    scan,
    /function frameworkResult\(fw: FrameworkSpec, pm: string, projectPath: string\): FrameworkDetection \{/,
  );
  assert.match(scan, /export interface SubApp \{/);
  assert.match(scan, /export interface FrameworkDetection \{/);
  // The delegation seam: monorepo handled inline, single-project chain
  // delegated to the matcher, null only when the matcher finds nothing.
  assert.match(scan, /const spec = matchFrameworkSpec\(projectPath, pkg, deps\);/);
  assert.match(scan, /return spec \? frameworkResult\(spec, pm, projectPath\) : null;/);
});

test('the discovery pack still imports the face, and the family keeps bundle-graph discipline', () => {
  const tools = readSource('src/packs/discovery/tools.ts');
  // pack-boundaries.mjs whitelists src/detect-framework.ts in
  // CORE_VALUE_FILES — the pack must keep importing the face, never a
  // sibling (a sibling import would fall outside the whitelist).
  assert.match(tools, /import \{ detectFramework \} from '\.\.\/\.\.\/detect-framework\.ts';/);
  // Bundle-graph discipline for every family member: no zod, no SDK, no
  // __dirname/import.meta.url path derivation (the esbuild depth trap —
  // the family feeds the bundled mcp-server graph).
  for (const name of [FACE, TABLE, PKG, MATCH, SCAN]) {
    const src = readSource(name);
    assert.ok(!/^import .*'zod';/m.test(src), `${name} must not import zod`);
    assert.ok(!/__dirname|import\.meta\.url/.test(src), `${name} must not derive paths from its module URL`);
  }
});
