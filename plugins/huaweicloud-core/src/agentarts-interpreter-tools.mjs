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
  'start_session',
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
      'Plan an AgentArts code interpreter WRITE (SDK CodeInterpreter class — the 0.1.7 CLI has no code-interpreter subcommands): resource lifecycle — create_code_interpreter, update_code_interpreter (tags only — the SDK updates observability and tags, this bridge exposes tags; an update without tags is rejected), delete_code_interpreter (irreversible) — plus the DATA-PLANE session start: start_session (one approval starts the session AND its lease: the session_timeout shown is what the local 0600 lease record enforces as the consent boundary, while the cloud session dies independently — measured not a wall clock at 60s, trap 85 — so stop is the only deterministic cleanup; the write resolves the interpreter access_endpoint and auth_type from the control plane and records the lease). create_code_interpreter defaults auth_type to IAM (canonicalized into the request you approve): IAM-typed interpreters sign the data plane with the same AK/SK this toolkit injects, so sessions and actions work with no further setup; an EXPLICIT auth_type=API_KEY creates an interpreter whose data plane needs the console api_key (HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY) — the response is not known to return the key value (browser family measured this for browsers, trap 61; CI-side unmeasured). The create response carries access_endpoint (the bare data-plane base URL — the SDK constructor auto-prepends https://, trap 82) and attaches the tenant-shared default gateway, which persists across deletes (trap 63 family). Resource/tag name rules: names ^[a-z][a-z0-9-]{0,38}[a-z0-9]$ (2-40, lowercase); tags max 20 items, unique keys, {key, value} strings. After a delete, the list converges in 2-10 seconds (trap 89) and the delete CASCADES to the interpreter sessions (trap 86 — a live session starts answering "No matching policy found"). Validates the request, reads nothing from the cloud, and returns the exact request plus an approvalToken. Present the request to the user; on explicit approval run huaweicloud_agentarts_interpreter_write with the token and the SAME parameters.',
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
        code_interpreter_name: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]{0,38}[a-z0-9]$',
          description:
            'start_session: the interpreter resource to start a session on (the write resolves its access_endpoint and auth_type from the control plane at execution time and records the 0600 session state file — the lease).',
        },
        session_name: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_-]{1,128}$',
          description:
            'start_session: client-chosen session name (1-128 chars; a conservative bridge window — the SDK applies no rule of its own).',
        },
        session_timeout: {
          type: 'integer',
          minimum: 60,
          maximum: 86400,
          description:
            'start_session: lease seconds (SDK default 900; docstring range 60-86400 with both bounds measured accepted). The LOCAL lease expires at start + timeout — the consent boundary — while the cloud session dies independently and is measured NOT a wall clock at 60s (trap 85): stop is the only deterministic cleanup.',
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
        code_interpreter_name: {
          type: 'string',
          description: 'Same code_interpreter_name the plan bound (start_session).',
        },
        session_name: { type: 'string', description: 'Same session_name the plan bound (start_session).' },
        session_timeout: {
          type: 'integer',
          description: 'Same session_timeout the plan bound (start_session; omitted = the SDK default 900).',
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

export const INTERPRETER_SESSION_OPERATIONS = ['get_session', 'stop_session'];

// Free-tier session tool (CI4): the two risk-reducing/read session ops
// that never need an approval token. Session context (the addressing
// PAIR — code_interpreter_name + session_id — plus endpoint/auth/region)
// comes from the 0600 state file the start_session write recorded.
export const AGENTARTS_INTERPRETER_SESSION_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_interpreter_session',
    description:
      "Operate a LIVE AgentArts code interpreter session the start_session write recorded (SDK data plane — the 0.1.7 CLI has no session subcommands). Free-tier by design: get_session (read the session details — code_interpreter_id, session_id, name, created_at, session_timeout), stop_session (cleanup — risk only decreases; success means the stop request was accepted, and a dead session surfaces as an error with its own mapping instead — trap 87's no-op True needs an empty SDK client state this tool never has; the local lease record is deleted on success AND on a confirmed death signature). Both ops take session_id — the id start_session returned and printed in its result/notes; the addressing pair and the data-plane endpoint/auth resolve from the 0600 session state file, never from tool args. Both ops stay REACHABLE past the local lease expiry — the cloud session outlives the nominal timeout (measured, trap 85), so stop is the only deterministic cleanup and must not gate on the local clock. Error shapes are mapped: 'Session not found' → the session died on the interpreter (expired at its own leisure or otherwise) — the lease record is cleared and a re-start is unblocked; 'No matching policy found' → the INTERPRETER itself was deleted (trap 86 — delete cascades to sessions) — the record is cleared too; 'API Key is not provided' → the interpreter is API_KEY-typed and HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY is not exported. An expired lease is disclosed in notes, never a hard rejection.",
    inputSchema: {
      type: 'object',
      required: ['operation', 'session_id'],
      properties: {
        operation: {
          type: 'string',
          enum: INTERPRETER_SESSION_OPERATIONS,
          description: 'get_session (read) or stop_session (cleanup + delete the local lease record).',
        },
        session_id: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          description: 'The session id start_session returned (the 0600 session state file is looked up by it).',
        },
      },
    },
  },
];

// The five invoke action types (the minimal action surface, operator
// ruling 2026-11-02: execute_code / install_packages / upload_files /
// download_file / clear_context — NO raw execute_command; the sandbox
// shell makes `>=`-style specs silent redirects and newline package
// names second commands, both with exit_code 0, trap 84).
export const INTERPRETER_INVOKE_ACTIONS = [
  'execute_code',
  'install_packages',
  'upload_files',
  'download_file',
  'clear_context',
];

// Lease-gated action tool (CI5): one invoke surface for all five action
// types. The lease recorded by start_session IS the approval boundary —
// actions ride free within it (the timeout was consented at start); an
// expired lease hard-rejects NEW work (re-approval) while the session
// tool's stop stays reachable past it (trap 85's cloud-lifetime caveat).
export const AGENTARTS_INTERPRETER_INVOKE_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_interpreter_invoke',
    description:
      "Invoke a code-interpreter action on a LIVE session (SDK data plane — the 0.1.7 CLI has no invoke subcommands). The five action types: execute_code (python in the sandbox's IPython kernel — stdout/stderr arrive as ordered text content blocks, a remote exception sets is_error true and carries the IPython traceback, sys.exit(N) does NOT propagate as an exit code, trap 83; variables persist across calls, clear_context resets them), install_packages (pip in the sandbox, pypi egress measured working, trap 88), upload_files (batch, ATOMIC — all files or none, paths under /home/user only; content is text or {base64} for binary), download_file (a path under /home/user; UTF-8-decodable content returns as text, binary content is decoded to a 0600 file under /tmp/huaweicloud-devkit and the result carries the path — the base64 never rides the payload, trap 88), and clear_context (reset the kernel namespace). Lease-gated, not token-gated: the session's recorded lease IS the approval (its timeout was consented at start) — a missing lease record is rejected with start guidance, and an EXPIRED lease hard-rejects new work with SESSION_LEASE_EXPIRED (re-approval via a new start_session; the cloud session may still be live — measured not a wall clock, trap 85 — and stop in the session tool stays reachable for cleanup). Package version specs accept `==` ONLY: `>` `<` `>=` forms are rejected at the boundary because the sandbox shell interprets them as redirection with exit_code 0 (trap 84), and whitespace or shell metacharacters in package names are the injection vector the SDK's own check misses. Session-death errors are mapped and clear the lease record: 'Session not found' → the session died (re-start via the write pair), 'No matching policy found' → the interpreter was deleted (trap 86), 'API Key is not provided' → the interpreter is API_KEY-typed and HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY is not exported (trap 81).",
    inputSchema: {
      type: 'object',
      required: ['action', 'session_id'],
      properties: {
        action: {
          type: 'string',
          enum: INTERPRETER_INVOKE_ACTIONS,
          description: 'The action type.',
        },
        session_id: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          description: 'The session id start_session returned (the 0600 lease record is looked up by it).',
        },
        code: {
          type: 'string',
          description:
            'execute_code: the python code to execute (the sandbox is an IPython kernel — variables persist across calls).',
        },
        clear_context: {
          type: 'boolean',
          description: 'execute_code: clear the kernel namespace BEFORE this execution (default false).',
        },
        packages: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 20,
          description:
            'install_packages: package names, optionally with an `==` version spec (six or six==1.16.0). Whitespace and shell metacharacters are rejected — the SDK builds a shell command from these names and the sandbox runs it through a shell (trap 84: a newline in a name injects a second command with exit_code 0).',
        },
        upgrade: {
          type: 'boolean',
          description: 'install_packages: pass pip --upgrade (default false).',
        },
        files: {
          type: 'array',
          items: { type: 'object' },
          minItems: 1,
          maxItems: 20,
          description:
            'upload_files: batch (ATOMIC — all files or none). Each item {path, content}: path under /home/user (absolute), content a non-empty string (text) or {base64: string} with strict base64 charset — corrupt base64 is rejected, never silently decoded (Python b64decode discards invalid characters, measured). A description field is NOT accepted: the SDK upload reads path and content only (measured, silent no-op end-to-end).',
        },
        path: {
          type: 'string',
          description: 'download_file: the file path under /home/user (absolute).',
        },
      },
    },
  },
];
