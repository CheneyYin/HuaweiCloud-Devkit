import { PACK_BINARIES, type Pack } from '../../lib/pack-types.ts';
import { OPENAPI_TOOLS } from './tools.ts';

// The openapi pack manifest. registry.ts references this from PACKS; the
// tool list is derived from the pack's own definitions, and PACK_OF stays
// the tool-ownership source of truth (structure.test.ts asserts the
// lockstep). No skills yet: the routing rows and the huawei-openapi skill
// land with the approval bridge, when there is an execution story to teach.
export const openapiPack: Pack = {
  id: 'openapi',
  title: 'OpenAPI Gateway',
  description:
    'Direct Huawei Cloud OpenAPI discovery proxied through the local huaweicloud-open-mcp gateway: search the full catalog (300+ products, 17,000+ APIs), narrow to one API, read its schema and examples. Discovery-only surface; API execution arrives with the approval bridge in a later phase.',
  skills: [],
  tools: OPENAPI_TOOLS.map((tool) => tool.name),
  binaries: PACK_BINARIES.openapi,
};
