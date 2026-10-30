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

export const BROWSER_WRITE_OPERATIONS = [
  'create_browser',
  'update_browser',
  'delete_browser',
  'create_browser_profile',
  'delete_browser_profile',
];

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

// Write-bridge tool definitions (token-gated like every approved cloud
// write in this repo). The create tool canonicalizes auth_type=IAM when
// absent (B1 verdict, trap 61): IAM-typed browsers sign the data plane
// with the same injected AK/SK — fully programmatic, no key file, no
// console round-trip.
export const AGENTARTS_BROWSER_WRITE_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_browser_plan',
    description:
      'Plan an AgentArts browser CONTROL-PLANE WRITE (SDK Browser class — the 0.1.7 CLI has no browser subcommands): create_browser, update_browser (tags only — the SDK updates observability and tags, this bridge exposes tags; an update without tags is rejected), delete_browser (irreversible), create_browser_profile, delete_browser_profile (irreversible). create_browser defaults auth_type to IAM (canonicalized into the request you approve): IAM-typed browsers sign the data plane with the same AK/SK this toolkit injects, so sessions and actions work with no further setup; an EXPLICIT auth_type=API_KEY creates a browser whose data plane needs the console api_key (HUAWEICLOUD_SDK_BROWSER_API_KEY) — the response never returns the key value (trap 61). The create response carries access_endpoint, which IS the data-plane base URL once https:// is prepended (trap 62). Resource/tag name rules: names ^[a-z][a-z0-9-]{0,38}[a-z0-9]$ (2-40, lowercase); tags max 20 items, unique keys, {key, value} strings. Deletes return before the list converges (seconds-scale staleness window, trap 63) and the shared defaultgw is NOT reclaimed. Validates the request, reads nothing from the cloud, and returns the exact request plus an approvalToken. Present the request to the user; on explicit approval run huaweicloud_agentarts_browser_write with the token and the SAME parameters.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: BROWSER_WRITE_OPERATIONS },
        name: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]{0,38}[a-z0-9]$',
          description:
            'create_browser/create_browser_profile: resource name (2-40 chars, lowercase letters/digits/hyphens, lowercase start/end).',
        },
        auth_type: {
          type: 'string',
          enum: ['IAM', 'API_KEY'],
          description:
            'create_browser only. Defaults to IAM (canonicalized): the data plane signs with the same injected AK/SK. API_KEY requires the console api_key later (trap 61) — the response never returns the key value.',
        },
        api_key_name: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_-]{1,64}$',
          description:
            'create_browser with auth_type=API_KEY only: the key NAME (1-64 chars). Rejected with auth_type=IAM (it would name a key the IAM data plane never uses).',
        },
        description: {
          type: 'string',
          description: 'create_browser/create_browser_profile: description (profile max 4096 chars).',
        },
        browser_id: { type: 'string', description: 'update_browser/delete_browser: browser resource ID (UUID).' },
        profile_id: { type: 'string', description: 'delete_browser_profile: profile ID (UUID).' },
        tags: {
          type: 'array',
          items: { type: 'object' },
          description:
            'create_browser/create_browser_profile/update_browser: max 20 items, unique keys, each {key: string, value: string}. The canonical request sorts them by key. An empty array is dropped (unset). update_browser REQUIRES tags (the only updatable field this bridge exposes).',
        },
        region: { type: 'string', description: 'Defaults to cn-southwest-2.' },
      },
    },
  },
  {
    name: 'huaweicloud_agentarts_browser_write',
    description:
      'Execute a PLANNED and USER-APPROVED AgentArts browser control-plane write. Requires approvedByUser: true (the explicit attestation — same gate as every approved runner in this toolkit), the approvalToken from huaweicloud_agentarts_browser_plan, and the EXACT same parameters (the token binds them; a mismatch rejects without consuming the token). Single-use: a successful execution consumes the token; replaying it returns already_processed with per-operation verify guidance — verify with huaweicloud_agentarts_browser_read before re-planning anything. delete_browser and delete_browser_profile are irreversible. A failed execution burns the token (re-plan to retry). AK/SK must be resolvable BEFORE consumption (a missing-credential rejection does not burn the token). After an update_browser success, verify with get_browser — the update family rule is success ≠ applied (measured on the sibling gateway family, trap 45). After a delete, the list may briefly still show the resource (seconds-scale window, trap 63) — poll list_browsers to confirm.',
    inputSchema: {
      type: 'object',
      required: ['approvalToken', 'approvedByUser', 'operation'],
      properties: {
        approvalToken: {
          type: 'string',
          description: 'The approvalToken returned by huaweicloud_agentarts_browser_plan for THIS exact request.',
        },
        approvedByUser: {
          type: 'boolean',
          description: 'Must be true — set it only after the user explicitly approved the plan request you presented.',
        },
        operation: { type: 'string', enum: BROWSER_WRITE_OPERATIONS },
        name: { type: 'string', description: 'Same name the plan bound (create ops).' },
        auth_type: { type: 'string', enum: ['IAM', 'API_KEY'], description: 'Same auth_type the plan bound.' },
        api_key_name: { type: 'string', description: 'Same api_key_name the plan bound (API_KEY only).' },
        description: { type: 'string', description: 'Same description the plan bound.' },
        browser_id: { type: 'string', description: 'Same browser_id the plan bound (update/delete).' },
        profile_id: { type: 'string', description: 'Same profile_id the plan bound.' },
        tags: {
          type: 'array',
          items: { type: 'object' },
          description: 'The EXACT tags from the plan (any order — the binding sorts by key).',
        },
        region: { type: 'string', description: 'Defaults to cn-southwest-2 (bound by the plan).' },
      },
    },
  },
];
