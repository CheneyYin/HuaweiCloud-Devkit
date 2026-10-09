import { type Pack } from '../../lib/pack-types.ts';
import { HUAWEICLOUD_OPEN_MCP_TOOLS } from './tools.ts';

// The huaweicloud-open-mcp pack manifest. registry.ts references this from
// PACKS; the tool list is derived from the pack's own definitions, and
// PACK_OF stays the tool-ownership source of truth (structure.test.ts
// asserts the lockstep). The pack's binary dependency (the
// huaweicloud-open-mcp gateway) is declared in lib/dependency-model.ts
// PACK_DEPENDENCIES, not here. No skills yet: the routing rows and the
// huawei-openapi skill land with a dedicated teaching pass over these
// approval faces.
export const huaweicloudOpenMcpPack: Pack = {
  id: 'huaweicloud-open-mcp',
  title: 'Open MCP Gateway',
  description:
    'Direct Huawei Cloud OpenAPI discovery proxied through the local huaweicloud-open-mcp gateway: search the full catalog (300+ products, 17,000+ APIs), narrow to one API, read its schema and examples, inspect the live gateway tool surface, and call gateway tools generically through the approval-token gate (devkit mode) or the gateway policy engine (HUAWEICLOUD_OPENMCP_APPROVAL=native).',
  skills: [],
  tools: HUAWEICLOUD_OPEN_MCP_TOOLS.map((tool) => tool.name),
};
