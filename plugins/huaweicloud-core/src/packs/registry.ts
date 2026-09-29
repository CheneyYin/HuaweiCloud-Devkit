import type { ToolName } from '../tools.ts';

export type PackId = 'core' | 'sandbox' | 'auth' | 'obs' | 'voucher' | 'update' | 'discovery';

// PACK_OF is the single source of truth for tool → pack ownership. The
// satisfies check turns a missing or extra key into a compile error, so this
// map always covers exactly the TOOL_DEFINITIONS registry.
export const PACK_OF = {
  huaweicloud_check_cli: 'core',
  huaweicloud_plan_cli_command: 'core',
  huaweicloud_run_readonly_command: 'core',
  huaweicloud_list_operations: 'core',
  huaweicloud_run_approved_command: 'core',
  huaweicloud_show_profile_redacted: 'core',
  huaweicloud_hook_check_command: 'core',
  huaweicloud_hook_check_artifacts: 'core',
  huaweicloud_hook_check_deploy_plan: 'core',
  huaweicloud_service_catalog: 'core',
  huaweicloud_explain_error: 'core',
  huaweicloud_search_docs: 'core',
  huaweicloud_retrieve_skill: 'core',
  huaweicloud_list_regions: 'core',
  huaweicloud_get_regional_availability: 'core',
  huaweicloud_list_packs: 'core',
  huaweicloud_pack_info: 'core',
  huaweicloud_search_marketplace: 'discovery',
  huaweicloud_get_service_icon: 'discovery',
  huaweicloud_detect_framework: 'discovery',
  huaweicloud_setup_obs_config: 'obs',
  huaweicloud_obs_set_website_config: 'obs',
  huaweicloud_auth_status: 'auth',
  huaweicloud_auth_sync: 'auth',
  huaweicloud_auth_init: 'auth',
  huaweicloud_auth_switch: 'auth',
  huaweicloud_auth_confirm: 'auth',
  huaweicloud_sandbox_exec_with_session: 'sandbox',
  huaweicloud_sandbox_exec_one_shot: 'sandbox',
  huaweicloud_sandbox_close_session: 'sandbox',
  huaweicloud_sandbox_upload_file: 'sandbox',
  huaweicloud_sandbox_upload_project: 'sandbox',
  huaweicloud_sandbox_deploy_nginx: 'sandbox',
  huaweicloud_sandbox_deploy_check: 'sandbox',
  huaweicloud_sandbox_check_user: 'sandbox',
  huaweicloud_sandbox_sign_agreement: 'sandbox',
  huaweicloud_sandbox_connect: 'sandbox',
  huaweicloud_sandbox_credentials: 'sandbox',
  huaweicloud_voucher_status: 'voucher',
  huaweicloud_voucher_claim: 'voucher',
  huaweicloud_check_update: 'update',
  huaweicloud_upgrade: 'update',
} as const satisfies Record<ToolName, PackId>;

// Per-pack tool lists invert PACK_OF instead of hand-writing name lists, so a
// pack can never claim an unassigned or non-existent tool.
function toolsFor(id: PackId): ToolName[] {
  return (Object.keys(PACK_OF) as ToolName[]).filter((tool) => PACK_OF[tool] === id);
}

export interface Pack {
  id: PackId;
  title: string;
  description: string;
  /** skills/ directory names this pack ships. */
  skills: string[];
  tools: ToolName[];
}

// skills are hand-written claims over the plugin skills/ directories; the pack
// tests fail when one is claimed twice, left unclaimed, or removed.
export const PACKS: readonly Pack[] = [
  {
    id: 'core',
    title: 'Core',
    description:
      'KooCLI command planning and execution, hook risk checks, capability catalog, documentation and skill retrieval, and region discovery for Huawei Cloud agent tasks.',
    skills: [
      'huawei-apig',
      'huawei-billing',
      'huawei-cbr',
      'huawei-cce',
      'huawei-cloud-eye',
      'huawei-cts',
      'huawei-dds-dcs',
      'huawei-deployment',
      'huawei-dew',
      'huawei-ecs',
      'huawei-functiongraph',
      'huawei-gaussdb',
      'huawei-getting-started',
      'huawei-iac',
      'huawei-iam',
      'huawei-modelarts',
      'huawei-rds',
      'huawei-smn-dms',
      'huawei-vpc',
      'huawei-waf-aad',
      'huaweicloud-api-and-sdk',
      'huaweicloud-capability-discovery',
      'huaweicloud-cli-and-auth',
      'huaweicloud-core',
      'huaweicloud-safety',
      'huaweicloud-troubleshooting',
    ],
    tools: toolsFor('core'),
  },
  {
    id: 'sandbox',
    title: 'Sandbox',
    description:
      'Cloud sandbox workspace terminals: session and one-shot execution, file and project upload, nginx deployment and deployment checks, and hdkitservice onboarding.',
    skills: ['huawei-sandbox'],
    tools: toolsFor('sandbox'),
  },
  {
    id: 'auth',
    title: 'Auth',
    description:
      'Unified Huawei Cloud credential status, vault sync, runtime injection, and reconciliation across KooCLI, OBS, and agent MCP registrations.',
    skills: [],
    tools: toolsFor('auth'),
  },
  {
    id: 'obs',
    title: 'OBS',
    description: 'OBS credential synchronization and static website hosting configuration for buckets.',
    skills: ['huawei-obs'],
    tools: toolsFor('obs'),
  },
  {
    id: 'voucher',
    title: 'Voucher',
    description: 'Voucher claiming status and one-time voucher redemption.',
    skills: ['huawei-voucher'],
    tools: toolsFor('voucher'),
  },
  {
    id: 'update',
    title: 'Update',
    description: 'Plugin version check and consent-gated in-place upgrade for huaweicloud-devkit.',
    skills: [],
    tools: toolsFor('update'),
  },
  {
    id: 'discovery',
    title: 'Discovery',
    description:
      'Marketplace skill search, official Huawei Cloud service icon lookup, and local web framework detection.',
    skills: [],
    tools: toolsFor('discovery'),
  },
];
