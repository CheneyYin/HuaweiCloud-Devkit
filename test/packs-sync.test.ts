import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { renderGenerated, stripMarkerLine } from '../scripts/sync-skills.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');
const packsDir = join(pluginRoot, 'src', 'packs');

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// Zero-drift gate over the skill dual-source layout: the pack-owned skills
// under src/packs/<id>/skills/ are authoritative, plugins/huaweicloud-core/
// skills/<name>/ is the generated tree agents read. scripts/sync-skills.mjs
// --check re-derives the expectation and fails on any byte drift (after
// CRLF normalization and marker-line stripping). The same check runs as the
// prepack tail so a dirty tree cannot ship.
test('pack skill sources and the generated skills/ tree are in sync', () => {
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'sync-skills.mjs'), '--check'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(run.status, 0, `skills sync check failed:\n${run.stdout}\n${run.stderr}`);
});

// --write output must pass --check without a prettier pass in between:
// stripMarkerLine is a true inverse of renderGenerated (pure insertion plus
// one prettier-settled blank), for every source shape the repo actually has.
// A new skill whose spacing breaks the pair fails here with "run prettier on
// the source" as the fix, instead of failing later in prepack.
test('renderGenerated and stripMarkerLine are inverses for every pack skill source', () => {
  const packIds = readdirSync(packsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  let checked = 0;
  for (const packId of packIds) {
    const packSkillsDir = join(packsDir, packId, 'skills');
    let skillNames;
    try {
      skillNames = readdirSync(packSkillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue; // pack without skills
    }
    for (const skillName of skillNames) {
      const sourceDir = join(packSkillsDir, skillName);
      for (const file of walkFiles(sourceDir)) {
        const relativeFile = file.slice(sourceDir.length + 1).replace(/\\/g, '/');
        const source = readFileSync(file, 'utf8');
        const rendered = renderGenerated(packId, skillName, relativeFile, source);
        assert.equal(
          stripMarkerLine(rendered),
          source.replace(/\r\n/g, '\n'),
          `round-trip failed for ${packId}/${skillName}/${relativeFile} — run prettier on the source`,
        );
        checked++;
      }
    }
  }
  // 23 skills across 4 packs ship 49 files today; the floor only guards
  // against accidentally skipping whole packs, not the exact count.
  assert.ok(checked >= 45, `expected to check every pack skill file, got ${checked}`);
});
