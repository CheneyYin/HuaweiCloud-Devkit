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
