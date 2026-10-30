// AgentArts browser tool DEFINITIONS (schema layer), mirroring
// agentarts-memory-tools.mjs (the memory family's extraction precedent):
// this module holds only the operation enums the schemas reference and
// the tool definition arrays tools.mjs spreads. Definitions carry no
// handlers — dispatch lives in callAgentartsBrowserTool.
//
// Contract sources pinned here (B1 spike, 2026-10-30, findings traps
// 61-70):
// - The 0.1.7 CLI has ZERO browser subcommands (toolkit tree grep) — the
//   only path is the SDK Browser class (sdk/tools/browser).
// - auth_type split (trap 61): IAM-typed browsers sign the data plane
//   with the SAME injected AK/SK (fully programmatic — the bridge's
//   default posture); API_KEY-typed browsers need the console api_key
//   (the create/get response NEVER returns the key value, and the
//   identity-plane fetch is refused with AgentIdentityDirectoryService
//   .1003 — service-managed workload identity). The create tool
//   canonicalizes auth_type=IAM for exactly this reason.
// - Control-plane reads (list/get browsers and profiles) are AK/SK only
//   — same credential posture as list_agents.
// - Region cn-southwest-2 is the only e2e-measured region (trap 70).

export const BROWSER_READ_OPERATIONS = ['list_browsers', 'get_browser', 'list_browser_profiles', 'get_browser_profile'];

export const AGENTARTS_BROWSER_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_browser_read',
    description:
      'Read the AgentArts browser CONTROL plane (SDK Browser class — the 0.1.7 CLI has NO browser subcommands): list/get browser resources and browser profiles. Data plane (sessions, invoke actions) is a separate tool. auth_type matters when you pick a browser to drive: IAM-typed browsers sign the data plane with the same AK/SK this toolkit injects (fully programmatic); API_KEY-typed browsers require the console api_key in HUAWEICLOUD_SDK_BROWSER_API_KEY — the create/get response never returns the key value (measured, trap 61), so an API_KEY-typed browser made outside this toolkit cannot be driven without a console round-trip. access_endpoint in the response IS the data-plane base URL once https:// is prepended (the SDK has no region default for it, trap 62). List pagination is 0-based, limit 1-100 (SDK default 10), sort_key default created_at, sort_dir desc (asc|desc). Tag filters exist on the SDK list methods but are NOT exposed here — rejected as unknown params. Region defaults to cn-southwest-2 (the only e2e-measured region). Read-only: no approval needed.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: {
          type: 'string',
          enum: BROWSER_READ_OPERATIONS,
          description:
            'The read operation. Required params: get_browser → browser_id; get_browser_profile → profile_id.',
        },
        browser_id: {
          type: 'string',
          description: 'Browser resource ID (UUID). get_browser only.',
        },
        profile_id: { type: 'string', description: 'Browser profile ID (UUID). get_browser_profile only.' },
        name: {
          type: 'string',
          description: 'list_browsers/list_browser_profiles: name filter.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'List page size (SDK default 10).',
        },
        offset: { type: 'integer', minimum: 0, description: '0-based list offset.' },
        sort_key: { type: 'string', description: 'List sort key (SDK default created_at).' },
        sort_dir: { type: 'string', enum: ['asc', 'desc'], description: 'List sort direction (SDK default desc).' },
        region: { type: 'string', description: 'Defaults to cn-southwest-2.' },
      },
    },
  },
];
