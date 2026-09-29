import { z } from 'zod';

import type { ToolName } from './tools.ts';
import type { LooseToolSchema } from './lib/pack-types.ts';
import { looseObject, numericArg } from './lib/tool-schema-parts.ts';
import { UPDATE_TOOL_SCHEMAS } from './packs/update/tools.ts';
import { AUTH_TOOL_SCHEMAS } from './packs/auth/tools.ts';
import { OBS_TOOL_SCHEMAS } from './packs/obs/tools.ts';
import { VOUCHER_TOOL_SCHEMAS } from './packs/voucher/tools.ts';
import { DISCOVERY_TOOL_SCHEMAS } from './packs/discovery/tools.ts';
import { SANDBOX_TOOL_SCHEMAS } from './packs/sandbox/tools.ts';

// LooseToolSchema now lives in src/lib/pack-types.ts (shared pack vocabulary);
// re-exported here so existing import sites keep working.
export type { LooseToolSchema };

// Keys stripped from z.toJSONSchema() output before huaweicloud_pack_info
// returns a tool schema: the MCP SDK renders tools/list through its draft-7
// compatibility layer while z.toJSONSchema() defaults to 2020-12, so the
// $schema discriminator is the only key that differs between the two renders.
export const SCHEMA_DRIFT_IGNORED_KEYS = ['$schema'] as const;

// Shared zod building blocks (numericArg, looseObject, gitConfig,
// workspaceId, username) moved to src/lib/tool-schema-parts.ts so the sandbox
// pack can value-import them without a cycle against this file's pack schema
// spreads.

const artifactsItem = z.looseObject({
  path: z.string(),
  content: z.string(),
});

const TOOL_SCHEMAS = {
  huaweicloud_check_cli: z.looseObject({}),
  huaweicloud_plan_cli_command: z.looseObject({
    args: z.array(z.string()).describe('hcloud arguments, excluding the hcloud executable.'),
    allowWrites: z.boolean().optional().describe('Only true after explicit user approval for this exact operation.'),
  }),
  huaweicloud_run_readonly_command: z.looseObject({
    args: z.array(z.string()),
    timeoutMs: numericArg.optional().describe('Optional timeout in milliseconds. Defaults to 60000.'),
    maxRetries: numericArg.optional().describe('Optional retry count for transient network errors. Defaults to 1.'),
    cwd: z.string().optional().describe('Optional working directory for the hcloud process.'),
  }),
  huaweicloud_list_operations: z.looseObject({
    service: z.string().describe('KooCLI service name, such as ECS, VPC, IMS, OBS, RDS, or CDN.'),
    timeoutMs: numericArg.optional().describe('Optional timeout in milliseconds. Defaults to 60000.'),
  }),
  huaweicloud_run_approved_command: z.looseObject({
    args: z.array(z.string()).describe('hcloud arguments, excluding the hcloud executable.'),
    approvalToken: z.string().describe('The approvalToken returned by huaweicloud_plan_cli_command.'),
    approvedByUser: z.boolean().describe('Must be true only after the user explicitly approves this exact command.'),
    timeoutMs: numericArg.optional().describe('Optional timeout in milliseconds. Defaults to 60000.'),
    maxRetries: numericArg.optional().describe('Optional retry count for transient network errors. Defaults to 1.'),
    cwd: z.string().optional().describe('Optional working directory for the hcloud process.'),
  }),
  huaweicloud_show_profile_redacted: z.looseObject({
    profile: z.string().optional().describe('Optional KooCLI profile name.'),
  }),
  huaweicloud_hook_check_command: z.looseObject({
    command: z.string().describe('The exact command text to inspect.'),
  }),
  huaweicloud_hook_check_artifacts: z.looseObject({
    artifacts: z.array(artifactsItem),
  }),
  huaweicloud_hook_check_deploy_plan: z.looseObject({
    plan: z
      .union([looseObject, z.array(z.unknown()), z.string()])
      .describe('Deployment plan as an object, array, or string.'),
  }),
  huaweicloud_service_catalog: z.looseObject({
    intent: z
      .string()
      .optional()
      .describe('Developer intent to route, such as deploy app, use API, debug error, or inspect resources.'),
  }),
  huaweicloud_explain_error: z.looseObject({
    service: z.string().optional(),
    errorCode: z.string().optional(),
    message: z.string().optional(),
    requestId: z.string().optional(),
  }),
  huaweicloud_search_docs: z.looseObject({
    query: z.string().describe('Search query across skill descriptions and documentation.'),
    topic: z
      .string()
      .optional()
      .describe('Optional filter: all | ecs | obs | vpc | iam | rds | cce | modelarts | dew. Defaults to all.'),
  }),
  huaweicloud_retrieve_skill: z.looseObject({
    name: z.string().describe('Skill name, e.g., huaweicloud-core, huawei-ecs, huawei-obs.'),
  }),
  huaweicloud_list_regions: z.looseObject({}),
  huaweicloud_get_regional_availability: z.looseObject({
    service: z.string().describe('Service name: ecs, obs, rds, gaussdb, cce, modelarts, functiongraph, etc.'),
    region: z.string().describe('Region ID: cn-south-1, cn-north-4, ap-southeast-3, etc.'),
  }),
  // The discovery pack owns its tool schemas (src/packs/discovery/tools.ts);
  // the spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers all 42 ToolName keys.
  ...DISCOVERY_TOOL_SCHEMAS,
  // The obs pack owns its tool schemas (src/packs/obs/tools.ts); the
  // spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers all 42 ToolName keys.
  ...OBS_TOOL_SCHEMAS,
  // The voucher pack owns its tool schemas (src/packs/voucher/tools.ts);
  // the spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers all 42 ToolName keys.
  ...VOUCHER_TOOL_SCHEMAS,
  // The auth pack owns its tool schemas (src/packs/auth/tools.ts); the
  // spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers all 42 ToolName keys.
  ...AUTH_TOOL_SCHEMAS,
  // The sandbox pack owns its tool schemas (src/packs/sandbox/tools.ts);
  // the spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers all 42 ToolName keys.
  ...SANDBOX_TOOL_SCHEMAS,
  // The update pack owns its tool schemas (src/packs/update/tools.ts); the
  // spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers all 42 ToolName keys.
  ...UPDATE_TOOL_SCHEMAS,
  huaweicloud_list_packs: z.looseObject({}),
  huaweicloud_pack_info: z.looseObject({
    pack: z
      .string()
      .describe('Pack id from huaweicloud_list_packs, such as core, sandbox, auth, obs, voucher, update, discovery.'),
  }),
} satisfies Record<ToolName, LooseToolSchema>;

export type ToolSchemaMap = typeof TOOL_SCHEMAS;
export type ToolSchemaEntry = ToolSchemaMap[ToolName];

export function getToolSchema(name: ToolName): LooseToolSchema {
  return TOOL_SCHEMAS[name];
}

export function toolSchemaEntries(): Array<[ToolName, LooseToolSchema]> {
  return Object.entries(TOOL_SCHEMAS) as Array<[ToolName, LooseToolSchema]>;
}

// Runtime guard: every entry must be a constructed zod loose-object. A bare
// raw shape would be wrapped by the SDK into STRIP semantics, silently
// dropping client keys instead of passing them through.
export function assertConstructedSchemas(): void {
  for (const [name, schema] of toolSchemaEntries()) {
    const def = (schema as unknown as { _zod?: { def?: { shape?: unknown } } })._zod?.def;
    if (!def || !('shape' in def)) {
      throw new Error(`tool schema for ${name} is not a constructed zod loose-object`);
    }
  }
}

export { TOOL_SCHEMAS };
