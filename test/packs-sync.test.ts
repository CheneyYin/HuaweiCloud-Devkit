import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

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
