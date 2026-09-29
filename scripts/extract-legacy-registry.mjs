// One-off extraction: rebuilds test/fixtures/legacy-registry-snapshot.json
// from the PRE-MIGRATION tools.ts at git HEAD, so the fixture holds the
// legacy JSON-Schema contract rather than a zod render of it. Run from the
// repo root after checking out any post-migration revision:
//   node scripts/extract-legacy-registry.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'plugins', 'huaweicloud-core', 'src');
const tempModule = join(srcDir, 'legacy-registry-extract.ts');
const fixturePath = join(root, 'test', 'fixtures', 'legacy-registry-snapshot.json');

const IGNORED_KEYS = new Set(['$schema', 'additionalProperties', 'description']);

function normalize(node) {
  if (Array.isArray(node)) return node.map((item) => normalize(item));
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node).sort((a, b) => a.localeCompare(b))) {
      if (IGNORED_KEYS.has(key)) continue;
      out[key] = normalize(node[key]);
    }
    if (Array.isArray(out.type) && out.type.length === 1) out.type = out.type[0];
    return out;
  }
  return node;
}

const legacySource = execFileSync('git', ['show', 'HEAD:plugins/huaweicloud-core/src/tools.ts'], {
  cwd: root,
  encoding: 'utf8',
});
writeFileSync(tempModule, legacySource);

try {
  const mod = await import(pathToFileURL(tempModule).href);
  const snapshot = {};
  for (const tool of mod.TOOL_DEFINITIONS) {
    snapshot[tool.name] = normalize(tool.inputSchema);
  }
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`legacy registry snapshot written: ${Object.keys(snapshot).length} tools from git HEAD`);
} finally {
  rmSync(tempModule, { force: true });
}
