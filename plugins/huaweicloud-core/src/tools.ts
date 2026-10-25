import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateArtifacts, evaluateCommandRisk, evaluateDeployPlan, type RiskEvaluation } from './risk-rule-engine.ts';
import { classifyTextCommand } from './safety-policy.ts';
import { parseStsExpiry, resolveCredentialsWithRuntime } from './auth/credentials.ts';
import { trackToolInvoke, trackSkillRetrieve } from './telemetry/telemetry.ts';
// The update tool handlers live in the update pack's handler map (merged
// into PACK_TOOL_HANDLERS); only the DistTags type for the CallToolOptions
// doQuery seam is still needed here.
import type { DistTags } from './update-check.ts';
// PACK_TOOL_HANDLERS is the central pack dispatch table (its satisfies check
// pins every PackToolName to a handler); PACKS feeds listSkills below.
import { PACKS, PACK_TOOL_HANDLERS, isPackToolName, type PackToolName } from './packs/registry.ts';
import { resolveEnabledPacks } from './packs/enable.ts';
// The skill-dir listing lives in the shared zod-free module
// (src/lib/skill-tree.ts) so the boot guard, the installer's doctor check,
// the build-time --check stray scan, and validate-package's skill gate all
// hold one membership predicate (dir-or-symlink with a SKILL.md).
import { listSkillDirs } from './lib/skill-tree.ts';
// The frontmatter field extraction (name/description/version) behind
// searchDocs, retrieveSkill, and listSkills — one parser instead of the
// per-call-site regexes that truncated multi-line descriptions.
import { parseSkillFrontmatter } from './lib/skill-frontmatter.ts';
import { recordToolCall, traceEnabled } from './lib/call-trace.ts';
// Service region descriptor (the old inline `known` table in
// getRegionalAvailability, migrated verbatim — see services/regions.ts for
// its guarantee scope).
import { SERVICE_REGIONS } from './services/regions.ts';
// The tool name/description registry (TOOL_DEFINITIONS_LITERALS and its
// derived types) lives in tool-definitions.ts; this module keeps the
// re-export face every importer (mcp-protocol, tests, scripts) already
// targets — same exported names, same import path, same behavior.
import { TOOL_DEFINITIONS, type ToolName } from './tool-definitions.ts';
// The vendorConfirmed gate (VENDOR_GATED_TOOLS, the gate/challenge
// messages, and the once-per-session challenge state) lives in
// vendor-gate.ts; this module re-exports the roster for its existing
// importers (structure-load-path, e2e/cases/core) and dispatchTool calls
// enforceVendorGate at dispatch's top.
import { VENDOR_GATED_TOOLS, enforceVendorGate } from './vendor-gate.ts';
// The capability catalog (service_catalog / list_packs / pack_info
// handlers, the SKILL_OWNER inversion, and the shared pack-refusal
// helpers) lives in capability-catalog.ts; dispatchTool switches into it,
// verifySkillTree cross-checks SKILL_OWNER, and the skills-serving
// handlers below reuse the refusal helpers. Session pack configuration
// (packs_configure) is its own module — the one mutating pack tool.
import {
  SKILL_OWNER,
  packEnablementRemediation,
  packNotFound,
  packNotEnabled,
  serviceCatalog,
  listPacks,
  packInfo,
} from './capability-catalog.ts';
import { configurePacks } from './packs-configure.ts';

export { TOOL_DEFINITIONS };
export type { ToolDefinition, ToolName } from './tool-definitions.ts';
export { VENDOR_GATED_TOOLS };

const __dirname = dirname(fileURLToPath(import.meta.url));

// The skills tree is server data, not an agent-native artifact: it ships next
// to dist/ (esbuild preserves import.meta.url, so the bundled mcp-server.js
// resolves this relative to its own location) and is disclosed through the
// MCP tools (list_packs / pack_info / list_skills / retrieve_skill /
// search_docs); list_skills also carries the tree's location (skillRoot,
// stdio sessions only) so a same-machine agent can read the files with its
// own tools, and the stdio server instructions state the same location at
// initialize (mcp-protocol.ts instructionsFor) so the direct read needs no
// catalog detour. The installer separately places the six core meta-skills as
// native copies in directory-loading agents (setup-cli's PAYLOAD_TARGETS
// sync) — that placement lives in setup-cli, and this module never probes
// agent-native dirs. Exported for the instruction builder, which resolves
// the path at runtime (never baked at build time) from this same constant.
export const SKILLS_ROOT = join(__dirname, '..', 'skills');

// Re-exported for the existing test importers (test/tools.test.ts); the
// tool handlers below (retrieve_skill, search_docs) consume the local
// binding. The predicate itself lives in src/lib/skill-tree.ts.
export { listSkillDirs };

// Boot-time cross-check between the registry's skill claims and the
// generated tree. A server that advertises skills retrieve_skill cannot
// serve (registry-driven list_packs beside an empty or partial tree) is
// worse than one that refuses to start, so the factory calls this before
// registering anything — mirroring the loudness of a missing dist/.
// The tree must EQUAL the registry roster, not merely contain it: an
// unclaimed directory is served ungated (SKILL_OWNER.get returns undefined,
// so retrieve_skill skips the pack-enablement gate), so extras are as
// dangerous as gaps. The root is injectable for tests.
export function verifySkillTree(root: string = SKILLS_ROOT): void {
  const present = new Set(listSkillDirs(root));
  const missing = [...SKILL_OWNER.keys()].filter((skill) => !present.has(skill));
  const unclaimed = [...present].filter((skill) => !SKILL_OWNER.has(skill));
  if (missing.length > 0 || unclaimed.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
    if (unclaimed.length > 0) parts.push(`unclaimed ${unclaimed.join(', ')}`);
    throw new Error(
      `skills tree invalid at ${root}: ${parts.join('; ')} — ` +
        'from a git checkout run: npm run build; from an install run: npx huaweicloud-devkit install',
    );
  }
}

// Tool arguments as declared by the per-tool inputSchemas above. Only
// required-field presence is validated upstream (mcp-protocol) and the numeric
// fields are re-derived by normalizeNumericArgs (#530); the remaining field
// types follow the declared contract. Kept as a type alias (not an interface)
// so it stays assignable to/from Record<string, unknown> at the dispatch
// boundary without casts.
export type ToolArgs = {
  args?: string[];
  allowWrites?: boolean;
  // The vendor-gate attestation (VENDOR_GATED_TOOLS faces only; see
  // callTool's gate): a QUOTE of the user's establishing words, not a
  // boolean. Optional in the schema by design — the gate, not zod, is
  // the enforcement, so the teaching rejection reaches the model.
  vendorConfirmed?: string;
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
  enable?: string[];
  disable?: string[];
  reset?: boolean;
  projectPath?: string;
  target?: string;
  ak?: string;
  sk?: string;
  securityToken?: string;
  clear?: boolean;
  mode?: string;
  action?: string;
  tool?: string;
  toolArgs?: Record<string, unknown>;
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
  rules?: unknown[];
  expiry_hours?: number;
  keepalive?: boolean;
  tunnel_id?: string;
  tunnels?: unknown[];
  ref?: string;
  channel?: string;
  value?: string;
  file?: string;
  envVar?: string;
  note?: string;
  scope?: string;
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
  // Disclosure re-sync seam, wired only by stdio-session constructions in
  // mcp-protocol.ts. Its absence is the guard that keeps the stateless remote
  // from mutating process-shared pack state through a direct unlisted call.
  onPacksChanged?: () => void;
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
  if (name === 'huaweicloud_list_skills' && args.pack) {
    return args.pack;
  }
  if (name === 'huaweicloud_retrieve_skill' && args.name) {
    return args.name;
  }
  if (name === 'huaweicloud_packs_configure') {
    // The delta is the telemetry value: which packs crossed the operator
    // posture line in this session is the auditable fact.
    const parts: string[] = [];
    const enabled = (args.enable ?? []).map((id) => String(id));
    const disabled = (args.disable ?? []).map((id) => String(id));
    if (enabled.length > 0) parts.push('+' + enabled.join(','));
    if (disabled.length > 0) parts.push('-' + disabled.join(','));
    if (args.reset === true) parts.push('reset');
    if (parts.length > 0) return parts.join(' ');
  }
  if (name === 'huaweicloud_hook_check_command' && args.command) {
    const parts = args.command.split(/\s+/).filter((p) => !p.startsWith('--'));
    if (parts[0] === 'hcloud' && parts[1]) return `hcloud ${parts.slice(1, 3).join(' ')}`;
    return parts.slice(0, 2).join(' ');
  }
  // The auditable fact for vault mutations is the ref (and scope), never the
  // value or any channel payload.
  if (name === 'huaweicloud_secret_set' && args.ref) return args.ref;
  if (name === 'huaweicloud_secret_list' && args.scope) return args.scope;
  if (name === 'huaweicloud_secret_delete' && args.ref) return args.ref;
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

  // Trace sits between normalization and dispatch: it records the shape
  // the handler will actually see, and only calls that reached dispatch —
  // SDK-level zod rejects never get here (see lib/call-trace.ts contract).
  if (!traceEnabled()) return dispatchTool(name, args, opts);
  try {
    const result = await dispatchTool(name, args, opts);
    recordToolCall(name, args, true);
    return result;
  } catch (error) {
    recordToolCall(name, args, false, error);
    throw error;
  }
}

async function dispatchTool(name: ToolName, args: ToolArgs, opts: CallToolOptions): Promise<unknown> {
  // The gate sits at dispatch's top, inside callTool's traced region: a
  // rejected call is recorded (ok:false + this message) and the handler
  // never runs — no hcloud spawn, no HTTP, no state touched. The gate
  // fires before isPackToolName so pack and core gated tools are covered
  // by one check; the quote-form attestation and the once-per-session
  // first-assertion challenge it clears into are vendor-gate.ts's
  // enforceVendorGate.
  if (VENDOR_GATED_TOOLS.has(name)) {
    enforceVendorGate(args, opts);
  }
  // Pack tools (every non-core name) dispatch through the central handler
  // map in packs/registry.ts before the switch; the type guard narrows
  // `name` to the core remainder, which is what the switch below and its
  // never-guard are exhaustive over. opts rides through verbatim: every pack
  // handler takes (args, opts), and the update pack's doQuery/sessionId
  // seams keep reaching their handlers exactly as before the migration.
  if (isPackToolName(name)) {
    return await PACK_TOOL_HANDLERS[name](args, opts);
  }

  switch (name) {
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
      return retrieveSkill(args.name || '', opts);
    case 'huaweicloud_get_regional_availability':
      return getRegionalAvailability(args.service || '', args.region || '');
    case 'huaweicloud_explain_error':
      return explainError(args);
    case 'huaweicloud_list_packs':
      return listPacks(opts);
    case 'huaweicloud_pack_info':
      return packInfo(args.pack || '', opts);
    case 'huaweicloud_list_skills':
      return listSkills(args.pack, opts);
    case 'huaweicloud_packs_configure':
      return configurePacks(args, opts);
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

// Deterministic (codepoint, not locale) reference listing shared by the
// skill disclosure tools. Regular files plus symlinks — the same read
// exposure the unfiltered readdir it replaced had (a symlink to a
// directory still throws at read time) — while subdirectories are
// excluded: they are not references retrieve_skill could read, so the
// catalog must not advertise them.
function referenceFilenames(skillName: string): string[] {
  const refDir = join(SKILLS_ROOT, skillName, 'references');
  if (!existsSync(refDir)) return [];
  return readdirSync(refDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Skill metadata catalog: one call disclosing every enabled non-core
// pack's skills (name, parsed description, version, owning pack, reference
// filenames) so an agent can browse before paying for retrieve_skill's
// full payload — and, on stdio sessions, the tree's location (skillRoot)
// so the agent can read the same files with its own tools the way it
// explores native skills: the taught default is the attempt-first direct
// read, with retrieve_skill as the fallback when the attempted read
// fails or is denied.
// Registry-driven on purpose (PACKS order, claimed
// skills only) rather than a tree walk: the output order is deterministic,
// every entry carries a defined pack, and the deliberate difference from
// searchDocs' ungated-straggler posture is that unclaimed directories do
// not exist here — verifySkillTree refuses to boot the server on any.
// Gating is disclosure-level on both fields' terms: catalog entries never
// reference a trimmed pack's skills, while skillRoot discloses the shared
// tree (every skill, including trimmed packs' and the six core
// meta-skills) — the same doctrine enable.ts applies to pack handlers.
// A missing SKILL.md for a claimed skill throws (readFileSync) and rides
// the callTool error pass-through: the boot guard makes hollow entries
// unreachable in a booted server (a file deleted or made unreadable after
// boot can still throw, riding the same pass-through), and fabricating
// metadata for a hollow entry would be worse than the honest crash.
function listSkills(pack: string | undefined, opts: CallToolOptions = {}) {
  const packId = String(pack ?? '').trim();
  if (pack !== undefined && packId === '') {
    return { ok: false, error: 'Pack id is required.' };
  }
  const enabled = resolveEnabledPacks();
  if (packId) {
    const found = PACKS.find((entry) => entry.id === packId);
    if (!found) return packNotFound(packId);
    if (packId === 'core') {
      return {
        ok: false,
        error:
          'The core pack\u2019s six meta-skills (huaweicloud-*) are not listed here by design: directory-loading agents disclose them natively in the system prompt, and huaweicloud_retrieve_skill serves them identically everywhere.',
      };
    }
    if (!enabled.has(found.id)) return packNotEnabled(found.id);
  }
  const skills: Array<{
    name: string;
    description: string;
    pack: string;
    version: string | number;
    references: string[];
  }> = [];
  for (const entry of PACKS) {
    if (entry.id === 'core') continue;
    if (packId && entry.id !== packId) continue;
    if (!enabled.has(entry.id)) continue;
    for (const skillName of entry.skills) {
      const fm = parseSkillFrontmatter(readFileSync(join(SKILLS_ROOT, skillName, 'SKILL.md'), 'utf8'));
      skills.push({
        name: skillName,
        description: fm.description ?? '',
        pack: entry.id,
        version: fm.version ?? 1,
        references: referenceFilenames(skillName),
      });
    }
  }
  // skillRoot rides only surfaces that carry session state (stdio), the
  // same seam listPacks uses to drop packs_configure from the remote's
  // tool inventory: the stateless remote serves an unauthenticated CORS-*
  // face whose callers cannot reach the server host's filesystem, so a
  // host path there would be pure leakage with no utility. The key itself
  // is withheld rather than nulled — absence is the guard.
  const stdioSession = Boolean(opts.onPacksChanged);
  return {
    ok: true,
    count: skills.length,
    skills,
    ...(stdioSession ? { skillRoot: SKILLS_ROOT } : {}),
  };
}

function explainError({ service = 'unknown', errorCode = '', message = '', requestId = '' }: ToolArgs = {}) {
  const combined = `${errorCode} ${message}`.toLowerCase();
  const suggestions: string[] = [];
  const svc = String(service).toLowerCase();

  const SERVICE_ALIASES: Record<string, string> = {
    functiongraph: 'FSS',
    fgs: 'FSS',
    ecs: 'Ecs',
    ECS: 'Ecs',
    kps: 'Kps',
    KPS: 'Kps',
    apic: 'APIG',
    apigw: 'APIGW',
    obs: 'OBS',
  };
  // #935 E2E-B1: real MCP calls pass only errorCode (e.g. Ecs.0019, KPS.9004)
  // with no service — derive the service key from the dotted-code prefix so the
  // service-keyed mapping table is hit. Behavior for an explicit real service
  // name is unchanged; absent/empty/'unknown' service derives from the prefix.
  let resolvedService = service;
  if ((!service || svc === 'unknown') && /^[A-Za-z]+\.\w+/.test(errorCode)) {
    const prefix = errorCode.split('.')[0]!.toLowerCase();
    resolvedService = SERVICE_ALIASES[prefix] ?? errorCode.split('.')[0]!.toUpperCase();
  }
  const patternKey = SERVICE_ALIASES[svc] || resolvedService;

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
    Ecs: {
      'Ecs.0707':
        'The flavor + image-type combination does not exist ("the product does not exist") — the error does not say which side is wrong, so check BOTH (#922): (1) the flavor is abandoned/sellout in this region/AZ (check os_extra_specs.cond:operation:status and cond:operation:az; see the huawei-ecs skill references/flavors.md for the AZ-vs-global-status conflict rule); (2) the image TYPE is incompatible with the flavor — market-type images fail with KunPeng flavors (kc1/kc2 etc.). Fix: switch the image to a gold-type image or switch to a compatible general-purpose flavor (verified: kc2.small.2 + market Ubuntu → Ecs.0707; s6.medium.2 + gold Ubuntu works), re-listing with hcloud ECS ListFlavors / hcloud IMS ListImages --__imagetype=gold first.',
      // #935 (report 4 problem 1 / report 1 坑5): real-world ECS order failures
      // with no mapping — flavor offline, AZ capacity, balance, keypair restriction.
      'Ecs.0019':
        'The flavor has been taken offline (Ecs.0019). Run `hcloud ECS ListFlavors --cli-region=<region>` to query currently on-sale flavors and switch to a replacement flavor (see the huawei-ecs skill references/flavors.md for the cond:operation:status field rules — a flavor marked 卖光/下线 keeps failing until you pick an on-sale one), then recreate.',
      'Ecs.0319':
        'The requested flavor has insufficient capacity in the selected availability zone (Ecs.0319). Fix: retry in a different availability zone, or switch to a replacement flavor (list on-sale flavors with `hcloud ECS ListFlavors --cli-region=<region>`), then recreate.',
      'Ecs.0044':
        'The requested volume type is sold out in the selected availability zone (Ecs.0044, e.g. "the volumeType [SATA] is sellout in az[cn-north-4a]"). This is the ROOT VOLUME/DISK type being unavailable — a different failure from Ecs.0319 (flavor capacity). Fix: switch `--server.root_volume.volumetype` to an available type (SAS/SSD/GPSSD — query availability first) or retry in a different availability zone (`hcloud ECS NovaListAvailabilityZones --cli-region=<region>`). ListFlavors does NOT pre-warn about volume-type sellouts — you only find out at order time.',
      'Ecs.0067':
        'Order submission rejected for balance reasons (Ecs.0067). Check the cash balance with `hcloud BSS ShowCustomerAccountBalances --cli-region=cn-north-1` and top up if needed — pay-per-use order risk control checks the CASH balance only (代金券/vouchers do NOT participate in order risk control; they only offset the bill at settlement). Also settle any historical arrears, however small, before retrying.',
    },
    Kps: {
      // #935 (report 1 坑5): KPS keypair creation has its own restriction code —
      // the Kps service had no entry at all, so the error fell through to generic advice.
      'KPS.9004':
        'Keypair creation rejected for account restrictions (KPS.9004). Check the cash balance with `hcloud BSS ShowCustomerAccountBalances --cli-region=cn-north-1` and top up if needed, and settle any historical arrears (even a small unpaid amount triggers this) — then retry `hcloud ECS NovaCreateKeypair` or create the keypair in the console.',
    },
    APIGW: {
      'APIGW.0301':
        'Incorrect IAM authentication information. The AK/SK is invalid (check the SK for typos), the security token is missing or expired, or the profile lacks project_id. Fix: re-run "npx huaweicloud-devkit auth init" (it auto-sets project_id), or set it manually: hcloud configure set --cli-project-id=<project_id> after finding it via hcloud IAM KeystoneListProjects --cli-region=<region> --name=<region>.',
      'APIGW.0802':
        'The current IAM user has no permissions in the requested region. Go to IAM console → Users → Permissions → add the target region, or switch to a different region.',
    },
  };
  const patternTable = hwErrorPatterns[patternKey];
  if (patternTable) {
    const exact: string | undefined = patternTable[errorCode];
    if (exact) {
      suggestions.push(exact);
    } else {
      // Case-variant transcriptions (e.g. ECS.0019 echoed from console output)
      // derive the right service key but used to miss the case-sensitive entry —
      // the exact-hit scan is case-insensitive on the code. Deliberate divergence
      // from main: without it the prefix-derivation feature no-ops on any
      // non-canonical casing.
      const lowerCode = errorCode.toLowerCase();
      for (const [code, tip] of Object.entries(patternTable)) {
        if (code.toLowerCase() === lowerCode) {
          suggestions.push(tip);
          break;
        }
      }
    }
  }
  const svcPatterns: Record<string, string> = patternTable || {};
  const lowerErrorCode = errorCode.toLowerCase();
  for (const [code, tip] of Object.entries(svcPatterns)) {
    if (errorCode && code.toLowerCase().includes(lowerErrorCode)) {
      if (!suggestions.includes(tip)) suggestions.push(tip);
    }
  }

  // When the active credential set is a temporary STS token that has already
  // expired, surface that as the PRIMARY cause before generic auth guidance.
  let activeCreds;
  try {
    activeCreds = resolveCredentialsWithRuntime({ allowMissing: true });
  } catch {
    activeCreds = null;
  }
  if (activeCreds?.ak && activeCreds?.sk && activeCreds.securityToken) {
    const expiry = parseStsExpiry({ securityToken: activeCreds.securityToken });
    if (expiry !== null && expiry <= Date.now()) {
      suggestions.push(
        'CREDENTIAL_EXPIRED: the temporary STS security token has expired. Re-authenticate to obtain fresh credentials (e.g. run "npx huaweicloud-devkit auth init" or re-login / restart the session).',
      );
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
        const fm = parseSkillFrontmatter(content);
        const description = fm.description ?? '';
        const name = fm.name ?? dir;
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

// The per-reference body cap in retrieve_skill payloads. Named so the
// structure guard can pin the taught description ("capped at N characters")
// to this single constant — and so the truncation marker interpolates the
// same number instead of restating it.
const REFERENCE_CAP = 4000;

async function retrieveSkill(name: string, opts: CallToolOptions = {}) {
  const skillName = String(name || '').trim();
  if (!skillName) return { ok: false, error: 'Skill name is required.' };
  // Boundary guard: the name joins a filesystem path in this handler, so
  // anything outside the skill-name shape (traversal segments, separators,
  // absolute paths) is rejected before touching disk; direct reads via the
  // disclosed skillRoot are the agent's own file tools' territory.
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
        '" which is not enabled. ' +
        packEnablementRemediation(owner),
    };
  }
  const content = readFileSync(skillPath, 'utf8');
  const references: Array<{ filename: string; content: string }> = [];
  for (const filename of referenceFilenames(skillName)) {
    const refPath = join(SKILLS_ROOT, skillName, 'references', filename);
    const raw = readFileSync(refPath, 'utf8');
    // The cap is silent no longer: cross-references deeper into a reference
    // (e.g. the safety remediation citing §Bootstrap or a late diagnosis
    // section) must be visibly unreachable here, not hollow — remote/file-less
    // agents only have this fallback, so a bare truncation reads as "the
    // section does not exist". The marker names the fix: direct file access
    // to skillRoot (disclosed in the stdio payload below).
    references.push({
      filename,
      content:
        raw.length > REFERENCE_CAP
          ? `${raw.substring(0, REFERENCE_CAP)}\n\n[truncated at ${REFERENCE_CAP} chars — full file at <skillRoot>/${skillName}/references/${filename}]`
          : raw,
    });
  }
  const frontmatter = parseSkillFrontmatter(content);
  const version: string | number = frontmatter.version ?? 1;
  const description = frontmatter.description ?? '';
  // The same stdio seam listSkills uses: a retrieve that already happened
  // (the fallback path) still teaches the caller where the tree lives, so
  // the NEXT skill can be a direct read. Withheld on the stateless remote
  // for the same reason listSkills withholds it — a host path there is
  // pure leakage with no utility.
  const stdioSession = Boolean(opts.onPacksChanged);
  return {
    ok: true,
    name: skillName,
    version,
    description,
    content,
    references,
    ...(stdioSession ? { skillRoot: SKILLS_ROOT } : {}),
  };
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
