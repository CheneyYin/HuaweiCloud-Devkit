import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEnabledPacks } from '../plugins/huaweicloud-core/src/packs/enable.ts';
import { PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';

const ALL_IDS = PACKS.map((pack) => pack.id);
const OPTIONAL_IDS = ALL_IDS.filter((id) => id !== 'core');

// node --test runs each file in its own process, so mutating process.env here
// cannot leak into the other suites; the try/finally still keeps this file's
// later tests honest.
function withDevkitPacks(value, fn) {
  return async () => {
    const previous = process.env.DEVKIT_PACKS;
    process.env.DEVKIT_PACKS = value;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.DEVKIT_PACKS;
      else process.env.DEVKIT_PACKS = previous;
    }
  };
}

test('unset DEVKIT_PACKS enables every pack', () => {
  const enabled = resolveEnabledPacks({});
  assert.equal(enabled.size, ALL_IDS.length);
  for (const id of ALL_IDS) assert.ok(enabled.has(id), `${id} must be enabled by default`);
});

test('blank DEVKIT_PACKS behaves like unset (full surface)', () => {
  for (const value of ['', '   ']) {
    const enabled = resolveEnabledPacks({ DEVKIT_PACKS: value });
    assert.equal(enabled.size, ALL_IDS.length, `DEVKIT_PACKS=${JSON.stringify(value)} must enable all packs`);
  }
});

test('DEVKIT_PACKS splits on commas and trims each item', () => {
  const enabled = resolveEnabledPacks({ DEVKIT_PACKS: ' sandbox , auth ' });
  assert.equal(enabled.size, 3);
  assert.ok(enabled.has('core'));
  assert.ok(enabled.has('sandbox'));
  assert.ok(enabled.has('auth'));
  for (const id of OPTIONAL_IDS) {
    if (id !== 'sandbox' && id !== 'auth') assert.ok(!enabled.has(id), `${id} must stay disabled`);
  }
});

test('core cannot be trimmed: env omitting core still gets it', () => {
  const enabled = resolveEnabledPacks({ DEVKIT_PACKS: 'obs' });
  assert.ok(enabled.has('core'), 'core is force-included even when env omits it');
  assert.ok(enabled.has('obs'));
  assert.equal(enabled.size, 2);
});

test('listing core explicitly is redundant but harmless', () => {
  const enabled = resolveEnabledPacks({ DEVKIT_PACKS: 'core,sandbox' });
  assert.equal(enabled.size, 2);
  assert.ok(enabled.has('core'));
  assert.ok(enabled.has('sandbox'));
});

test('unknown pack id throws fail-fast with the valid id list', () => {
  assert.throws(
    () => resolveEnabledPacks({ DEVKIT_PACKS: 'sandbox,bogus' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /bogus/, 'the unknown id must be named');
      for (const id of ALL_IDS) {
        assert.match(error.message, new RegExp(`\\b${id}\\b`), `error must list valid id ${id}`);
      }
      return true;
    },
    'unknown DEVKIT_PACKS ids must throw',
  );
});

test('unrelated env vars never influence the resolution', () => {
  const enabled = resolveEnabledPacks({ DEVKIT_PACKS: 'voucher', HCLOUD_BIN: '/elsewhere/hcloud' });
  assert.equal(enabled.size, 2);
  assert.ok(enabled.has('voucher'));
  assert.ok(enabled.has('core'));
});

test(
  'list_packs and pack_info reflect DEVKIT_PACKS enablement',
  withDevkitPacks('sandbox', async () => {
    const listed = await callTool('huaweicloud_list_packs', {});
    assert.equal(listed.ok, true);
    assert.equal(listed.count, ALL_IDS.length, 'list_packs still discloses all 7 packs');
    const flags = new Map(listed.packs.map((pack) => [pack.id, pack.enabled]));
    assert.equal(flags.get('core'), true);
    assert.equal(flags.get('sandbox'), true);
    for (const id of OPTIONAL_IDS) {
      if (id !== 'sandbox') assert.equal(flags.get(id), false, `${id} must report enabled:false`);
    }

    const denied = await callTool('huaweicloud_pack_info', { pack: 'obs' });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /Pack "obs" is not enabled/);
    assert.match(denied.error, /DEVKIT_PACKS/, 'the error must explain how to enable the pack');

    const allowed = await callTool('huaweicloud_pack_info', { pack: 'sandbox' });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.enabled, true);
  }),
);

test(
  'retrieveSkill gates disabled-pack skills; search filters them out',
  withDevkitPacks('sandbox', async () => {
    const denied = await callTool('huaweicloud_retrieve_skill', { name: 'huawei-obs' });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /Skill "huawei-obs" belongs to pack "obs" which is not enabled/);
    assert.match(denied.error, /DEVKIT_PACKS/, 'the error must explain how to enable the pack');

    // Core-owned knowledge stays fully available.
    const coreSkill = await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' });
    assert.equal(coreSkill.ok, true, 'core-pack skill must stay retrievable');

    const search = await callTool('huaweicloud_search_docs', { query: 'obs' });
    assert.equal(search.ok, true);
    const names = search.results.map((entry) => entry.name);
    assert.ok(!names.includes('huawei-obs'), 'disabled-pack skill must be filtered from search results');

    const coreSearch = await callTool('huaweicloud_search_docs', { query: 'ecs' });
    assert.ok(
      coreSearch.results.some((entry) => entry.name === 'huawei-ecs'),
      'core-pack skill must stay searchable',
    );
  }),
);

test('without DEVKIT_PACKS every skill and pack is available again', async () => {
  const skill = await callTool('huaweicloud_retrieve_skill', { name: 'huawei-obs' });
  assert.equal(skill.ok, true, 'huawei-obs must be retrievable with no trimming');
  const info = await callTool('huaweicloud_pack_info', { pack: 'obs' });
  assert.equal(info.ok, true);
});
