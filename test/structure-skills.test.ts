import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseSkillFrontmatter } from '../plugins/huaweicloud-core/src/lib/skill-frontmatter.ts';
import { PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { listSkillDirs } from '../plugins/huaweicloud-core/src/lib/skill-tree.ts';
import { pluginRoot } from './structure-helpers.ts';

test('plugin skills are compact meta-skills instead of service encyclopedia entries', () => {
  const skillsDir = join(pluginRoot, 'skills');
  const skillNames = listSkillDirs(skillsDir);
  const requiredMetaSkills = [
    'huaweicloud-api-and-sdk',
    'huaweicloud-capability-discovery',
    'huaweicloud-cli-and-auth',
    'huaweicloud-core',
    'huaweicloud-safety',
    'huaweicloud-troubleshooting',
  ];
  for (const name of requiredMetaSkills) {
    assert.ok(skillNames.includes(name), `Missing meta-skill: ${name}`);
  }
  assert.ok(skillNames.length >= 6, 'Should have at least 6 skills');

  for (const name of skillNames) {
    const body = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(body, /^---\r?\nname: /);
    assert.doesNotMatch(body, /TODO|\[TODO/i);
  }
});

// The corpus contract for frontmatter, pinned over every source skill:
// non-empty quote-free description, frontmatter name equal to the
// registry/directory name (the search_docs → retrieve_skill chain), absent
// or numeric version, no unsupported block-scalar marker. The multi-line
// and second-paragraph guarantees are pinned at the consumer level
// (test/pack-meta-tools.test.ts, test/tools.test.ts) — a truncation that
// still yields a clean single line would pass these shape checks.

test('every source SKILL.md description parses non-empty and quote-free', () => {
  for (const pack of PACKS) {
    for (const name of pack.skills) {
      const body = readFileSync(join(pluginRoot, 'src', 'packs', pack.id, 'skills', name, 'SKILL.md'), 'utf8');
      const fm = parseSkillFrontmatter(body);
      assert.ok(fm.description && fm.description.length > 0, `${name} description must parse non-empty`);
      assert.ok(
        !/^['"]|['"]$/.test(fm.description),
        `${name} description must parse quote-stripped (multi-line or quoted frontmatter regressed)`,
      );
      assert.ok(
        !/^[>|]/.test(fm.description),
        `${name} description must not parse to an unsupported block-scalar marker`,
      );
      assert.equal(fm.name, name, `${name} frontmatter name must equal the registry/directory name`);
      assert.ok(fm.version === null || /^\d+(\.\d+)*$/.test(fm.version), `${name} version must be absent or numeric`);
    }
  }
});

test('skill SKILL.md files meet minimum content quality bar', () => {
  const skillsDir = join(pluginRoot, 'skills');
  const skillNames = listSkillDirs(skillsDir);

  const exceptions = new Set([
    'huaweicloud-api-and-sdk',
    'huaweicloud-safety',
    'huaweicloud-troubleshooting',
    'huawei-getting-started',
  ]);

  for (const name of skillNames) {
    const body = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const lines = body.split('\n').length;
    if (exceptions.has(name)) continue;
    assert.ok(lines >= 40, `${name}/SKILL.md has ${lines} lines (min 40)`);
  }
});

test('skills with references have non-empty reference files', () => {
  const skillsDir = join(pluginRoot, 'skills');
  const skillNames = listSkillDirs(skillsDir);

  for (const name of skillNames) {
    const refDir = join(skillsDir, name, 'references');
    if (!existsSync(refDir)) continue;
    const refFiles = readdirSync(refDir).filter((f) => f.endsWith('.md'));
    for (const ref of refFiles) {
      const body = readFileSync(join(refDir, ref), 'utf8');
      const lines = body.split('\n').length;
      assert.ok(lines >= 10, `${name}/references/${ref} has ${lines} lines (min 10)`);
    }
  }
});
