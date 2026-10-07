import { z } from 'zod';

import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import { callOpenMcpTool } from './sidecar.ts';

// Thin proxies over the huaweicloud-open-mcp gateway's six metadata tools
// (src/mcp_openapi/server.py). The gateway is the authoritative validator;
// these zod schemas only guard the boundary (required identity fields plus
// passthrough), and the sidecar normalizes results to {ok, tool, ...}.
// Phase 1 is discovery-only: execute_api and manage_policy are NOT proxied.
// API execution arrives with the approval bridge (plan/run pair minting a
// once-scope grant inside the handler), which keeps the devkit's single
// consent authority intact.

// The gateway's pydantic ints reject null (verified: limit=null fails with
// "Input should be a valid integer"), so unlike numericArg these stay
// non-nullable; numeric strings pass through and coerce gateway-side.
const gatewayInt = z.union([z.number(), z.string()]).optional();

const searchApisSchema = z.looseObject({
  query: z.string().describe('Entity keywords for the cross-product search, e.g. "弹性云服务器" or "database".'),
  limit: gatewayInt.describe('Max candidates per product (default 8, max 20; -1 = all).'),
  category: z.string().optional().describe('Optional product category filter.'),
});

const listProductsSchema = z.looseObject({
  category: z.string().optional().describe('Optional category filter.'),
  keyword: z.string().optional().describe('Search products by name when the task does not name one.'),
});

const getProductSchema = z.looseObject({
  product: z.string().describe('Product short name, e.g. ECS, VPC, OBS (from search_apis or list_products).'),
  include_sops: z.boolean().optional().describe('Include full SOP texts (default false: name+description index only).'),
});

const listApisSchema = z.looseObject({
  product: z.string().describe('Product short name whose API catalog to list.'),
  tag: z.string().optional().describe('Filter by tag (see tag_groups in the result).'),
  search: z.string().optional().describe('Search within the product APIs by name.'),
  limit: gatewayInt.describe('Page size (default 20).'),
  offset: gatewayInt.describe('Page offset (default 0).'),
  include_sops: z.boolean().optional().describe('Include full SOP texts per page (default false: index only).'),
});

const getApiSchema = z.looseObject({
  product: z.string().describe('Product short name, e.g. ECS.'),
  api: z.string().describe('API name, e.g. ListServersDetails.'),
  region: z.string().optional().describe('Region for endpoint resolution; use the same region you will execute in.'),
});

const getApiExamplesSchema = z.looseObject({
  product: z.string().describe('Product short name, e.g. ECS.'),
  api: z.string().describe('API name, e.g. CreateServers.'),
  region: z.string().optional().describe('Region; same semantics as get_api.'),
});

async function handleSearchApis(args: Record<string, unknown>) {
  return callOpenMcpTool('search_apis', args);
}
async function handleListProducts(args: Record<string, unknown>) {
  return callOpenMcpTool('list_products', args);
}
async function handleGetProduct(args: Record<string, unknown>) {
  return callOpenMcpTool('get_product', args);
}
async function handleListApis(args: Record<string, unknown>) {
  return callOpenMcpTool('list_apis', args);
}
async function handleGetApi(args: Record<string, unknown>) {
  return callOpenMcpTool('get_api', args);
}
async function handleGetApiExamples(args: Record<string, unknown>) {
  return callOpenMcpTool('get_api_examples', args);
}

export const HUAWEICLOUD_OPEN_MCP_TOOLS = [
  {
    name: 'huaweicloud_search_apis',
    description:
      'Search the full Huawei Cloud API catalog (300+ products, 17,000+ APIs) by entity keywords when the intent does not name a product. Returns candidate products with representative APIs and match evidence. Step 0 of openapi discovery: search_apis → list_apis → get_api. Read-only; needs no credentials.',
    schema: searchApisSchema,
    handler: handleSearchApis,
  },
  {
    name: 'huaweicloud_list_products',
    description:
      'List Huawei Cloud products with categories and API counts, optionally filtered by category or keyword. Use when the task domain is known but the product is not, then narrow with huaweicloud_list_apis. Read-only; needs no credentials.',
    schema: listProductsSchema,
    handler: handleListProducts,
  },
  {
    name: 'huaweicloud_get_product',
    description:
      "Get one product's catalog entry (category, display name, whether it is a global-level service). Global-level services use a different auth model. Read-only; needs no credentials.",
    schema: getProductSchema,
    handler: handleGetProduct,
  },
  {
    name: 'huaweicloud_list_apis',
    description:
      'List the API catalog of one product with tag_groups for narrowing; paginate with search/limit/offset. Read the chosen API with huaweicloud_get_api before doing anything with it. Read-only; needs no credentials.',
    schema: listApisSchema,
    handler: handleListApis,
  },
  {
    name: 'huaweicloud_get_api',
    description:
      "Get one API's full documentation: method, path, parameter names/requiredness/types/enums, x-constraint preconditions, response schema, and the region-specific endpoint. Must-read before executing or hand-writing a call to that API. Read-only; needs no credentials.",
    schema: getApiSchema,
    handler: handleGetApi,
  },
  {
    name: 'huaweicloud_get_api_examples',
    description:
      'Get the official request examples (x-request-examples) for one API to guide parameter construction. Read-only; needs no credentials.',
    schema: getApiExamplesSchema,
    handler: handleGetApiExamples,
  },
] as const satisfies readonly PackToolDefinition[];

export type HuaweicloudOpenMcpToolName = (typeof HUAWEICLOUD_OPEN_MCP_TOOLS)[number]['name'];

export const HUAWEICLOUD_OPEN_MCP_TOOL_SCHEMAS: Readonly<Record<HuaweicloudOpenMcpToolName, LooseToolSchema>> = {
  huaweicloud_search_apis: searchApisSchema,
  huaweicloud_list_products: listProductsSchema,
  huaweicloud_get_product: getProductSchema,
  huaweicloud_list_apis: listApisSchema,
  huaweicloud_get_api: getApiSchema,
  huaweicloud_get_api_examples: getApiExamplesSchema,
};

export const HUAWEICLOUD_OPEN_MCP_TOOL_HANDLERS: Readonly<
  Record<HuaweicloudOpenMcpToolName, PackToolDefinition['handler']>
> = {
  huaweicloud_search_apis: handleSearchApis,
  huaweicloud_list_products: handleListProducts,
  huaweicloud_get_product: handleGetProduct,
  huaweicloud_list_apis: handleListApis,
  huaweicloud_get_api: handleGetApi,
  huaweicloud_get_api_examples: handleGetApiExamples,
};
