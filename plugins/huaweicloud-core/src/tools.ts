import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { evaluateArtifacts, evaluateCommandRisk, evaluateDeployPlan, type RiskEvaluation } from './risk-rule-engine.ts';
import { classifyTextCommand, redactSecrets } from './safety-policy.ts';
import { planHcloudCommand, runHcloud, consumeApprovalToken, hashArgs, type HcloudRunResult } from './hcloud-cli.ts';
import { trackToolInvoke, trackSkillRetrieve } from './telemetry/telemetry.ts';
import { hcloudProbeNextStep, probeHcloud, type ProbeHcloudOptions } from './hcloud-probe.ts';
// The update tool handlers live in the update pack's handler map (merged
// into PACK_TOOL_HANDLERS); only the DistTags type for the CallToolOptions
// doQuery seam is still needed here.
import type { DistTags } from './update-check.ts';
import { getToolSchema, SCHEMA_DRIFT_IGNORED_KEYS } from './tool-schemas.ts';
// PACK_TOOL_HANDLERS is the central pack dispatch table (its satisfies check
// pins every PackToolName to a handler); PACKS feeds the pack meta tools.
import { PACKS, PACK_TOOL_HANDLERS, isPackToolName, type PackToolName } from './packs/registry.ts';
import { resolveEnabledPacks } from './packs/enable.ts';
import type { PackId } from './lib/pack-types.ts';
// Service region descriptor (the old inline `known` table in
// getRegionalAvailability, migrated verbatim — see services/regions.ts for
// its guarantee scope).
import { SERVICE_REGIONS } from './services/regions.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The skills tree is server data, not an agent-native artifact: it ships next
// to dist/ (esbuild preserves import.meta.url, so the bundled mcp-server.js
// resolves this relative to its own location) and is disclosed only through
// the MCP tools (list_packs / pack_info / retrieve_skill / search_docs).
const SKILLS_ROOT = join(__dirname, '..', 'skills');

// ── Boundary narrowing helpers ──
// Tool arguments, import-file JSON, and JS-module returns are untrusted at this
// boundary: values land as unknown and are narrowed with typeof/Array.isArray
// checks (same guarded-asRecord style as mcp-protocol.ts / hcloud-cli.ts).

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function listSkillDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && existsSync(join(root, d.name, 'SKILL.md')))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ── Tool registry ──
// TOOL_DEFINITIONS_LITERALS is the single source of truth for names and
// descriptions. `as const` keeps the tool names literal so ToolName below is
// derived from the registry itself. callTool dispatches on two paths, both
// closed at compile time: pack tools (PACK_OF owners ≠ core) go through the
// central PACK_TOOL_HANDLERS map (satisfies-checked in packs/registry.ts),
// core tools through the switch below whose never-guard pins every core
// name to a case. Input schemas live in tool-schemas.ts (zod, single
// source of truth for validation and tools/list rendering); its
// `satisfies Record<ToolName, ...>` check pins the schema map to exactly
// these names.
const TOOL_DEFINITIONS_LITERALS = [
  {
    name: 'huaweicloud_check_cli',
    description:
      'Check whether Huawei Cloud KooCLI hcloud is installed and whether its version matches the plugin paired version. Returns redacted output.',
  },
  {
    name: 'huaweicloud_plan_cli_command',
    description: 'Classify and plan a Huawei Cloud hcloud command without executing it.',
  },
  {
    name: 'huaweicloud_run_readonly_command',
    description: 'Run a read-only hcloud command through the toolkit safety policy and redact output.',
  },
  {
    name: 'huaweicloud_list_operations',
    description:
      'List KooCLI operations for a Huawei Cloud service by running local/read-only hcloud <Service> --help.',
  },
  {
    name: 'huaweicloud_run_approved_command',
    description:
      'Run a write-capable hcloud command only after the exact command has been shown and explicitly approved by the user.',
  },
  {
    name: 'huaweicloud_show_profile_redacted',
    description: 'Inspect a KooCLI profile through hcloud configure show and return only redacted output.',
  },
  {
    name: 'huaweicloud_hook_check_command',
    description: 'Check a planned shell or hcloud command against Huawei Cloud hook risk rules without executing it.',
  },
  {
    name: 'huaweicloud_hook_check_artifacts',
    description: 'Check generated code, IaC, policy, or config artifacts against Huawei Cloud hook risk rules.',
  },
  {
    name: 'huaweicloud_hook_check_deploy_plan',
    description:
      'Check a structured or textual deployment plan for Huawei Cloud sandbox, exposure, IAM, and cost risks.',
  },
  {
    name: 'huaweicloud_service_catalog',
    description:
      'Route a Huawei Cloud task intent to capability sources. Takes intent (plain-language task such as "create an ECS instance", "static website on OBS", "bind an EIP", "troubleshoot an RDS failover") and returns recommended skill names to load with huaweicloud_retrieve_skill, the Huawei Cloud services involved, and the capability order (Skills, KooCLI, API, SDK, MCP, Terraform). Start here when the user mentions any Huawei Cloud service or scenario: ECS, VPC, OBS, RDS, CCE, IAM, security groups, EIP, serverless, Kubernetes, database, monitoring, billing, backup, and twenty more domains.',
  },
  {
    name: 'huaweicloud_explain_error',
    description: 'Explain a Huawei Cloud CLI, API, SDK, or agent workflow error and suggest next diagnostic steps.',
  },
  {
    name: 'huaweicloud_search_docs',
    description:
      'Search across Huawei Cloud SKILL.md files and local documentation. Returns top 10 relevant results with source, name, snippet, and relevance score. Use when the agent needs to discover which skill covers a topic, or is uncertain about API parameters, quotas, or limitations.',
  },
  {
    name: 'huaweicloud_retrieve_skill',
    description:
      "Retrieve one Huawei Cloud skill by exact name (e.g. huawei-ecs, huawei-vpc, huawei-obs, huawei-sandbox). Returns the full SKILL.md content plus its reference files. This is the only way to load devkit skills: they are server data, not installed in the agent's own skill directory. Find candidate names first via huaweicloud_service_catalog, huaweicloud_search_docs, or huaweicloud_list_packs.",
  },
  {
    name: 'huaweicloud_list_regions',
    description:
      'List available Huawei Cloud regions. Returns region IDs, display names, and endpoints. Use when the agent needs to discover available regions before creating resources.',
  },
  {
    name: 'huaweicloud_get_regional_availability',
    description:
      'Check if a specific Huawei Cloud service is available in a target region. Use before creating resources to prevent failures from regional unavailability.',
  },
  {
    name: 'huaweicloud_search_marketplace',
    description:
      'Search the Huawei Cloud agent skill marketplace for available skills. Returns scored results with names, categories, and descriptions. Use when built-in skills are insufficient or the user asks what skills exist.',
  },
  {
    name: 'huaweicloud_get_service_icon',
    description:
      'Find the official Huawei Cloud service logo from the Huawei Cloud Icons library (open.huaweicloud.com/openplatform/icons.html). Returns top 5 matches with CDN logo URLs, local paths, category, aliases, and product page links. Provide service (e.g. ecs, obs, modelarts, 对象存储) or category (e.g. 计算, 存储, 人工智能) to browse. Use when generating PPT, architecture diagrams (draw.io), or frontend pages that need official Huawei Cloud service logos.',
  },
  {
    name: 'huaweicloud_detect_framework',
    description:
      'Scan a local project directory to identify the web framework (React/Vue/Angular/Next.js/Nuxt/VitePress/Docusaurus/Hugo/Hexo/Taro/uni-app), package manager, and monorepo tool. Returns framework type, build commands, output directory, and port. Use before deploying a web application to determine the correct build pipeline.',
  },
  {
    name: 'huaweicloud_setup_obs_config',
    description:
      'Synchronize KooCLI credentials to OBS config (~/.obsutilconfig). KooCLI and OBS use separate credential stores — hcloud commands work fine but OBS commands fail with "Please set ak, sk" unless this sync is done. Run this once to enable OBS operations; re-run after changing hcloud credentials.',
  },
  {
    name: 'huaweicloud_auth_status',
    description:
      'Check unified Huawei Cloud authentication status across the global credential vault, OBS, KooCLI, and all supported agent MCP registrations. Returns only redacted/status information, never credentials.',
  },
  {
    name: 'huaweicloud_auth_sync',
    description:
      'Synchronize credentials from the global Huawei Cloud credential vault to OBS and report agent registration status. Does not write secrets into any agent config.',
  },
  {
    name: 'huaweicloud_auth_init',
    description:
      'Set or clear runtime Huawei Cloud credentials (AK/SK) for this MCP session. Runtime credentials take highest priority over environment variables and config files for all subsequent API calls. Use when switching accounts within the same Agent session — call with AK/SK to switch, or with clear=true to fall back to env/file credentials.',
  },
  {
    name: 'huaweicloud_auth_switch',
    description:
      'Switch Huawei Cloud credentials within the current session. action=temporary keeps AK/SK in memory only (restart loses them; hcloud commands are unaffected and an A+C warning will be raised). action=persist writes S1 (single source of truth) with configuredBySession flag and propagates to S2 (KooCLI current profile) and S3 (OBS). action=clear resets runtime credentials. mode=import reads AK/SK from ~/.config/huaweicloud/creds-import.json then wipes it (SK never enters conversation). mode=memory passes AK/SK as tool arguments (SK is visible to model - prefer import). mode=mcp-config reads the injected mcp_settings environment.',
  },
  {
    name: 'huaweicloud_auth_confirm',
    description:
      'Confirm a pending credential reconciliation choice returned by auth_switch persist when S1 already holds a different account (R2). decision=s1 keeps S1 as source of truth and propagates it; decision=newImported propagates the newly imported account into S1 and mirrors.',
  },
  {
    name: 'huaweicloud_sandbox_exec_with_session',
    description:
      'Execute a command on a workspace terminal with session reuse (state persists across calls). Shell state (cd, env vars, aliases) carries over between calls. Use for interactive work and command sequences that need shared state. NOT for long-running commands (>30s) — prefer exec_one_shot for those.',
  },
  {
    name: 'huaweicloud_sandbox_exec_one_shot',
    description:
      'Execute a command on a workspace terminal with a fresh connection per call (no session state carries over). Each invocation opens a new WebSocket connection, executes one command, then disconnects. Use for long-running build/deploy/install commands (>30s) that do not need shell state persistence between calls. More stable than session-based execution for heavy workloads.',
  },
  {
    name: 'huaweicloud_sandbox_close_session',
    description: 'Close the persistent terminal session for a workspace.',
  },
  {
    name: 'huaweicloud_sandbox_upload_file',
    description:
      'Upload a local file into the sandbox workspace. Base64-encodes the file, writes it in small chunks through the terminal session (the exec channel is fragile for large single commands), then decodes and verifies the md5 checksum. Use this instead of embedding large file content directly in a command.',
  },
  {
    name: 'huaweicloud_sandbox_upload_project',
    description:
      'Package a local project directory and upload it to a sandbox workspace via HTTP tunnel. Falls back to base64 chunking if tunnel fails. Creates a tar.gz archive, uploads it, and extracts it on the sandbox by default.',
  },
  {
    name: 'huaweicloud_sandbox_deploy_nginx',
    description:
      'Deploy an nginx configuration on the sandbox and reload. Takes nginxType, port, project, outputDir from framework detection and writes the correct template (SPA try_files, SSR reverse proxy, or static). Also fixes directory traverse permissions on the project path. Use this instead of manually constructing nginx config — it handles permissions, template selection, and reload in one call. If the requested port is already in use, the actual port is auto-incremented and returned in "port" alongside a warning.',
  },
  {
    name: 'huaweicloud_sandbox_deploy_check',
    description:
      'Run a deployment completeness check on the sandbox. Verifies nginx is serving, output directory exists, DevBridge tunnel is active and accessible, and QR code exists (cross-platform). Returns a score, nextStep, and (when the DevBridge tunnel is missing) an executable "remediation" command string. Call this at the end of a deployment workflow to confirm everything is working before reporting success.',
  },
  {
    name: 'huaweicloud_sandbox_check_user',
    description:
      'Check if the current user has completed real-name verification and signed the required agreements. Returns 200 {realnameVerified, agreementSigned} when all good; throws 403 HDKIT_NOT_REALNAME / HDKIT_NOT_AGREEMENT / HDKIT_NOT_REALNAME_AND_AGREEMENT to indicate what is missing. Never signs anything itself.',
  },
  {
    name: 'huaweicloud_sandbox_sign_agreement',
    description:
      "Sign all unsigned or outdated agreements for the current user. Required before huaweicloud_sandbox_connect if check-user returns agreementSigned=false. CRITICAL: only call after the user explicitly consents to signing — never sign agreements on the user's behalf without their explicit request.",
  },
  {
    name: 'huaweicloud_sandbox_connect',
    description:
      'Connect to a sandbox via hdkitservice. One user one instance - reuses existing sandbox if available, otherwise creates a new one. Returns session_id, dev_stage_id, connection_id, connection_address, and expiresAt (STS credential expiry).',
  },
  {
    name: 'huaweicloud_sandbox_credentials',
    description:
      'Configure temporary AK/SK for a sandbox via hdkitservice. Validates the current AK/SK against IAM before injecting (invalid SK is rejected here instead of failing later with APIGW.0301 during exec), then injects temporary credentials into the sandbox. Also injects an optional DevBridge API Key — required for devbridge 0.2.x tunnel exposure because 0.2.x removed AK/SK login. The API Key is a long-lived account-level credential, so it is stored in a separate file (/tmp/hw_api_key, 0600) from the temporary AK/SK (/tmp/hw_creds.sh). Source of truth: local HW_API_KEY env first, then the api_key param. The sandbox must be in RUNNING state.',
  },
  {
    name: 'huaweicloud_voucher_status',
    description:
      '查询代金券领取状态。用户首次使用、开始会话或询问插件能力时，应主动调用本工具检查：未领取（claimed=false）则主动提示可领取一张代金券；已领取（claimed=true）则不提示、不打扰。',
  },
  {
    name: 'huaweicloud_voucher_claim',
    description: '领取代金券（一人一次）。重复领取会返回已领取。',
  },
  {
    name: 'huaweicloud_check_update',
    description:
      '检查 huaweicloud-devkit 插件是否有新版本。结果含 currentVersion / latestStable / latestNext / targetVersion / updateAvailable / dismissExpiresAt / result。支持 dismiss:true 记录用户拒绝（3 天冷却，新版本会重新提醒）。',
  },
  {
    name: 'huaweicloud_upgrade',
    description:
      '升级 huaweicloud-devkit 到最新版本。执行前必须先征得用户同意。version 仅支持 "latest"。完成后需重启会话生效。',
  },
  {
    name: 'huaweicloud_obs_set_website_config',
    description:
      '配置 OBS 桶的静态网站托管。KooCLI OBS 不支持 SetBucketWebsite API，此工具内部实现 AWS4 签名调用 OBS REST API，屏蔽签名细节。支持 set（配置）、get（查询）、delete（删除）三种操作。操作前需确保桶已创建且已设置 public-read ACL。',
  },
  {
    name: 'huaweicloud_list_packs',
    description:
      'List the devkit capability packs — the complete skill and tool inventory of this server. Returns each pack with id, title, description, the skill names it owns (load them with huaweicloud_retrieve_skill), its tool names, and the enabled flag. The "services" pack carries the twenty Huawei Cloud service skills (ecs, vpc, obs, iam, rds, ...). Use this to discover what the devkit knows before picking a skill or pack.',
  },
  {
    name: 'huaweicloud_pack_info',
    description:
      'Inspect one capability pack. Takes pack (a pack id from huaweicloud_list_packs) and returns the pack title, description, claimed skills, enabled flag, and every tool in the pack with name, description, and JSON Schema. Use to decide which pack covers a task before loading a skill with huaweicloud_retrieve_skill.',
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS_LITERALS)[number]['name'];

export interface ToolDefinition {
  name: ToolName;
  description: string;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = TOOL_DEFINITIONS_LITERALS;

// Tool arguments as declared by the per-tool inputSchemas above. Only
// required-field presence is validated upstream (mcp-protocol) and the numeric
// fields are re-derived by normalizeNumericArgs (#530); the remaining field
// types follow the declared contract. Kept as a type alias (not an interface)
// so it stays assignable to/from Record<string, unknown> at the dispatch
// boundary without casts.
export type ToolArgs = {
  args?: string[];
  allowWrites?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  cwd?: string;
  stdin?: string;
  service?: string;
  profile?: string;
  command?: string;
  artifacts?: unknown[];
  plan?: unknown;
  intent?: string;
  errorCode?: string;
  message?: string;
  requestId?: string;
  query?: string;
  topic?: string;
  name?: string;
  region?: string;
  category?: string;
  pack?: string;
  projectPath?: string;
  target?: string;
  ak?: string;
  sk?: string;
  securityToken?: string;
  clear?: boolean;
  mode?: string;
  action?: string;
  approvalToken?: string;
  approvedByUser?: boolean;
  bucket?: string;
  token?: string;
  decision?: string;
  workspace_id?: string;
  username?: string;
  timeout_ms?: number;
  local_path?: string;
  remote_path?: string;
  local_dir?: string;
  remote_dir?: string;
  exclude?: string[];
  extract?: boolean;
  nginx_type?: string;
  port?: number;
  project?: string;
  output_dir?: string;
  node_port?: number;
  public_port?: number;
  config_name?: string;
  framework_type?: string;
  source?: string;
  template_id?: string;
  flavor_id?: string;
  env?: Record<string, unknown>;
  git?: SandboxGitConfig;
  session_id?: string;
  dev_stage_id?: string;
  enable_sts?: boolean;
  api_key?: string;
  domain_id?: string;
  dismiss?: boolean;
  dismissVersion?: string;
  version?: string;
  indexDocument?: string;
  errorDocument?: string;
};

interface SandboxGitConfig {
  repo_url?: string;
  repo_branch?: string;
  repo_name?: string;
  target_path?: string;
  open_type?: string;
}

export interface CallToolOptions {
  sessionId?: string | null;
  doQuery?: () => Promise<DistTags | null>;
}

function toolInvokeValue(name: ToolName, args: ToolArgs): string {
  if (name === 'huaweicloud_run_readonly_command' || name === 'huaweicloud_run_approved_command') {
    const cmdArgs = args.args || [];
    const filtered = cmdArgs.filter((a) => !a.startsWith('--') && !a.startsWith('-') && !a.includes('='));
    if (filtered.length >= 2) return `hcloud ${filtered.slice(0, 2).join(' ')}`;
  }
  if (name === 'huaweicloud_list_operations' && args.service) {
    return args.service;
  }
  if (name === 'huaweicloud_retrieve_skill' && args.name) {
    return args.name;
  }
  if (name === 'huaweicloud_hook_check_command' && args.command) {
    const parts = args.command.split(/\s+/).filter((p) => !p.startsWith('--'));
    if (parts[0] === 'hcloud' && parts[1]) return `hcloud ${parts.slice(1, 3).join(' ')}`;
    return parts.slice(0, 2).join(' ');
  }
  return '1';
}

// Reject invalid numeric args up front instead of silently coercing them to
// NaN (which downstream defaults would absorb as "no timeout set") — see #530.
const NUMERIC_ARG_KEYS = ['timeoutMs', 'maxRetries', 'timeout_ms'] as const;

function normalizeNumericArgs(args: ToolArgs): ToolArgs {
  const out: ToolArgs = { ...args };
  for (const key of NUMERIC_ARG_KEYS) {
    const value = out[key];
    if (value === undefined || value === null) continue;
    const num = Number(value);
    // timeouts must be positive; maxRetries may be 0 (means "no retries").
    const isRetries = key === 'maxRetries';
    const valid = Number.isFinite(num) && (isRetries ? Number.isSafeInteger(num) && num >= 0 : num > 0);
    if (!valid) {
      throw new Error(
        `Invalid parameter "${key}": expected a ${isRetries ? 'non-negative integer' : 'positive number'}, received ${JSON.stringify(value)}.`,
      );
    }
    out[key] = num;
  }
  return out;
}

export async function callTool(name: ToolName, rawArgs: ToolArgs = {}, opts: CallToolOptions = {}): Promise<unknown> {
  const args = normalizeNumericArgs(rawArgs);
  const toolValue = toolInvokeValue(name, args);
  trackToolInvoke(name, toolValue);

  // Pack tools (the 25 non-core names) dispatch through the central handler
  // map in packs/registry.ts before the switch; the type guard narrows
  // `name` to the core remainder, which is what the switch below and its
  // never-guard are exhaustive over. opts rides through verbatim: every pack
  // handler takes (args, opts), and the update pack's doQuery/sessionId
  // seams keep reaching their handlers exactly as before the migration.
  if (isPackToolName(name)) {
    return await PACK_TOOL_HANDLERS[name](args, opts);
  }

  switch (name) {
    case 'huaweicloud_check_cli':
      return runVersionCheck();
    case 'huaweicloud_plan_cli_command':
      return planHcloudCommand(args.args || [], { allowWrites: args.allowWrites === true });
    case 'huaweicloud_run_readonly_command':
      return runHcloud(args.args || [], {
        timeoutMs: args.timeoutMs,
        maxRetries: args.maxRetries,
        cwd: args.cwd,
        stdin: args.stdin,
      });
    case 'huaweicloud_list_operations':
      return listOperations(args.service, { timeoutMs: args.timeoutMs });
    case 'huaweicloud_run_approved_command':
      return runApprovedCommand(args);
    case 'huaweicloud_show_profile_redacted':
      return showProfileRedacted(args.profile);
    case 'huaweicloud_hook_check_command':
      return hookResult(evaluateCommandRisk(args.command || ''));
    case 'huaweicloud_hook_check_artifacts':
      return hookResult(evaluateArtifacts(args.artifacts || []));
    case 'huaweicloud_hook_check_deploy_plan':
      return hookResult(evaluateDeployPlan(args.plan || {}));
    case 'huaweicloud_service_catalog':
      return serviceCatalog(args.intent);
    case 'huaweicloud_search_docs':
      return searchDocs(args.query || '', args.topic || 'all');
    case 'huaweicloud_retrieve_skill':
      trackSkillRetrieve(args.name || '');
      return retrieveSkill(args.name || '');
    case 'huaweicloud_list_regions':
      return listRegions();
    case 'huaweicloud_get_regional_availability':
      return getRegionalAvailability(args.service || '', args.region || '');
    case 'huaweicloud_explain_error':
      return explainError(args);
    case 'huaweicloud_list_packs':
      return listPacks();
    case 'huaweicloud_pack_info':
      return packInfo(args.pack || '');
    default: {
      // Compile-time exhaustiveness over the core remainder: after the
      // PACK_TOOL_HANDLERS lookup above, `name` can only be
      // Exclude<ToolName, PackToolName>; with every core case present the
      // default is unreachable. Adding a core tool without a case — or
      // breaking the pack guard above — makes this never-check fail the
      // build.
      const coreOnly: Exclude<ToolName, PackToolName> = name;
      const _exhaustive: never = coreOnly;
      throw new Error(`Unknown tool: ${String(_exhaustive)}`);
    }
  }
}

function hookResult(result: RiskEvaluation) {
  return {
    ok: result.decision !== 'deny',
    decision: result.decision,
    findings: result.findings,
    nextStep:
      result.decision === 'deny'
        ? 'Revise the command, artifact, or deployment plan before execution.'
        : result.decision === 'warn'
          ? 'Review the warnings with the user before proceeding.'
          : 'No Huawei Cloud hook risk rule matched.',
  };
}

export async function runVersionCheck(options: ProbeHcloudOptions = {}) {
  const result = probeHcloud(options);
  return {
    installed: result.installed,
    authenticated: result.ok && !/配置文件中不存在配置项|USE_ERROR.*配置/i.test(result.output || ''),
    errorCode: result.errorCode,
    status: result.status,
    output: result.output,
    kooCliVersion: result.requiredVersion || undefined,
    installedVersion: result.installedVersion || undefined,
    versionMismatch: Boolean(result.versionMismatch),
    nextStep: hcloudProbeNextStep(result),
    authHint:
      'If hcloud is installed but commands fail with "配置文件中不存在配置项", run `npx huaweicloud-devkit auth init` outside agent chat to configure credentials.',
  };
}

async function showProfileRedacted(profile?: string) {
  const args = ['configure', 'show'];
  if (profile) {
    args.push('--cli-profile', String(profile));
  }
  // The catch fallback adds the blocked/reason markers on top of a run result.
  type ProfileRunResult = HcloudRunResult & { blocked?: boolean; reason?: string };
  const result: ProfileRunResult = await runHcloud(args, { allowWrites: false, allowCredentialRead: true }).catch(
    (error): ProfileRunResult => ({
      ok: false,
      blocked: true,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  if (result.blocked) {
    return {
      ok: false,
      blockedByPolicy: true,
      reason: result.reason,
      safeAlternative:
        'Use huaweicloud_show_profile_redacted so profile output is returned through the redaction pipeline.',
    };
  }
  return {
    ok: result.ok,
    note: result.ok
      ? 'Profile information was returned through the toolkit redaction pipeline.'
      : 'Failed to retrieve profile — hcloud may not be installed or configured.',
    result: redactSecrets(result),
  };
}

const SERVICE_EXAMPLES: Record<string, { list: string; create: string; show: string }> = {
  ECS: { list: 'ECS ListServersDetails', create: 'ECS CreateServers', show: 'IMS GlanceShowImage' },
  VPC: { list: 'VPC ListVpcs', create: 'VPC CreateVpc', show: 'VPC ShowVpc' },
  FUNCTIONGRAPH: {
    list: 'FunctionGraph ListFunctions',
    create: 'FunctionGraph CreateFunction',
    show: 'FunctionGraph ShowFunctionConfig',
  },
  APIG: { list: 'APIG ListInstancesV2', create: 'APIG CreateInstanceV2', show: 'APIG ShowDetailsOfInstanceV2' },
  OBS: { list: 'OBS ls', create: 'OBS mb obs://<bucket>', show: 'OBS stat obs://<bucket>/<key>' },
  RDS: { list: 'RDS ListInstances', create: 'RDS CreateInstance', show: 'RDS ShowInstance' },
  CES: { list: 'CES ListAlarms', create: 'CES CreateAlarm', show: 'CES ListMetrics' },
  GAUSSDB: { list: 'GaussDB ListInstances', create: 'GaussDB CreateInstance', show: 'GaussDB ShowInstance' },
  DDS: { list: 'DDS ListInstances', create: 'DDS CreateInstance', show: 'DDS ShowInstance' },
  DCS: { list: 'DCS ListInstances', create: 'DCS CreateInstance', show: 'DCS ShowInstance' },
};

async function listOperations(service: string | undefined, options: { timeoutMs?: number } = {}) {
  const serviceName = String(service || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{1,63}$/.test(serviceName)) {
    throw new Error('service must be a KooCLI service name such as ECS, VPC, IMS, OBS, RDS, or CDN.');
  }
  const isObs = /^obs$/i.test(serviceName);
  const svc = isObs ? 'obs' : serviceName;
  const args = isObs ? ['obs', 'help'] : [svc, '--help'];
  let result = await runHcloud(args, {
    timeoutMs: options.timeoutMs,
    maxRetries: 0,
  });
  if (!result.ok && !isObs) {
    result = await runHcloud([svc, 'help'], {
      timeoutMs: options.timeoutMs,
      maxRetries: 0,
    });
  }
  return {
    service: serviceName,
    command: isObs ? 'hcloud obs help' : `hcloud ${svc} --help`,
    selectionRule: 'Use this help text to select the exact KooCLI operation name before planning any service command.',
    examples: SERVICE_EXAMPLES[serviceName.toUpperCase()] || {
      note: `No cached examples for ${serviceName}. Use the help text above to discover available operations.`,
    },
    result,
  };
}

async function runApprovedCommand(args: ToolArgs = {}) {
  if (args.approvedByUser !== true) {
    throw new Error('approvedByUser must be true after explicit user approval for this exact command.');
  }
  const token = String(args.approvalToken || '');
  const stored = consumeApprovalToken(token);
  if (!stored) {
    throw new Error('Invalid or expired approval token. Please re-plan the command.');
  }
  const providedArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (hashArgs(providedArgs) !== stored.argsHash) {
    const redactedStored = JSON.stringify(stored.argsRedacted);
    const redactedProvided = JSON.stringify(redactSecrets(providedArgs));
    if (redactedStored !== redactedProvided) {
      throw new Error(
        'Provided args do not match the approved plan. Use the exact args from the plan. ' +
          'If the plan shows <redacted> for passwords or secrets, replace <redacted> with the actual values in approvedCommand.',
      );
    }
  }
  const strictPlan = planHcloudCommand(providedArgs, { allowWrites: false });
  const result = await runHcloud(providedArgs, {
    allowWrites: true,
    timeoutMs: args.timeoutMs,
    maxRetries: args.maxRetries,
    cwd: args.cwd,
    stdin: args.stdin,
  });
  // Spread instead of in-place mutation: identical serialized content, minus a
  // write to the HcloudRunResult shape owned by hcloud-cli.ts.
  return { ...result, approved: true, plan: strictPlan };
}

function serviceCatalog(intent: string = '') {
  const it = String(intent).toLowerCase();
  const routeMap = [
    {
      keywords: ['ecs', 'server', 'vm', 'instance', 'compute', 'flavor', 'image'],
      skills: ['huawei-ecs'],
      services: ['ECS'],
    },
    {
      keywords: ['vpc', 'subnet', 'network', 'security group', 'eip', 'nat', 'vpn', 'bandwidth'],
      skills: ['huawei-vpc'],
      services: ['VPC', 'EIP'],
    },
    {
      keywords: ['obs', 'bucket', 'storage', 'object', 'static website', 'static site', 'hosting'],
      skills: ['huawei-obs'],
      services: ['OBS'],
    },
    {
      keywords: ['functiongraph', 'serverless', 'function', 'lambda', 'trigger', 'faas'],
      skills: ['huawei-functiongraph'],
      services: ['FunctionGraph'],
    },
    {
      keywords: ['cce', 'kubernetes', 'k8s', 'container', 'cluster', 'node pool', 'swr', 'docker', 'image registry'],
      skills: ['huawei-cce'],
      services: ['CCE', 'SWR'],
    },
    { keywords: ['apig', 'api gateway', 'publish', 'throttle'], skills: ['huawei-apig'], services: ['APIG'] },
    { keywords: ['rds', 'mysql', 'postgresql', 'database', 'db'], skills: ['huawei-rds'], services: ['RDS'] },
    {
      keywords: ['gaussdb', 'distributed', 'sharding', 'opengauss'],
      skills: ['huawei-gaussdb'],
      services: ['GaussDB'],
    },
    {
      keywords: ['iam', 'permission', 'policy', 'role', 'user', 'ak/sk', 'access key', 'agency'],
      skills: ['huawei-iam'],
      services: ['IAM'],
    },
    {
      keywords: ['dew', 'secret', 'kms', 'encrypt', 'decrypt', 'certificate', 'csms'],
      skills: ['huawei-dew'],
      services: ['CSMS', 'KMS'],
    },
    {
      keywords: ['modelarts', 'ai', 'model', 'training', 'inference', 'machine learning'],
      skills: ['huawei-modelarts'],
      services: ['ModelArts'],
    },
    {
      keywords: ['billing', 'cost', 'bill', 'budget', 'expense', 'bss'],
      skills: ['huawei-billing'],
      services: ['BSS'],
    },
    {
      keywords: ['waf', 'aad', 'ddos', 'firewall', 'web protection'],
      skills: ['huawei-waf-aad'],
      services: ['WAF', 'AAD'],
    },
    {
      keywords: ['smn', 'dms', 'notification', 'message', 'kafka', 'rabbitmq'],
      skills: ['huawei-smn-dms'],
      services: ['SMN', 'DMS'],
    },
    {
      keywords: ['ces', 'monitor', 'alarm', 'metric', 'dashboard', 'cloud eye'],
      skills: ['huawei-cloud-eye'],
      services: ['CES'],
    },
    { keywords: ['cts', 'audit', 'trace', 'tracker'], skills: ['huawei-cts'], services: ['CTS'] },
    { keywords: ['cbr', 'backup', 'restore', 'vault', 'snapshot'], skills: ['huawei-cbr'], services: ['CBR'] },
    {
      keywords: ['deployment', 'deploy', 'ci/cd', 'pipeline', 'release'],
      skills: ['huawei-deployment'],
      services: ['CloudDeploy'],
    },
    {
      keywords: [
        'sandbox',
        'devstation',
        'workspace',
        'terminal',
        'preview',
        'hwlink',
        'website',
        'web app',
        'webapp',
        'hosting',
        '网站',
        '网页',
        '静态',
      ],
      skills: ['huawei-sandbox'],
      services: ['Sandbox', 'DevStation'],
    },
    {
      keywords: ['dds', 'dcs', 'mongodb', 'redis', 'memcached', 'cache', 'document db'],
      skills: ['huawei-dds-dcs'],
      services: ['DDS', 'DCS'],
    },
    {
      keywords: ['voucher', 'coupon', 'incentive', 'credit', '领券', '代金券', '优惠券', '激励金', '领取'],
      skills: ['huawei-voucher'],
      services: ['Incentive Voucher'],
    },
  ];
  const matched = [];
  const tokens = new Set(it.split(/[\s,./-]+/).filter((t) => t.length > 0));
  const cjk = /[\u4e00-\u9fff]/;
  for (const route of routeMap) {
    if (route.keywords.some((kw) => (kw.includes(' ') || cjk.test(kw) ? it.includes(kw) : tokens.has(kw)))) {
      matched.push(route);
    }
  }
  const recommendedSkills = [...new Set(matched.flatMap((r) => r.skills))];
  // Never recommend a skill whose owning pack is disabled — the router must
  // not send the agent to a loader that will refuse (same filter searchDocs
  // applies to its index).
  const enabled = resolveEnabledPacks();
  const gated = recommendedSkills.filter((skill) => {
    const owner = SKILL_OWNER.get(skill);
    return !owner || enabled.has(owner);
  });
  const recommendedServices = [...new Set(matched.flatMap((r) => r.services))].slice(0, 5);

  // Deployment intent (deploy/host/publish a web app or static website) must never
  // default to a storage/other service — recommend the sandbox first.
  const deploymentIntent = /deploy|host|hosting|publish|website|web app|preview|部署|托管|发布|网站|网页/.test(it);
  if (deploymentIntent && gated.includes('huawei-sandbox')) {
    const idx = gated.indexOf('huawei-sandbox');
    gated.splice(idx, 1);
    gated.unshift('huawei-sandbox');
  }

  return {
    intent,
    recommendedSkills: gated.length ? gated : ['Use huaweicloud-core to route intent.'],
    recommendedServices: recommendedServices.length
      ? recommendedServices
      : ['Run hcloud --help to list available services.'],
    capabilityOrder: [
      'Huawei Cloud Skills for task-specific workflows and examples',
      'KooCLI hcloud for local authenticated operations and quick inspection',
      'Huawei Cloud API documentation for exact request and response contracts',
      'Huawei Cloud SDKs for application code integration',
      'Huawei Cloud MCP when an official or approved server is available',
      'Terraform Provider only when IaC reviewability and repeatability are important',
    ],
    ruleOfThumb: {
      skills: 'Start here when the user describes a scenario or wants a guided workflow.',
      cli: 'Use for local diagnostics, read-only inspection, and commands the user can review.',
      api: 'Use for exact service contract, region endpoint, project_id, pagination, and error codes.',
      sdk: 'Use when writing application code that calls Huawei Cloud services.',
      mcp: 'Prefer approved MCP tools when available because tools can carry structured schemas.',
      terraform: 'Keep low priority in V1; suggest it for reviewed infrastructure changes, not quick diagnosis.',
    },
  };
}

// ── Pack meta tools ──
// Both tools read the pack registry (PACK_OF inversion in packs/registry.ts),
// the tool definitions (name/description), the zod schemas, and the live
// enablement set (packs/enable.ts, DEVKIT_PACKS > all packs), so their output
// can never disagree with tools/list: a disabled pack is listed with
// enabled:false, and pack_info refuses to detail it.

// Skill directory → owning pack, inverted from the PACKS claims. Skills found
// in the resolved SKILLS_ROOT that no pack claims (foreign skills an agent
// keeps in its own skills dir) map to undefined and stay untouched by pack
// enablement gating.
const SKILL_OWNER = new Map<string, PackId>(
  PACKS.flatMap((pack) => pack.skills.map((skill) => [skill, pack.id] as const)),
);

function listPacks() {
  const enabled = resolveEnabledPacks();
  return {
    ok: true,
    count: PACKS.length,
    packs: PACKS.map((pack) => ({
      id: pack.id,
      title: pack.title,
      description: pack.description,
      skills: pack.skills,
      tools: pack.tools,
      enabled: enabled.has(pack.id),
    })),
  };
}

function packInfo(pack: string) {
  const packId = String(pack || '').trim();
  if (!packId) return { ok: false, error: 'Pack id is required.' };
  const found = PACKS.find((entry) => entry.id === packId);
  if (!found) {
    const available = PACKS.map((entry) => entry.id).join(', ');
    return { ok: false, error: 'Pack "' + packId + '" not found. Available: ' + available };
  }
  const enabled = resolveEnabledPacks();
  if (!enabled.has(found.id)) {
    return {
      ok: false,
      error:
        'Pack "' +
        found.id +
        '" is not enabled. Start the server with DEVKIT_PACKS including "' +
        found.id +
        '" (e.g. DEVKIT_PACKS=core,' +
        found.id +
        ') to enable it.',
    };
  }
  const tools = found.tools.map((name) => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    const schema = z.toJSONSchema(getToolSchema(name)) as Record<string, unknown>;
    for (const key of SCHEMA_DRIFT_IGNORED_KEYS) delete schema[key];
    return { name, description: definition?.description ?? '', schema };
  });
  return {
    ok: true,
    pack: found.id,
    title: found.title,
    description: found.description,
    skills: found.skills,
    tools,
    enabled: true,
  };
}

function explainError({ service = 'unknown', errorCode = '', message = '', requestId = '' }: ToolArgs = {}) {
  const combined = `${errorCode} ${message}`.toLowerCase();
  const suggestions: string[] = [];
  const svc = String(service).toLowerCase();

  const SERVICE_ALIASES: Record<string, string> = {
    functiongraph: 'FSS',
    fgs: 'FSS',
  };
  const patternKey = SERVICE_ALIASES[svc] || service;

  const hwErrorPatterns: Record<string, Record<string, string>> = {
    OBS: {
      InvalidAccessKeyId:
        'OBS uses AK/SK directly (not IAM tokens). Verify AK/SK validity, OBS endpoint, and OBS permissions.',
      UserRestricted:
        'This IAM user is restricted from OBS operations (403). Check IAM console → Users → Permissions: grant OBS bucket/object actions, or use an unrestricted account. If the account is a sub-account, the main account may have imposed restrictions.',
    },
    APIG: {
      'APIC.7241': 'The enterprise_project_id is required for enterprise accounts. Add --enterprise_project_id=0.',
      'APIC.7242':
        'The EIP binding method depends on loadbalancer_provider. Use AddIngressEipV2 for elb, AddEipV2 for lvs.',
      'APIC.7256': 'Bandwidth minimum is 5 Mbps. Use --bandwidth_size=5 or higher.',
      'APIC.7310': 'available_zone_ids must use AZ codes (e.g. ap-southeast-3a), NOT UUIDs from ListAvailableZonesV2.',
    },
    FSS: {
      'FSS.0403':
        'Missing FunctionGraph IAM permissions. Attach FunctionGraph FullAccess role or grant specific actions.',
      'FSS.1078': '--code_filename is filename-only (no path). cd to the file directory before running the command.',
      'FSS.1417':
        'event_data field validation failed. Check parameter format: use dotted key=value, verify required hidden-optional fields.',
    },
    VPC: {
      'VPC.0301': 'Bandwidth name is required for PER type EIPs, even though --help marks it optional.',
    },
    APIGW: {
      'APIGW.0301':
        'Incorrect IAM authentication information. The AK/SK is invalid (check the SK for typos), the security token is missing or expired, or the profile lacks project_id. Fix: re-run "npx huaweicloud-devkit auth init" (it auto-sets project_id), or set it manually: hcloud configure set --cli-project-id=<project_id> after finding it via hcloud IAM KeystoneListProjects --cli-region=<region> --name=<region>.',
      'APIGW.0802':
        'The current IAM user has no permissions in the requested region. Go to IAM console → Users → Permissions → add the target region, or switch to a different region.',
    },
  };
  if (hwErrorPatterns[patternKey] && hwErrorPatterns[patternKey][errorCode]) {
    suggestions.push(hwErrorPatterns[patternKey][errorCode]);
  }
  const svcPatterns: Record<string, string> = hwErrorPatterns[patternKey] || {};
  for (const [code, tip] of Object.entries(svcPatterns)) {
    if (errorCode && code.includes(errorCode)) {
      if (!suggestions.includes(tip)) suggestions.push(tip);
    }
  }

  if (/auth|token|credential|ak|sk|401|403|unauthorized|forbidden|Incorrect IAM/i.test(combined)) {
    if (svc === 'obs') {
      suggestions.push(
        'OBS uses AK/SK directly, not IAM tokens. Verify AK/SK validity and OBS bucket permissions via hcloud configure list or the Huawei Cloud console.',
      );
    } else {
      suggestions.push('Check KooCLI profile, region, project_id, and IAM permissions without printing secrets.');
    }
  }
  if (/APIGW\.(\d+)/i.test(errorCode)) {
    suggestions.push(
      'APIGW.' +
        (errorCode.match(/APIGW\.(\d+)/i) || [])[1] +
        ': API Gateway layer error. ' +
        (errorCode === 'APIGW.0802'
          ? 'IAM user has no region permissions — check IAM console → User → Permissions → add target region.'
          : errorCode === 'APIGW.0301'
            ? 'Incorrect IAM authentication information — verify AK/SK (SK typos are the usual cause), security token expiry, and that project_id is configured (auth init auto-sets it).'
            : 'Verify the API request, region endpoint, and IAM permissions.'),
    );
  }
  if (/region|endpoint|project/i.test(combined)) {
    suggestions.push('Confirm the service endpoint, region, and project_id match the target resource.');
  }
  if (/quota|limit|insufficient|reach the limit/i.test(combined)) {
    suggestions.push(
      'Check quota and resource limits before retrying a create or scale operation. Consider switching accounts or requesting a quota increase.',
    );
  }
  if (/not.?found|404/i.test(combined)) {
    if (/list.?regions/i.test(svc)) {
      suggestions.push('Use hcloud IAM KeystoneListRegions (not list-regions).');
    } else {
      suggestions.push('List resources in the same region/project and verify the resource identifier.');
    }
  }
  if (!suggestions.length) {
    suggestions.push(
      'No known error-code pattern matched. Re-run the failing command with --debug to capture ' +
        'X-Request-Id from the response headers, then re-call explain_error with service, operation, ' +
        'region, the full redacted message, and requestId.',
    );
    if (errorCode) {
      suggestions.push(
        `Search the error code "${errorCode}" in the Huawei Cloud error center (support.huaweicloud.com) for the authoritative cause.`,
      );
    }
  }

  if (requestId) {
    suggestions.push('Provide the Request ID (' + requestId + ') when contacting Huawei Cloud support.');
  }

  const uniqueSuggestions = suggestions.filter((s, i, arr) => {
    return !arr.slice(0, i).some((prev) => prev.substring(0, 50).toLowerCase() === s.substring(0, 50).toLowerCase());
  });

  return {
    service,
    errorCode,
    requestId,
    suggestions: uniqueSuggestions,
  };
}

async function searchDocs(query: string, topic: string = 'all') {
  const q = String(query || '').toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  // Skills owned by a disabled pack are filtered out of the search index;
  // core-owned and unclaimed (foreign) skills stay searchable.
  const enabled = resolveEnabledPacks();
  const results: Array<{ source: string; name: string; snippet: string; relevance: number }> = [];
  try {
    if (existsSync(SKILLS_ROOT)) {
      const dirs = listSkillDirs(SKILLS_ROOT);
      for (const dir of dirs) {
        const owner = SKILL_OWNER.get(dir);
        if (owner && !enabled.has(owner)) continue;
        const skillPath = join(SKILLS_ROOT, dir, 'SKILL.md');
        if (!existsSync(skillPath)) continue;
        const content = readFileSync(skillPath, 'utf8');
        const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        let description = '';
        let name = dir;
        if (frontmatter) {
          const fm = frontmatter[1];
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          if (nameMatch) name = nameMatch[1].trim();
          const descMatch = fm.match(/^description:\s*(.+)$/m);
          if (descMatch) description = descMatch[1].trim();
        }
        if (topic !== 'all') {
          const topicLower = topic.toLowerCase();
          if (!name.toLowerCase().includes(topicLower) && !description.toLowerCase().includes(topicLower)) continue;
        }
        const descLower = description.toLowerCase();
        const nameLower = name.toLowerCase();
        const contentLower = content.toLowerCase();
        const relevance = tokens.reduce((score, token) => {
          return (
            score +
            (descLower.includes(token) ? 3 : 0) +
            (nameLower.includes(token) ? 2 : 0) +
            (contentLower.includes(token) ? 1 : 0)
          );
        }, 0);
        if (relevance > 0) {
          results.push({
            source: 'skills/' + dir + '/SKILL.md',
            name,
            snippet: description.substring(0, 200),
            relevance,
          });
        }
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), results: [] };
  }
  results.sort((a, b) => b.relevance - a.relevance);
  return { ok: true, query: q, topic, count: results.length, results: results.slice(0, 10) };
}

async function retrieveSkill(name: string) {
  const skillName = String(name || '').trim();
  if (!skillName) return { ok: false, error: 'Skill name is required.' };
  // Boundary guard: the name joins a filesystem path and MCP is the sole
  // loading surface, so anything outside the skill-name shape (traversal
  // segments, separators, absolute paths) is rejected before touching disk.
  if (!/^[a-z0-9-]+$/.test(skillName)) {
    return {
      ok: false,
      error: 'Invalid skill name "' + skillName + '". Skill names are lowercase letters, digits, and dashes.',
    };
  }
  const skillPath = join(SKILLS_ROOT, skillName, 'SKILL.md');
  if (!existsSync(skillPath)) {
    // The Available list advertises only enabled packs' skills: recommending a
    // name the owner gate would refuse misroutes the agent.
    const enabled = resolveEnabledPacks();
    const dirs = listSkillDirs(SKILLS_ROOT).filter((dir) => {
      const owner = SKILL_OWNER.get(dir);
      return !owner || enabled.has(owner);
    });
    return { ok: false, error: 'Skill "' + skillName + '" not found. Available: ' + dirs.join(', ') };
  }
  const owner = SKILL_OWNER.get(skillName);
  if (owner && !resolveEnabledPacks().has(owner)) {
    return {
      ok: false,
      error:
        'Skill "' +
        skillName +
        '" belongs to pack "' +
        owner +
        '" which is not enabled. Start the server with DEVKIT_PACKS including "' +
        owner +
        '" (e.g. DEVKIT_PACKS=core,' +
        owner +
        ') to enable it.',
    };
  }
  const content = readFileSync(skillPath, 'utf8');
  const references: Array<{ filename: string; content: string }> = [];
  const refDir = join(SKILLS_ROOT, skillName, 'references');
  if (existsSync(refDir)) {
    readdirSync(refDir).forEach((f) => {
      const refPath = join(refDir, f);
      references.push({ filename: f, content: readFileSync(refPath, 'utf8').substring(0, 4000) });
    });
  }
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let version: string | number = 1,
    description = '';
  if (frontmatter) {
    const fm = frontmatter[1];
    const vm = fm.match(/^version:\s*(.+)$/m);
    if (vm) version = vm[1].trim();
    const dm = fm.match(/^description:\s*(.+)$/m);
    if (dm) description = dm[1].trim();
  }
  return { ok: true, name: skillName, version, description, content, references };
}

async function listRegions() {
  const result = await runHcloud(['IAM', 'KeystoneListRegions'], { timeoutMs: 30000, maxRetries: 0 }).catch(
    (error): HcloudRunResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  if (!result.ok) {
    return {
      ok: false,
      error: result.error || 'Failed to list regions.',
      fallback: 'Check https://developer.huaweicloud.com/endpoint for available regions.',
      staticRegions: [
        { id: 'cn-north-1', description: '华北-北京一' },
        { id: 'cn-north-4', description: '华北-北京四' },
        { id: 'cn-east-3', description: '华东-上海一' },
        { id: 'cn-east-2', description: '华东-上海二' },
        { id: 'cn-south-1', description: '华南-广州' },
        { id: 'ap-southeast-1', description: '香港' },
        { id: 'ap-southeast-3', description: '新加坡' },
        { id: 'ap-southeast-2', description: '曼谷' },
        { id: 'af-south-1', description: '约翰内斯堡' },
      ],
      note: 'hcloud unavailable. Showing static region list. For the complete list, visit the fallback URL.',
    };
  }
  let regions: Array<Record<string, unknown>>;
  try {
    const parsed: unknown = typeof result.stdout === 'string' ? JSON.parse(result.stdout) : result.stdout;
    const rawRegionsValue = asRecord(parsed).regions;
    const rawRegions = Array.isArray(rawRegionsValue) ? rawRegionsValue : [];
    regions = rawRegions.map((r) => {
      const record = asRecord(r);
      return {
        id: record.id,
        description: record.description || record.names,
        type: record.type,
        locales: record.locales,
      };
    });
  } catch {
    regions = [{ raw: String(result.stdout).substring(0, 1000) }];
  }
  regions.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  return { ok: true, count: regions.length, regions };
}

async function getRegionalAvailability(service: string, region: string) {
  const svc = String(service || '')
    .toLowerCase()
    .trim();
  const reg = String(region || '')
    .toLowerCase()
    .trim();
  if (!svc || !reg) return { ok: false, error: 'Both service and region are required.' };
  // svc is an arbitrary string at this boundary; the explicit Record view is
  // what keeps the string index legal under strict mode (SERVICE_REGIONS is a
  // closed object literal with no index signature).
  const table: Record<string, readonly string[]> = SERVICE_REGIONS;
  if (!table[svc])
    return {
      ok: false,
      service: svc,
      region: reg,
      available: false,
      note:
        'Service ' +
        svc +
        ' is not in the regional availability cache. Run hcloud ' +
        svc.toUpperCase() +
        ' --help to verify, or check https://developer.huaweicloud.com/endpoint.',
    };
  const available = table[svc].includes(reg) || table[svc].includes('global');
  return {
    ok: true,
    service: svc,
    region: reg,
    available,
    note: available
      ? svc + ' is available in ' + reg + '.'
      : svc +
        ' availability in ' +
        reg +
        ' could not be confirmed. Verify at https://developer.huaweicloud.com/endpoint.',
    sourcedFrom: 'static cache, update via npm package upgrade',
    disclaimer:
      'This result reflects service-level availability only. It does NOT guarantee that your IAM user has permissions in this region. Account-level restrictions (e.g., APIGW.0802) may block actual API calls even when the service is available.',
  };
}

export function classifyRawCommand(command: unknown) {
  return classifyTextCommand(command);
}
