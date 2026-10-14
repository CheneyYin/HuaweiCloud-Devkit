import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { verifySkillTree } from '../plugins/huaweicloud-core/src/tools.ts';
import { PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { parseSkillManifest } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';
import { writeSkillsTree } from '../scripts/sync-skills.mjs';
import { fixtureDir } from './fixture-dir.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');
const realTree = join(pluginRoot, 'skills');

// The registry roster is the ownership truth verifySkillTree enforces.
const allSkills = [...new Set(PACKS.flatMap((pack) => pack.skills))];

// The tree-reading tests below need the generated skills tree (a build
// artifact); one guided precondition instead of a raw ENOENT on a fresh
// checkout.
assert.ok(existsSync(realTree), 'generated skills tree missing — run: npm run build');

function makeTree(dir: string, names: string[]): void {
  for (const name of names) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
  }
}

// Fail-loud is the changeset's load-bearing behavior: a tree that does not
// EQUAL the registry roster must refuse to boot. These exercise the guard
// through its injectable root, so no real tree is touched.
test('verifySkillTree accepts a tree equal to the registry roster', () => {
  const dir = fixtureDir('hwc-skills-ok-');
  makeTree(dir, allSkills);
  assert.doesNotThrow(() => verifySkillTree(dir));
});

test('verifySkillTree refuses a tree missing a claimed skill', () => {
  const dir = fixtureDir('hwc-skills-missing-');
  const [dropped, ...rest] = allSkills;
  makeTree(dir, rest);
  assert.throws(
    () => verifySkillTree(dir),
    (error: Error) => error.message.includes('missing') && error.message.includes(dropped!),
  );
});

test('verifySkillTree refuses an unclaimed skill directory (ungated-serve hole)', () => {
  const dir = fixtureDir('hwc-skills-extra-');
  makeTree(dir, [...allSkills, 'huawei-not-claimed']);
  assert.throws(
    () => verifySkillTree(dir),
    (error: Error) => error.message.includes('unclaimed') && error.message.includes('huawei-not-claimed'),
  );
});

test('writeSkillsTree refuses an empty source root and leaves the real tree intact', () => {
  const empty = fixtureDir('hwc-skills-empty-');
  assert.throws(() => writeSkillsTree({ packsDir: empty }), /no pack skill sources found/);
  assert.ok(
    readdirSync(realTree, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length > 0,
    'the real generated tree must survive a refused regeneration',
  );
  assert.ok(existsSync(join(realTree, '.manifest.json')), 'the shipped manifest must survive a refused regeneration');
});

// A render failure after staging began must clean the staging dir (the live
// tree is still intact, so the staging copy is disposable). chmod is the
// portable-enough way to make a source read fail; Windows chmod is a no-op,
// so the test skips there.
test(
  'writeSkillsTree cleans up its staging dir when rendering fails mid-way',
  { skip: process.platform === 'win32' },
  () => {
    const packs = fixtureDir('hwc-skills-renderfail-');
    const pack = join(packs, 'p', 'skills');
    mkdirSync(join(pack, 's1'), { recursive: true });
    mkdirSync(join(pack, 's2'), { recursive: true });
    writeFileSync(join(pack, 's1', 'SKILL.md'), '---\nname: s1\n---\n', 'utf8');
    writeFileSync(join(pack, 's2', 'SKILL.md'), '---\nname: s2\n---\n', 'utf8');
    chmodSync(join(pack, 's2', 'SKILL.md'), 0o000);
    try {
      assert.throws(() => writeSkillsTree({ packsDir: packs }), /(EACCES|permission)/i);
      assert.ok(
        !readdirSync(pluginRoot).some((name) => name.startsWith('skills.new-')),
        'no staging dir may remain after a failed render',
      );
      assert.ok(existsSync(join(realTree, '.manifest.json')), 'the live tree must be untouched by a failed render');
    } finally {
      // restore readability so the exit-time fixture cleanup can unlink it
      chmodSync(join(pack, 's2', 'SKILL.md'), 0o644);
    }
  },
);

test('parseSkillManifest extracts, dedupes, and filters the roster', () => {
  assert.deepEqual(parseSkillManifest('{"skills":["b","a","b",42,"a"]}'), ['b', 'a']);
  assert.deepEqual(parseSkillManifest('{"skills":[]}'), []);
  assert.deepEqual(parseSkillManifest('{"generatedBy":"x"}'), []);
  assert.deepEqual(parseSkillManifest('not json'), []);
  assert.deepEqual(parseSkillManifest('{"skills":"nope"}'), []);
});
