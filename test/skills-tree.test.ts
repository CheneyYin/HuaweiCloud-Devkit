import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { verifySkillTree } from '../plugins/huaweicloud-core/src/tools.ts';
import { PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { writeSkillsTree } from '../scripts/sync-skills.mjs';
import { fixtureDir } from './fixture-dir.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const realTree = join(root, 'plugins', 'huaweicloud-core', 'skills');

// The registry roster is the ownership truth verifySkillTree enforces.
const allSkills = [...new Set(PACKS.flatMap((pack) => pack.skills))];

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
