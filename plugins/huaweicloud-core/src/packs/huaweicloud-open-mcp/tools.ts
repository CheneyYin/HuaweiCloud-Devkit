import { z } from 'zod';

import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import { consumeApprovalToken, createApprovalToken, hashArgs } from '../../lib/approval-tokens.ts';
import { redactSecrets } from '../../safety-policy.ts';
import {
  classify,
  GATEWAY_TOOL_VOCABULARY,
  matchingDenyRule,
  resolveApprovalMode,
  ruleSemanticKey,
  type ApprovalMode,
} from './approval.ts';
import {
  callOpenMcpTool,
  listGatewayTools,
  openMcpSidecar,
  restartOpenMcpSidecar,
  _gatewaySurface,
  type OpenMcpToolResult,
} from './sidecar.ts';

// Nine tools over the huaweicloud-open-mcp gateway: six metadata proxies
// (search_apis, list_products, get_product, list_apis, get_api,
// get_api_examples — src/mcp_openapi/server.py), one lifecycle tool that
// recycles the gateway child in-session, and two generic faces over the
// child's full surface. The gateway is the authoritative validator of its
// own tool inputs; these zod schemas only guard the boundary (required
// identity fields plus passthrough), and the sidecar normalizes results to
// {ok, tool, ...}.
// State-changing gateway tools are reachable only through
// huaweicloud_gateway_call: approval.ts classifies each call, read-only
// discovery passes through, everything else mints a plan-bound approval
// token, and the devkit-mode execute_api path bridges through a once-scope
// policy grant added and removed around the approved call.

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
  approvalToken: z.string().optional().describe('The approvalToken from the first call; required with approvedByUser.'),
  approvedByUser: z
    .boolean()
    .optional()
    .describe('Only true after the user explicitly approved this exact tool and arguments.'),
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

const GATEWAY_CALL_APPROVAL_NOTE =
  'Present the tool and arguments to the user. Re-send with approvalToken and approvedByUser:true and your ORIGINAL unredacted toolArgs (the echoed copy is redacted); any scope value is matched in its normalized lowercase form, so either spelling works. Scope labels translated: once/session/temporary grants live for this server process (shared across its HTTP sessions); permanent is not grantable through this face.';

async function handleGatewayCall(args: Record<string, unknown>) {
  const tool = String(args.tool || '').trim();
  const rawToolArgs = args.toolArgs;
  if (!tool) return { ok: false, error: 'tool is required' };
  // Explicit, not silent coercion: the MCP boundary already rejects these
  // shapes, but direct callTool callers would otherwise mint a token for
  // an empty plan while believing they sent arguments.
  if (
    rawToolArgs !== undefined &&
    (rawToolArgs === null || typeof rawToolArgs !== 'object' || Array.isArray(rawToolArgs))
  ) {
    const shape = Array.isArray(rawToolArgs) ? 'an array' : `a ${typeof rawToolArgs}`;
    return { ok: false, error: `toolArgs must be an object when provided (got ${shape})` };
  }
  const toolArgs = (rawToolArgs ?? {}) as Record<string, unknown>;

  let mode: ApprovalMode;
  try {
    mode = resolveApprovalMode();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    // Awaiting the sidecar also populates the surface cache classify reads.
    await openMcpSidecar();
  } catch (error) {
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }

  const ruling = classify(tool, toolArgs, mode, _gatewaySurface());
  if (ruling.verdict === 'deny') {
    return { ok: false, classification: 'deny', error: ruling.reason };
  }
  if (ruling.verdict === 'passthrough') {
    return await callOpenMcpTool(tool, toolArgs);
  }

  // The token binds the NORMALIZED scope AND action, not the raw spelling:
  // classify accepted ' ONCE '/'Once' and 'ADD'/' add ' by trimming and
  // lowercasing, but the gateway must receive exactly the canonical form
  // (round-5 probe: a verbatim ' ONCE ' grant never burned; round-7: an
  // 'ADD' mint burned the approval on a guaranteed gateway rejection). The
  // mint echo shows the normalized shape; the replay hash also normalizes,
  // so any accepted spelling replays.
  let boundArgs = toolArgs;
  if (tool === 'manage_policy') {
    const next: Record<string, unknown> = { ...toolArgs };
    let changed = false;
    if (typeof toolArgs.scope === 'string') {
      const normalized = toolArgs.scope.trim().toLowerCase();
      if (normalized !== toolArgs.scope) {
        next.scope = normalized;
        changed = true;
      }
    }
    if (typeof toolArgs.action === 'string') {
      const normalized = toolArgs.action.trim().toLowerCase();
      if (normalized !== toolArgs.action) {
        next.action = normalized;
        changed = true;
      }
    }
    if (changed) boundArgs = next;
  }

  if (args.approvedByUser !== true) {
    return {
      ok: false,
      requiresApproval: true,
      classification: 'token',
      tool,
      toolArgs: redactSecrets(boundArgs),
      approvalToken: createApprovalToken({ tool, toolArgs: boundArgs }),
      note: GATEWAY_CALL_APPROVAL_NOTE,
    };
  }

  // Operator deny beats token spend: the pre-check runs before
  // consumeApprovalToken, so a refused call leaves the token consumable
  // once the operator adjusts the policy file.
  let product = '';
  let api = '';
  if (tool === 'execute_api' && mode === 'devkit') {
    product = typeof toolArgs.product === 'string' ? toolArgs.product : '';
    api = typeof toolArgs.api === 'string' ? toolArgs.api : '';
    const validIdentity =
      product.trim() !== '' && api.trim() !== '' && !/[*#:=\n\r\t]/.test(product) && !/[*#:=\n\r\t]/.test(api);
    if (!validIdentity) {
      return { ok: false, error: 'execute_api requires non-empty product and api without wildcards' };
    }
    const denial = matchingDenyRule(product, api);
    if (denial) {
      if (denial.unparseable) {
        return {
          ok: false,
          error: `the policy file contains a line the gateway itself cannot load (${denial.line}); the gateway keeps its last valid rules and ignores that line, but this face denies until it is fixed or removed.`,
        };
      }
      return {
        ok: false,
        error: `operator policy denies this call (${denial.line}); remove or adjust the deny rule in the policy file before approving`,
      };
    }
    // A pre-existing rule the gateway would treat as the bridge's own
    // makes the bridge unsafe: its cleanup removes by semantic key, first
    // match, so it would delete the existing grant and leave its own
    // once-grant standing (round-5 probe; round-7: the comparison is the
    // gateway's semantic key, not the literal line — a spaced or
    // lowercased operator line previously bypassed this check while the
    // gateway's remove still deleted the rule). Refused before the token
    // is consumed; removing the conflicting rule and retrying the SAME
    // approved call works.
    const grantLine = `${product}:${api}=allow`;
    const conflict = await sameLineRuleExists(grantLine);
    if (conflict === 'conflict') {
      return {
        ok: false,
        error: `a policy rule equivalent to "${grantLine}" already exists; the execute bridge refuses to run beside it because its cleanup would remove that rule and leave its own grant. Remove the conflicting rule first (gateway_call manage_policy remove, which requires user approval), then retry this call with the same token.`,
      };
    }
    if (conflict.startsWith('listing-failed:')) {
      return {
        ok: false,
        error: `the policy listing failed (${conflict.slice('listing-failed:'.length)}); the execute bridge refuses to run blind — a rule it cannot read could still collide with its cleanup. Recycle the gateway (huaweicloud_gateway_restart) or check that manage_policy is available, then retry this call with the same token.`,
      };
    }
  }

  const stored = consumeApprovalToken(String(args.approvalToken || ''));
  if (!stored) {
    return { ok: false, error: 'Invalid or expired approval token. Re-plan the call.' };
  }
  // Both hash sides carry the NORMALIZED scope (the mint bound it): a
  // replay in the spelling classify accepted (' ONCE ', 'Once') normalizes
  // to the same value, so following the note's instruction cannot waste
  // the approval on a spelling mismatch.
  if (hashArgs({ tool, toolArgs: boundArgs }) !== stored.argsHash) {
    return {
      ok: false,
      error:
        'Arguments do not match the approved plan. Re-send your ORIGINAL unredacted toolArgs exactly as echoed; the approval echo showed a redacted copy.',
    };
  }
  if (tool === 'execute_api' && mode === 'devkit') {
    return await bridgeExecuteApi(product, api, boundArgs);
  }
  return await callOpenMcpTool(tool, boundArgs);
}

type ConflictCheck = 'no-conflict' | 'conflict' | `listing-failed:${string}`;

// The bridge cannot safely create its once-grant when a semantically
// equal rule already exists: the gateway's remove matches on its semantic
// rule key (kind/connect_only/product/api-pattern/allow, case- and
// whitespace-insensitive, comment-tolerant), so the bridge's cleanup would
// delete that rule — whatever spelling it was written in — and leave its
// own. Checked live through the gateway (overlay + file), not against a
// cached snapshot. Tri-state with the failure detail inline:
// 'listing-failed:<reason>' is NOT a conflict and must not be reported as
// one (round-7: the conflated message sent the agent to remove a rule
// that did not exist).
async function sameLineRuleExists(line: string): Promise<ConflictCheck> {
  const listing = await callOpenMcpTool('manage_policy', { action: 'list' });
  if (!listing.ok) {
    return `listing-failed:${String(listing.error ?? 'unknown error')}`;
  }
  // The listing exposes rules in two layers: the structured rules array
  // (overlay rules with their scope, plus the file's semantic lines with
  // scope 'permanent' — list_rules appends both) AND the policy file's
  // raw text in the 'policy' string field (including comments and the
  // verbatim spacing). Reading BOTH is the superset that survives either
  // layer being reduced; the raw text is also the only place verbatim
  // spacing survives redaction of the structured echo. Both layers reduce
  // through the semantic key.
  const candidates: string[] = [];
  if (Array.isArray(listing.rules)) {
    for (const rule of listing.rules) {
      if (typeof rule === 'string') candidates.push(rule);
      else if (rule !== null && typeof rule === 'object') {
        const ruleLine = String((rule as Record<string, unknown>).line);
        if (ruleLine !== '') candidates.push(ruleLine);
      }
    }
  }
  if (typeof listing.policy === 'string' && listing.policy.trim() !== '') {
    candidates.push(...listing.policy.split('\n'));
  }
  if (candidates.length === 0 && !Array.isArray(listing.rules)) {
    return `listing-failed:rules neither array nor policy text (${JSON.stringify(listing).slice(0, 120)})`;
  }
  // The listing crossed the result-redaction boundary, so a line for a
  // token/password-suffixed API arrives as '...:<redacted>' while the
  // local grantLine is raw (round-6). Both sides go through the same
  // redactor so the redacted pair still matches, AND both sides reduce to
  // the gateway's semantic key so spelling variants cannot slip past
  // (round-7: 'ECS : CreateServers = allow' previously bypassed this
  // check while the gateway's semantic remove deleted the rule).
  const grantKey = ruleSemanticKey(String(redactSecrets(line)));
  const rawGrantKey = ruleSemanticKey(line);
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue;
    const candidateKey = ruleSemanticKey(candidate);
    if (candidateKey === rawGrantKey || candidateKey === grantKey) {
      return 'conflict';
    }
  }
  return 'no-conflict';
}

// One in-flight bridge per product:api. Two approved calls for the same API
// would otherwise race their once-grants — call A adds the grant, call B
// adds it again, A's execute burns one copy, B's execute burns the other,
// and A's cleanup removes a grant B still expects. Tail-chaining the gate
// closes the race structurally: the second call's grant exists only after
// the first call's cleanup finished.
const bridgeLocks = new Map<string, Promise<unknown>>();

async function bridgeExecuteApi(
  product: string,
  api: string,
  toolArgs: Record<string, unknown>,
): Promise<OpenMcpToolResult> {
  const key = `${product}:${api}`;
  const previous = bridgeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  bridgeLocks.set(key, gate);
  await previous;
  try {
    return await forwardWithOnceGrant(product, api, toolArgs);
  } finally {
    release();
    if (bridgeLocks.get(key) === gate) bridgeLocks.delete(key);
  }
}

async function forwardWithOnceGrant(
  product: string,
  api: string,
  toolArgs: Record<string, unknown>,
): Promise<OpenMcpToolResult> {
  const line = `${product}:${api}=allow`;
  // The internal grant add bypasses the agent-facing classifier: the line
  // is derived from token-bound product/api, never free agent input.
  const grant = await callOpenMcpTool('manage_policy', { action: 'add', line, scope: 'once' });
  if (!grant.ok) return grant;
  let grantsLive = 1;
  try {
    const first = await callOpenMcpTool('execute_api', toolArgs);
    if (first.ok) return first;
    // Only a safety-policy refusal proves non-execution: the gateway
    // rejected the call before running anything, so one approval may
    // re-send it (the child may have restarted between grant and call,
    // coming back with an empty overlay). A timeout or a sidecar failure
    // leaves the execution state UNKNOWN — the server may have completed
    // the write — and re-sending would spend one approval twice.
    if (/safety policy/.test(String(first.error ?? ''))) {
      const reAdd = await callOpenMcpTool('manage_policy', { action: 'add', line, scope: 'once' });
      if (reAdd.ok) {
        grantsLive += 1;
        const second = await callOpenMcpTool('execute_api', toolArgs);
        return second;
      }
    }
    return first;
  } finally {
    // One remove per live grant: a doubly-refused bridge leaves two adds,
    // and a single remove would strand a standing once-authorization for
    // exactly this product:api. Burned grants are already gone; removing
    // a missing line is a harmless best-effort no-op either way.
    for (let index = 0; index < grantsLive; index += 1) {
      await callOpenMcpTool('manage_policy', { action: 'remove', line });
    }
  }
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
