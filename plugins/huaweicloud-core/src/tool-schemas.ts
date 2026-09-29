import { z } from 'zod';

import type { ToolName } from './tools.ts';
import type { LooseToolSchema } from './lib/pack-types.ts';
import { looseObject, numericArg, gitConfig, workspaceId, username } from './lib/tool-schema-parts.ts';
import { UPDATE_TOOL_SCHEMAS } from './packs/update/tools.ts';

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
  huaweicloud_search_marketplace: z.looseObject({
    query: z.string().optional().describe('Search query across skill name, description, triggers, and service.'),
    category: z
      .string()
      .optional()
      .describe('Optional category filter: computing, storage, network, security, devtools, monitoring, etc.'),
  }),
  huaweicloud_get_service_icon: z.looseObject({
    service: z
      .string()
      .optional()
      .describe(
        'Service name, alias, or Chinese name, e.g. ecs, obs, modelarts, 对象存储, 虚拟私有云. Omit to browse by category only.',
      ),
    category: z
      .string()
      .optional()
      .describe('Optional category filter, e.g. 计算, 存储, 网络, 人工智能, 数据库, 安全, 企业应用.'),
  }),
  huaweicloud_detect_framework: z.looseObject({
    projectPath: z.string().describe('Absolute path to the local project directory to scan.'),
  }),
  huaweicloud_setup_obs_config: z.looseObject({
    profile: z.string().optional().describe('Optional KooCLI profile name. Uses the active profile by default.'),
  }),
  huaweicloud_auth_status: z.looseObject({
    target: z
      .string()
      .optional()
      .describe(
        'Agent target to check: opencode, codex, codex-desktop, codearts, codearts-work, workbuddy, dsh, officeace, hermes, openclaw, atomcode, or all (default).',
      ),
  }),
  huaweicloud_auth_sync: z.looseObject({
    target: z
      .string()
      .optional()
      .describe(
        'Agent target to report after sync: opencode, codex, codex-desktop, codearts, codearts-work, workbuddy, dsh, officeace, hermes, or all (default).',
      ),
  }),
  huaweicloud_auth_init: z.looseObject({
    ak: z.string().optional().describe('Huawei Cloud Access Key (required unless clear=true)'),
    sk: z.string().optional().describe('Huawei Cloud Secret Key (required unless clear=true)'),
    region: z.string().optional().describe('Default region (optional)'),
    clear: z.boolean().optional().describe('Set to true to clear runtime credentials and revert to env/file'),
  }),
  huaweicloud_auth_switch: z.looseObject({
    mode: z.enum(['import', 'memory', 'mcp-config']).optional().describe('Credential source channel'),
    action: z.enum(['persist', 'temporary', 'clear']).optional().describe('Apply scope'),
    ak: z.string().optional(),
    sk: z.string().optional(),
    securityToken: z.string().optional(),
    region: z.string().optional(),
  }),
  huaweicloud_auth_confirm: z.looseObject({
    token: z.string().optional().describe('confirmation token from the needs_confirmation response'),
    decision: z.enum(['s1', 'newImported']).optional(),
  }),
  huaweicloud_sandbox_exec_with_session: z.looseObject({
    command: z.string().describe('The shell command to execute on the remote workspace'),
    workspace_id: workspaceId,
    username,
    timeout_ms: numericArg.optional().describe('Execution timeout in milliseconds (default: 120000)'),
  }),
  huaweicloud_sandbox_exec_one_shot: z.looseObject({
    command: z.string().describe('The shell command to execute on the remote workspace'),
    workspace_id: workspaceId,
    username,
    timeout_ms: numericArg.optional().describe('Execution timeout in milliseconds (default: 120000)'),
  }),
  huaweicloud_sandbox_close_session: z.looseObject({
    workspace_id: workspaceId,
    username,
  }),
  huaweicloud_sandbox_upload_file: z.looseObject({
    local_path: z.string().describe('Absolute path to the local file to upload.'),
    remote_path: z.string().describe('Target path in the sandbox, e.g. /workspace/<repo>/index.html.'),
    workspace_id: workspaceId,
    username,
    timeout_ms: numericArg.optional().describe('Execution timeout in milliseconds (default: 60000)'),
  }),
  huaweicloud_sandbox_upload_project: z.looseObject({
    local_dir: z.string().describe('Local project directory to upload.'),
    remote_dir: z
      .string()
      .optional()
      .describe(
        'Remote parent directory where project will be extracted (default: /workspace). Final layout: <remote_dir>/<dirname>/',
      ),
    workspace_id: workspaceId,
    username,
    exclude: z
      .array(z.string())
      .optional()
      .describe('Patterns to exclude from archive (default: .git, node_modules, __pycache__, .venv)'),
    extract: z.boolean().optional().describe('Extract tar.gz on sandbox after upload (default: true)'),
    timeout_ms: numericArg.optional().describe('Execution timeout in milliseconds (default: 300000)'),
  }),
  huaweicloud_sandbox_deploy_nginx: z.looseObject({
    nginx_type: z
      .enum(['spa', 'proxy', 'static'])
      .describe(
        'Nginx config type from framework detection: spa (try_files fallback for SPA/SSG/cross-platform), proxy (reverse proxy for SSR), or static (plain root for Hugo/Hexo).',
      ),
    port: z.number().describe('Listen port (from framework detection).'),
    project: z.string().describe('Project directory name under /workspace, e.g. movie-ticket.'),
    output_dir: z.string().describe('Build output directory relative to /workspace/<project>, e.g. dist/build/h5.'),
    node_port: z.number().optional().describe('Node.js app port for SSR (required when nginx_type=proxy).'),
    public_port: z.number().optional().describe('Public listen port for SSR proxy (optional, defaults to port).'),
    config_name: z
      .string()
      .optional()
      .describe(
        'Config file name (without .conf suffix). Defaults to the project name, ensuring each project gets its own config. Override with distinct names (e.g. admin, docs) for sub-app deployments.',
      ),
    workspace_id: workspaceId,
    username,
    timeout_ms: numericArg.optional().describe('Execution timeout in milliseconds (default: 30000)'),
  }),
  huaweicloud_sandbox_deploy_check: z.looseObject({
    port: z.number().describe('App listen port (from framework detection).'),
    project: z.string().describe('Project directory name under /workspace.'),
    output_dir: z.string().describe('Build output directory relative to /workspace/<project>, e.g. dist/build/h5.'),
    framework_type: z
      .enum(['spa', 'ssr', 'ssg', 'cross-platform', 'monorepo', 'static'])
      .optional()
      .describe('Framework type from detect_framework. Set to cross-platform for QR code check.'),
    workspace_id: workspaceId,
    username,
    timeout_ms: numericArg.optional().describe('Execution timeout in milliseconds (default: 30000)'),
  }),
  huaweicloud_sandbox_check_user: z.looseObject({}),
  huaweicloud_sandbox_sign_agreement: z.looseObject({}),
  huaweicloud_sandbox_connect: z.looseObject({
    source: z
      .string()
      .optional()
      .describe('Source identifier (default: WEB). Options: VSCODE, CLI, WEB, WEBVNC, WEBPTY, WEBIDE, CURSOR, etc.'),
    template_id: z.string().optional().describe('Template ID; overrides server default (only for new sandbox)'),
    flavor_id: z.string().optional().describe('Flavor ID; overrides server default (only for new sandbox)'),
    env: looseObject.optional().describe('Environment variables to set in the sandbox (only for new sandbox)'),
    git: gitConfig.optional().describe('Git repo config (only for new sandbox)'),
  }),
  huaweicloud_sandbox_credentials: z.looseObject({
    session_id: z.string().optional().describe('Session ID from huaweicloud_sandbox_connect'),
    dev_stage_id: z.string().optional().describe('DevStation environment ID (alternative to session_id)'),
    enable_sts: z.boolean().optional().describe('Whether to enable STS temporary AK/SK (default: true)'),
    region: z
      .string()
      .optional()
      .describe(
        'Region used for IAM credential validation and project_id resolution (defaults to the configured region)',
      ),
    api_key: z
      .string()
      .optional()
      .describe(
        'DevBridge API Key (devbridge_...), injected into the sandbox as HW_API_KEY for devbridge 0.2.x auth. The local HW_API_KEY environment variable takes precedence over this param (preferred delivery — keeps the long-lived key out of the conversation). Users create one at https://devstation.connect.huaweicloud.com/space/devbridge/apikey (full value shown once at creation). Required for exposing web apps via devbridge 0.2.x; if missing, guide the user through creating one.',
      ),
  }),
  huaweicloud_voucher_status: z.looseObject({
    domain_id: z
      .string()
      .optional()
      .describe('Optional. Leave empty in production — account is resolved from IAM automatically.'),
  }),
  huaweicloud_voucher_claim: z.looseObject({
    domain_id: z
      .string()
      .optional()
      .describe('Optional. Leave empty in production — account is resolved from IAM automatically.'),
  }),
  // The update pack owns its tool schemas (src/packs/update/tools.ts); the
  // spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers all 42 ToolName keys.
  ...UPDATE_TOOL_SCHEMAS,
  huaweicloud_obs_set_website_config: z.looseObject({
    action: z
      .enum(['set', 'get', 'delete'])
      .describe('操作类型：set=配置静态网站托管，get=查询当前配置，delete=删除配置'),
    bucket: z.string().describe('OBS 桶名称'),
    region: z.string().describe('OBS 桶所在区域，如 cn-north-4'),
    indexDocument: z.string().optional().describe('首页文件名（action=set 时必填），如 index.html'),
    errorDocument: z.string().optional().describe('错误页面文件名（action=set 时可选），如 404.html 或 error.html'),
  }),
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
