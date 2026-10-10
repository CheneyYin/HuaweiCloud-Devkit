import { z } from 'zod';

import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import { redactSecrets } from '../../safety-policy.ts';
import { classify, GATEWAY_TOOL_VOCABULARY, resolveApprovalMode } from './approval.ts';
import { callOpenMcpTool, listGatewayTools, openMcpSidecar, restartOpenMcpSidecar } from './sidecar.ts';

// Nine tools over the huaweicloud-open-mcp gateway: six metadata proxies
// (search_apis, list_products, get_product, list_apis, get_api,
// get_api_examples — src/mcp_openapi/server.py), one lifecycle tool that
// recycles the gateway child in-session, and two generic faces over the
// child's full surface. The gateway is the authoritative validator of its
// own tool inputs; these zod schemas only guard the boundary (required
// identity fields plus passthrough), and the sidecar normalizes results to
// {ok, tool, ...}.
// Every gateway tool is reachable through huaweicloud_gateway_call on the
// delegated approval face: approval.ts rules only the devkit floors
// (secret operations, the protected state tree, manage_policy shape) and
// forwards everything else to the gateway's own policy engine, whose
// refusal reason teaches the consent flow (confirm with the user, grant
// via manage_policy with an ephemeral scope, retry).

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

const gatewayRestartSchema = z.looseObject({});

const gatewayListToolsSchema = z.looseObject({});

const gatewayCallSchema = z.looseObject({
  tool: z.string().describe('Gateway tool name, e.g. execute_api, query_data (see huaweicloud_gateway_list_tools).'),
  toolArgs: z.record(z.string(), z.unknown()).optional().describe('Arguments object for the gateway tool.'),
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

// In-process lifecycle only — no hcloud I/O, so no approval token (the
// auth_init class of state mutation, not the run_approved_command class).
async function handleGatewayRestart() {
  try {
    const { pid, spawns } = await restartOpenMcpSidecar();
    return { ok: true, pid, spawns, note: 'gateway recycled; an upgraded binary is now active' };
  } catch (error) {
    // The spawn/handshake rejection can embed child stderr; same envelope
    // callOpenMcpTool already redacts one layer down.
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
}

// The devkit's projection of the gateway surface, DERIVED from the one
// vocabulary table in approval.ts (readonly + routed): the six read-only
// discovery tools plus the four stateful names classify() routes.
// gateway_list_tools reports drift between this list and the child's live
// tools/list so an agent can see what a generic call can reach.
const KNOWN_GATEWAY_TOOLS: readonly string[] = [...GATEWAY_TOOL_VOCABULARY.readonly, ...GATEWAY_TOOL_VOCABULARY.routed];

async function handleGatewayListTools() {
  try {
    const tools = await listGatewayTools();
    const live = new Set(tools.map((entry) => entry.name));
    const missing = KNOWN_GATEWAY_TOOLS.filter((name) => !live.has(name));
    return {
      ok: true,
      count: tools.length,
      tools,
      drift: {
        missing,
        note:
          missing.length > 0
            ? `warning: the live gateway surface no longer exposes ${missing.join(', ')}; state-changing names among them are denied as drift before consent, read-only names pass through and fail at the gateway`
            : 'the live surface covers every gateway tool the devkit projects',
      },
    };
  } catch (error) {
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
}

async function handleGatewayCall(args: Record<string, unknown>) {
  const tool = String(args.tool || '').trim();
  const rawToolArgs = args.toolArgs;
  if (!tool) return { ok: false, error: 'tool is required' };
  // Explicit, not silent coercion: the MCP boundary already rejects these
  // shapes, but direct callTool callers would otherwise forward a call
  // built on an empty plan while believing they sent arguments.
  if (
    rawToolArgs !== undefined &&
    (rawToolArgs === null || typeof rawToolArgs !== 'object' || Array.isArray(rawToolArgs))
  ) {
    const shape = Array.isArray(rawToolArgs) ? 'an array' : `a ${typeof rawToolArgs}`;
    return { ok: false, error: `toolArgs must be an object when provided (got ${shape})` };
  }
  const toolArgs = (rawToolArgs ?? {}) as Record<string, unknown>;

  try {
    resolveApprovalMode();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // Floors refuse before the sidecar is even spawned: they are local
  // decisions over the arguments, and a denial must not depend on (or
  // pay for) a live gateway child.
  const ruling = classify(tool, toolArgs);
  if (ruling.verdict === 'deny') {
    return { ok: false, classification: 'deny', error: ruling.reason };
  }

  try {
    await openMcpSidecar();
  } catch (error) {
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
  return await callOpenMcpTool(tool, toolArgs);
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
  {
    name: 'huaweicloud_gateway_list_tools',
    description:
      "List the open-mcp gateway child's live tool surface (names, descriptions, input schemas) as its tools/list reports. Use it to check gateway capabilities and drift from the devkit projection before generic calls. Read-only; needs no credentials.",
    schema: gatewayListToolsSchema,
    handler: handleGatewayListTools,
  },
  {
    name: 'huaweicloud_gateway_call',
    description:
      'Call one open-mcp gateway tool generically with tool and toolArgs. Read-only discovery tools pass through. State-changing tools (execute_api, manage_policy grants, transform_data, query_data, unknown tools) require user approval: the first call returns an approvalToken bound to the exact tool and arguments; re-send with approvalToken and approvedByUser:true after the user approves. Secret reads, permanent grants, and writes into devkit state are denied outright. With HUAWEICLOUD_OPENMCP_APPROVAL=native, execute_api delegates to the gateway policy engine instead of per-call tokens.',
    schema: gatewayCallSchema,
    handler: handleGatewayCall,
  },
  {
    name: 'huaweicloud_gateway_restart',
    description:
      'Recycle the open-mcp gateway child of this MCP server process, e.g. after upgrading the gateway on the host (npx huaweicloud-devkit dep install open-mcp-gateway) while the session was live. In-flight gateway calls are interrupted when the old child stops. No arguments. In-process lifecycle only; needs no credentials.',
    schema: gatewayRestartSchema,
    handler: handleGatewayRestart,
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
  huaweicloud_gateway_list_tools: gatewayListToolsSchema,
  huaweicloud_gateway_call: gatewayCallSchema,
  huaweicloud_gateway_restart: gatewayRestartSchema,
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
  huaweicloud_gateway_list_tools: handleGatewayListTools,
  huaweicloud_gateway_call: handleGatewayCall,
  huaweicloud_gateway_restart: handleGatewayRestart,
};
