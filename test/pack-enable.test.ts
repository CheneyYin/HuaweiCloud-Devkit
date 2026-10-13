import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { resolveEnabledPacks } from '../plugins/huaweicloud-core/src/packs/enable.ts';
import { PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { createLinkedDevkitServers } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';
import type { PackId } from '../plugins/huaweicloud-core/src/lib/pack-types.ts';

const ALL_IDS = PACKS.map((pack) => pack.id);
const OPTIONAL_IDS = ALL_IDS.filter((id) => id !== 'core');

// node --test runs each file in its own process, so mutating process.env here
// cannot leak into the other suites; the try/finally still keeps this file's
// later tests honest.
function withDevkitPacks(value: string, fn: () => Promise<void>) {
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

interface ListPacksPayload {
  ok: boolean;
  count: number;
  packs: Array<{ id: PackId; enabled: boolean }>;
}

interface PackInfoPayload {
  ok: boolean;
  enabled?: boolean;
  error?: string;
}

interface SkillPayload {
  ok: boolean;
  error?: string;
}

interface SearchDocsPayload {
  ok: boolean;
  results: Array<{ name: string }>;
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
    const listed = (await callTool('huaweicloud_list_packs', {})) as ListPacksPayload;
    assert.equal(listed.ok, true);
    assert.equal(listed.count, ALL_IDS.length, 'list_packs still discloses every pack');
    const flags = new Map(listed.packs.map((pack) => [pack.id, pack.enabled]));
    assert.equal(flags.get('core'), true);
    assert.equal(flags.get('sandbox'), true);
    for (const id of OPTIONAL_IDS) {
      if (id !== 'sandbox') assert.equal(flags.get(id), false, `${id} must report enabled:false`);
    }

    const denied = (await callTool('huaweicloud_pack_info', { pack: 'obs' })) as PackInfoPayload;
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? '', /Pack "obs" is not enabled/);
    assert.match(denied.error ?? '', /DEVKIT_PACKS/, 'the error must explain how to enable the pack');

    const allowed = (await callTool('huaweicloud_pack_info', { pack: 'sandbox' })) as PackInfoPayload;
    assert.equal(allowed.ok, true);
    assert.equal(allowed.enabled, true);
  }),
);

test(
  'retrieveSkill gates disabled-pack skills; search filters them out',
  withDevkitPacks('sandbox', async () => {
    const denied = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-obs' })) as SkillPayload;
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? '', /Skill "huawei-obs" belongs to pack "obs" which is not enabled/);
    assert.match(denied.error ?? '', /DEVKIT_PACKS/, 'the error must explain how to enable the pack');

    // Service knowledge is owned by the huaweicloud-cli pack, so a pinned env
    // that omits it gates those skills too; core no longer implies service
    // coverage.
    const serviceSkill = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' })) as SkillPayload;
    assert.equal(serviceSkill.ok, false, 'service skill must be gated when huaweicloud-cli is disabled');
    assert.match(serviceSkill.error ?? '', /belongs to pack "huaweicloud-cli" which is not enabled/);

    // Core-owned knowledge (the meta-skills) stays fully available.
    const coreSkill = (await callTool('huaweicloud_retrieve_skill', { name: 'huaweicloud-core' })) as SkillPayload;
    assert.equal(coreSkill.ok, true, 'meta-skill must stay retrievable');

    const search = (await callTool('huaweicloud_search_docs', { query: 'obs' })) as SearchDocsPayload;
    assert.equal(search.ok, true);
    const names = new Set(search.results.map((entry) => entry.name));
    assert.ok(!names.has('huawei-obs'), 'disabled-pack skill must be filtered from search results');
    assert.ok(!names.has('huawei-ecs'), 'service skill must be filtered from search results');

    const coreSearch = (await callTool('huaweicloud_search_docs', { query: 'routing' })) as SearchDocsPayload;
    assert.ok(
      coreSearch.results.some((entry) => entry.name === 'huaweicloud-core'),
      'core-owned meta-skill must stay searchable',
    );
  }),
);

test(
  'enabling huaweicloud-cli loads service skills and gates other packs',
  withDevkitPacks('huaweicloud-cli', async () => {
    // Skill gating is half the pack's surface; the tools/list half (core 10 +
    // the seven CLI execution tools) is pinned by the trimming test below.
    const listed = (await callTool('huaweicloud_list_packs', {})) as ListPacksPayload;
    assert.equal(listed.ok, true);
    const flags = new Map(listed.packs.map((pack) => [pack.id, pack.enabled]));
    assert.equal(flags.get('huaweicloud-cli'), true);
    assert.equal(flags.get('core'), true);
    for (const id of OPTIONAL_IDS) {
      if (id !== 'huaweicloud-cli') assert.equal(flags.get(id), false, `${id} must report enabled:false`);
    }

    const serviceSkill = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' })) as SkillPayload;
    assert.equal(serviceSkill.ok, true, 'service skill must load when huaweicloud-cli is enabled');

    const denied = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-sandbox' })) as SkillPayload;
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? '', /belongs to pack "sandbox" which is not enabled/);
  }),
);

test(
  'enabling only huaweicloud-cli registers the seven CLI execution tools alongside core',
  withDevkitPacks('huaweicloud-cli', async () => {
    // Fail-closed trimming, positive direction: the pack carries the CLI
    // execution face and its approval tools together, so a trimmed-to-cli
    // server exposes exactly core 10 + cli 7 and nothing else.
    const { server, transport } = await createLinkedDevkitServers();
    const client = new Client({ name: 'pack-enable-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      assert.equal(names.length, 17, 'core 10 + huaweicloud-cli 7');
      for (const name of [
        'huaweicloud_check_cli',
        'huaweicloud_plan_cli_command',
        'huaweicloud_run_readonly_command',
        'huaweicloud_list_operations',
        'huaweicloud_run_approved_command',
        'huaweicloud_show_profile_redacted',
        'huaweicloud_list_regions',
      ]) {
        assert.ok(names.includes(name), `${name} must be registered when huaweicloud-cli is enabled`);
      }
      assert.ok(!names.includes('huaweicloud_sandbox_connect'), 'a non-cli pack tool must not be registered');
    } finally {
      await client.close();
      await server.close();
    }
  }),
);

test('without DEVKIT_PACKS every skill and pack is available again', async () => {
  const skill = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-obs' })) as SkillPayload;
  assert.equal(skill.ok, true, 'huawei-obs must be retrievable with no trimming');
  const info = (await callTool('huaweicloud_pack_info', { pack: 'obs' })) as PackInfoPayload;
  assert.equal(info.ok, true);
});
