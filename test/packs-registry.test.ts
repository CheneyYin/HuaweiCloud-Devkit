import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { TOOL_DEFINITIONS } from '../plugins/huaweicloud-core/src/tools.ts';
import { PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');

test('no tool name appears in two pack tool lists', () => {
  const owner = new Map<string, string>();
  for (const pack of PACKS) {
    for (const tool of pack.tools) {
      assert.ok(!owner.has(tool), `${tool} is claimed by both ${owner.get(tool)} and ${pack.id}`);
      owner.set(tool, pack.id);
    }
  }
});

test('the pack tool union equals the full TOOL_DEFINITIONS registry', () => {
  const union = [...new Set(PACKS.flatMap((pack) => pack.tools))].sort((a, b) => a.localeCompare(b));
  const all = TOOL_DEFINITIONS.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(union, all);
});

test('pack tool counts match the P0 grouping', () => {
  const expected = { core: 17, sandbox: 11, auth: 5, obs: 2, voucher: 2, update: 2, discovery: 3 };
  let total = 0;
  for (const pack of PACKS) {
    assert.equal(pack.tools.length, expected[pack.id], `${pack.id} tool count`);
    total += pack.tools.length;
  }
  assert.equal(total, 42);
});

test('every skills/ directory is claimed by exactly one pack', () => {
  const dirs = readdirSync(join(pluginRoot, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const claimed = new Set<string>();
  for (const pack of PACKS) {
    for (const skill of pack.skills) {
      assert.ok(!claimed.has(skill), `skill ${skill} is claimed by more than one pack (${pack.id})`);
      claimed.add(skill);
    }
  }
  assert.deepEqual(
    [...claimed].sort((a, b) => a.localeCompare(b)),
    dirs,
  );
});
