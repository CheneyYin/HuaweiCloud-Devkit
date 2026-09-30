import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { SCHEMA_DRIFT_IGNORED_KEYS } from '../plugins/huaweicloud-core/src/tool-schemas.ts';
import { createLinkedDevkitServers } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';

const PACK_IDS = ['core', 'services', 'sandbox', 'auth', 'obs', 'voucher', 'update', 'discovery'];
// Packs that own knowledge without callable surface: their tool list is
// legitimately empty, so the "must list tools" bar exempts them.
const ZERO_TOOL_PACKS = new Set(['services']);

test('huaweicloud_list_packs returns all 8 packs, sandbox carries exactly 11 tool names', async () => {
  const result = await callTool('huaweicloud_list_packs', {});
  assert.equal(result.ok, true);
  assert.equal(result.count, 8);
  assert.deepEqual(
    result.packs.map((pack) => pack.id),
    PACK_IDS,
  );
  for (const pack of result.packs) {
    assert.equal(typeof pack.title, 'string');
    assert.equal(typeof pack.description, 'string');
    assert.equal(pack.enabled, true);
    if (ZERO_TOOL_PACKS.has(pack.id)) {
      assert.equal(pack.tools.length, 0, `${pack.id} owns knowledge, not tools`);
    } else {
      assert.ok(Array.isArray(pack.tools) && pack.tools.length > 0, `${pack.id} must list tools`);
    }
  }
  const services = result.packs.find((pack) => pack.id === 'services');
  assert.equal(services.skills.length, 20);
  assert.ok(services.skills.includes('huawei-ecs'));
  const sandbox = result.packs.find((pack) => pack.id === 'sandbox');
  assert.equal(sandbox.tools.length, 11);
  assert.ok(sandbox.tools.includes('huaweicloud_sandbox_connect'));
});

test('huaweicloud_pack_info returns the 11 sandbox tools with name, description, and schema', async () => {
  const result = await callTool('huaweicloud_pack_info', { pack: 'sandbox' });
  assert.equal(result.ok, true);
  assert.equal(result.pack, 'sandbox');
  assert.deepEqual(result.skills, ['huawei-sandbox']);
  assert.equal(result.enabled, true);
  assert.equal(result.tools.length, 11);
  for (const entry of result.tools) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.startsWith('huaweicloud_sandbox_'));
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.description.length > 0, `${entry.name} description must not be empty`);
    assert.equal(entry.schema.type, 'object');
    assert.equal(entry.schema.$schema, undefined, 'pack_info schema output must be $schema-stripped');
  }
});

test('huaweicloud_pack_info bogus pack returns an error listing the valid pack ids', async () => {
  const result = await callTool('huaweicloud_pack_info', { pack: 'bogus' });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
  for (const id of PACK_IDS) {
    assert.match(result.error, new RegExp(`\\b${id}\\b`), `error must list valid id ${id}`);
  }
});

test('huaweicloud_pack_info without a pack id reports it as required', async () => {
  const result = await callTool('huaweicloud_pack_info', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /required/);
});

test('pack_info schema output matches the tools/list rendering after stripping ignored keys', async () => {
  // The SDK renders tools/list through its draft-7 layer while pack_info uses
  // z.toJSONSchema (2020-12); SCHEMA_DRIFT_IGNORED_KEYS is the only
  // normalization needed for the two to compare equal.
  const { server, transport } = await createLinkedDevkitServers();
  const client = new Client({ name: 'pack-meta-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    let compared = 0;
    for (const packId of PACK_IDS) {
      const info = await callTool('huaweicloud_pack_info', { pack: packId });
      assert.equal(info.ok, true, `pack_info failed for ${packId}`);
      for (const entry of info.tools) {
        const fromList = listed.tools.find((tool) => tool.name === entry.name);
        assert.ok(fromList, `${entry.name} missing from tools/list`);
        const rendered = structuredClone(fromList.inputSchema);
        for (const key of SCHEMA_DRIFT_IGNORED_KEYS) delete rendered[key];
        assert.deepEqual(entry.schema, rendered, `schema drift between pack_info and tools/list for ${entry.name}`);
        compared++;
      }
    }
    assert.equal(compared, 42, 'every registered tool must be compared');
  } finally {
    await client.close();
    await server.close();
  }
});
