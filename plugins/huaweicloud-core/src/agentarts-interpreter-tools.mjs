// AgentArts code interpreter tool DEFINITIONS (schema layer), mirroring
// agentarts-browser-tools.mjs: this module holds only the operation enums
// the schemas reference and the tool definition arrays tools.mjs spreads.
// Definitions carry no handlers — dispatch lives in
// callAgentartsInterpreterTool.
//
// Contract sources pinned here (CI1 spike, 2026-11-02, findings traps
// 81-90):
// - The 0.1.7 CLI has ZERO code-interpreter subcommands — the only path
//   is the SDK CodeInterpreter class (sdk/tools/code_interpreter).
// - auth_type split (trap 81): IAM-typed interpreters sign the data plane
//   with the SAME injected AK/SK (fully programmatic — the bridge's
//   default posture); API_KEY-typed interpreters need the console api_key
//   in HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY. The create tool
//   canonicalizes auth_type=IAM for exactly this reason.
// - list items carry NO auth_type and no network_config (trap 89) — only
//   get_code_interpreter proves the auth posture.
// - access_endpoint is a bare defaultgw domain; the CodeInterpreter
//   constructor data_endpoint param auto-prepends the scheme (trap 82 —
//   unlike the browser client).
// - Region cn-southwest-2 is the only e2e-measured region (trap 81).

export const INTERPRETER_READ_OPERATIONS = ['list_code_interpreters', 'get_code_interpreter'];

export const AGENTARTS_INTERPRETER_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_interpreter_read',
    description:
      'Read the AgentArts code interpreter CONTROL plane (SDK CodeInterpreter class — the 0.1.7 CLI has NO code-interpreter subcommands): list/get interpreter resources. Data plane operations (sessions, code execution, package installs, file transfer) are the later units of this bridge family. auth_type matters when you pick an interpreter to drive: IAM-typed interpreters sign the data plane with the same AK/SK this toolkit injects (fully programmatic); API_KEY-typed interpreters require the console api_key in HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY — the create/get response is not known to return the key value (measured on the browser family, trap 61; CI-side unmeasured). list items carry NO auth_type and no network_config (measured, trap 89) — only get_code_interpreter proves the auth posture, so get before driving a resource you did not create through this toolkit. access_endpoint in get/create responses is the bare data-plane base URL (defaultgw-... domain); the SDK constructor auto-prepends https:// (trap 82). List pagination is 0-based, limit 1-100 (a conservative bridge window; SDK default 10, the SDK applies no cap), sort_key created_at or updated_at, sort_dir asc or desc. Tag filters exist on the SDK list method but are NOT exposed here — rejected as unknown params. Region must match ^[a-z0-9-]{1,64}$ (it steers the hostname of the AK/SK-signed request); defaults to cn-southwest-2 (the only e2e-measured region). Read-only: no approval needed.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: {
          type: 'string',
          enum: INTERPRETER_READ_OPERATIONS,
          description: 'The read operation. Required params: get_code_interpreter → code_interpreter_id.',
        },
        code_interpreter_id: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          description: 'Code interpreter resource ID (UUID). get_code_interpreter only.',
        },
        name: {
          type: 'string',
          minLength: 2,
          maxLength: 40,
          description: 'list_code_interpreters: name filter (2-40 chars, the SDK client-side rule).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'List page size (SDK default 10).',
        },
        offset: { type: 'integer', minimum: 0, description: '0-based list offset.' },
        sort_key: {
          type: 'string',
          enum: ['created_at', 'updated_at'],
          description: 'List sort key — created_at or updated_at only (the SDK client-side rule).',
        },
        sort_dir: { type: 'string', enum: ['asc', 'desc'], description: 'List sort direction.' },
        region: {
          type: 'string',
          description:
            'Defaults to cn-southwest-2. Must match ^[a-z0-9-]{1,64}$ (a region id — it steers the request host).',
        },
      },
    },
  },
];

export const INTERPRETER_WRITE_OPERATIONS = [
  'create_code_interpreter',
  'update_code_interpreter',
  'delete_code_interpreter',
];

// Write-bridge tool definitions (token-gated like every approved cloud
// write in this repo). The create tool canonicalizes auth_type=IAM when
// absent (the CI1 verdict, trap 81): IAM-typed interpreters sign the data
// plane with the same injected AK/SK — fully programmatic, no key file,
// no console round-trip.
export const AGENTARTS_INTERPRETER_WRITE_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_interpreter_plan',
    description:
      'Plan an AgentArts code interpreter WRITE (SDK CodeInterpreter class — the 0.1.7 CLI has no code-interpreter subcommands): resource lifecycle — create_code_interpreter, update_code_interpreter (tags only — the SDK updates observability and tags, this bridge exposes tags; an update without tags is rejected), delete_code_interpreter (irreversible). create_code_interpreter defaults auth_type to IAM (canonicalized into the request you approve): IAM-typed interpreters sign the data plane with the same AK/SK this toolkit injects, so sessions and actions work with no further setup; an EXPLICIT auth_type=API_KEY creates an interpreter whose data plane needs the console api_key (HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY) — the response is not known to return the key value (browser family measured this for browsers, trap 61; CI-side unmeasured). The create response carries access_endpoint (the bare data-plane base URL — the SDK constructor auto-prepends https://, trap 82) and attaches the tenant-shared default gateway, which persists across deletes (trap 63 family). Resource/tag name rules: names ^[a-z][a-z0-9-]{0,38}[a-z0-9]$ (2-40, lowercase); tags max 20 items, unique keys, {key, value} strings. After a delete, the list converges in 2-10 seconds (trap 89) and the delete CASCADES to the interpreter sessions (trap 86 — a live session starts answering "No matching policy found"). Validates the request, reads nothing from the cloud, and returns the exact request plus an approvalToken. Present the request to the user; on explicit approval run huaweicloud_agentarts_interpreter_write with the token and the SAME parameters.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: INTERPRETER_WRITE_OPERATIONS },
        name: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]{0,38}[a-z0-9]$',
          description:
            'create_code_interpreter: resource name (2-40 chars, lowercase letters/digits/hyphens, lowercase start/end — the SDK rejects anything else client-side).',
        },
        auth_type: {
          type: 'string',
          enum: ['IAM', 'API_KEY'],
          description:
            'create_code_interpreter only. Defaults to IAM (canonicalized): the data plane signs with the same injected AK/SK. API_KEY requires the console api_key later (the response is not known to return the key value — browser-family measurement, trap 61).',
        },
        api_key_name: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_-]{1,64}$',
          description:
            'create_code_interpreter with auth_type=API_KEY only: the key NAME (1-64 chars). Rejected with auth_type=IAM (it would name a key the IAM data plane never uses).',
        },
        description: {
          type: 'string',
          description: 'create_code_interpreter: description.',
        },
        code_interpreter_id: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          description:
            'update_code_interpreter/delete_code_interpreter: resource ID (UUID — a bridge-side gate; pass the id exactly as list_code_interpreters returned it).',
        },
        tags: {
          type: 'array',
          items: { type: 'object' },
          description:
            'create_code_interpreter/update_code_interpreter: max 20 items, unique keys, each {key: string, value: string}. The canonical request sorts them by key. An empty array is dropped (unset). update_code_interpreter REQUIRES tags (the only updatable field this bridge exposes).',
        },
        region: {
          type: 'string',
          description: 'Defaults to cn-southwest-2. Must match ^[a-z0-9-]{1,64}$ (it steers the request host).',
        },
      },
    },
  },
  {
    name: 'huaweicloud_agentarts_interpreter_write',
    description:
      "Execute a PLANNED and USER-APPROVED AgentArts code interpreter write (resource lifecycle). Requires approvedByUser: true (the explicit attestation — same gate as every approved runner in this toolkit), the approvalToken from huaweicloud_agentarts_interpreter_plan, and the EXACT same parameters (the token binds them; a mismatch rejects without consuming the token). Single-use: a successful execution consumes the token; replaying it returns already_processed with per-operation verify guidance — verify with huaweicloud_agentarts_interpreter_read before re-planning anything. delete_code_interpreter is irreversible, cascades to the interpreter's live sessions (trap 86), and the list still shows the resource for 2-10 seconds afterwards (trap 89) — poll list_code_interpreters to confirm. After an update_code_interpreter success, verify with get_code_interpreter — the update-family rule is success ≠ applied (measured on the sibling gateway family, trap 45). A failed execution burns the token (re-plan to retry). AK/SK must be resolvable BEFORE consumption (a missing-credential rejection does not burn the token).",
    inputSchema: {
      type: 'object',
      required: ['approvalToken', 'approvedByUser', 'operation'],
      properties: {
        approvalToken: {
          type: 'string',
          description: 'The approvalToken returned by huaweicloud_agentarts_interpreter_plan for THIS exact request.',
        },
        approvedByUser: {
          type: 'boolean',
          description: 'Must be true — set it only after the user explicitly approved the plan request you presented.',
        },
        operation: { type: 'string', enum: INTERPRETER_WRITE_OPERATIONS },
        name: { type: 'string', description: 'Same name the plan bound (create).' },
        auth_type: { type: 'string', enum: ['IAM', 'API_KEY'], description: 'Same auth_type the plan bound.' },
        api_key_name: { type: 'string', description: 'Same api_key_name the plan bound (API_KEY only).' },
        description: { type: 'string', description: 'Same description the plan bound.' },
        code_interpreter_id: {
          type: 'string',
          description: 'Same code_interpreter_id the plan bound (update/delete).',
        },
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
