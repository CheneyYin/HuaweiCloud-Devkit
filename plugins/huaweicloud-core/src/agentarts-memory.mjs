// AgentArts memory DATA-PLANE read bridge (U2). The 0.1.7 CLI stops at
// space management — the SDK's MemoryClient exposes 12 data-plane methods
// with zero CLI subcommands (fixtures + client.py, findings trap 1), so an
// agent that created a space through the wrapper hit a dead end. This
// module bridges the 8 READ-ONLY methods through the same safety model as
// list_agents: an inline python snippet over the CLI-owned interpreter,
// argv-as-data parameters, our own exit codes, allowlist child env,
// redaction on every surface. The 4 WRITE methods (create_session,
// add_messages, delete_session, delete_memory) are a separate unit with
// approval-token gating.
//
// Credential model (deliberately NARROWER than every other agentarts
// tool): the data plane authenticates with a per-space one-time api_key
// (Authorization: Bearer), NOT AK/SK — MemoryClient's control plane is
// lazy and none of these methods touch it. The key is read from the
// wrapper-captured 0600 key file (memoryApiKeyFile), injected ONLY into
// the child env (HUAWEICLOUD_SDK_MEMORY_API_KEY), and never appears in
// argv, the tool arguments, or the payload.
//
// Failure contract: the snippet's exit codes are OURS and trustworthy
// (0 = JSON printed, 1 = failure, 3 = module missing). NO content
// signature scan runs on the payload — memory CONTENT is by design a
// store of failure experience (tracebacks, ERROR log lines), so scanning
// result text for CLI failure signatures guarantees false positives on
// successful reads. Exit code + stdout-parseability is the whole
// detector.

import { readFileSync } from 'node:fs';

import {
  AGENTARTS_SDK_MIRROR,
  buildChildEnv,
  DEFAULT_APPROVED_TIMEOUT_MS,
  memoryApiKeyFile,
  pinnedSdkVersion,
  pythonCandidatesForAgentarts,
  READONLY_TIMEOUT_MS,
  runOverPythonCandidates,
  saveLargeOutput,
} from './agentarts-cli.mjs';
import { createApprovalTokenStore, hashNamespacedArgs } from './approval-tokens.mjs';
import { redactSecrets } from './safety-policy.mjs';

// The 8 read-only data-plane methods, transcribed from the pinned venv's
// sdk/memory/client.py. Signatures with per-op required params:
// - list_sessions(space_id, actor_id?, limit 1-20 def 20, offset def 0)
// - get_session(space_id, session_id)
// - get_last_k_messages(session_id, k, space_id)  [k positive int]
// - get_message(message_id, space_id, session_id) [note the arg order]
// - list_messages(space_id, session_id?, limit 1-100 def 10, offset def 0)
// - search_memories(space_id, MemorySearchFilter) — actor_id REQUIRED at
//   this tool's boundary: server-side isolation is ACTOR-level only
//   (scope_id never leaves the client), so an unscoped search silently
//   returns every actor's memories.
// - list_memories(space_id, limit 1-100 def 10, offset def 0, MemoryListFilter?)
//   — actor_id optional and documented: omitting it lists ALL actors'
//   memories in the space (an ops/debug stance, stated in the tool text).
// - get_memory(space_id, memory_id)
export const MEMORY_READ_OPERATIONS = [
  'list_sessions',
  'get_session',
  'get_last_k_messages',
  'get_message',
  'list_messages',
  'search_memories',
  'list_memories',
  'get_memory',
];

const LIMIT_RANGES = {
  list_sessions: [1, 20],
  list_messages: [1, 100],
  list_memories: [1, 100],
};

const MEMORY_READ_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk.memory.client import MemoryClient',
  '    from agentarts.sdk.memory.inner.config import MemoryListFilter, MemorySearchFilter',
  '    params = json.loads(sys.argv[1])',
  '    client = MemoryClient(region_name=params["region"])',
  '    op = params["operation"]',
  '    space = params["space_id"]',
  '    if op == "list_sessions":',
  '        kwargs = {}',
  '        if params.get("actor_id"): kwargs["actor_id"] = params["actor_id"]',
  '        if params.get("limit") is not None: kwargs["limit"] = params["limit"]',
  '        if params.get("offset") is not None: kwargs["offset"] = params["offset"]',
  '        result = client.list_sessions(space, **kwargs)',
  '    elif op == "get_session":',
  '        result = client.get_session(space, params["session_id"])',
  '    elif op == "get_last_k_messages":',
  '        result = client.get_last_k_messages(params["session_id"], params["k"], space)',
  '    elif op == "get_message":',
  '        result = client.get_message(params["message_id"], space, params["session_id"])',
  '    elif op == "list_messages":',
  '        kwargs = {}',
  '        if params.get("session_id"): kwargs["session_id"] = params["session_id"]',
  '        if params.get("limit") is not None: kwargs["limit"] = params["limit"]',
  '        if params.get("offset") is not None: kwargs["offset"] = params["offset"]',
  '        result = client.list_messages(space, **kwargs)',
  '    elif op == "search_memories":',
  '        filters = MemorySearchFilter(**params["filters"])',
  '        result = client.search_memories(space, filters)',
  '    elif op == "list_memories":',
  '        kwargs = {}',
  '        if params.get("limit") is not None: kwargs["limit"] = params["limit"]',
  '        if params.get("offset") is not None: kwargs["offset"] = params["offset"]',
  '        if params.get("filters"): kwargs["filters"] = MemoryListFilter(**params["filters"])',
  '        result = client.list_memories(space, **kwargs)',
  '    elif op == "get_memory":',
  '        result = client.get_memory(space, params["memory_id"])',
  '    else:',
  '        print("AGENTARTS_MEMORY_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'except Exception as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Filter-key allowlists, transcribed from the pinned venv's
// sdk/memory/inner/config.py dataclasses. The boundary REJECTS unknown
// keys: a stray key would either raise a dataclass TypeError at run time
// or (worse) ride the argv JSON silently — and a credential-shaped key in
// filters would put a secret on the process list (the top-level params
// are whitelisted; filters must be too).
// - search: actor_id is managed by the REQUIRED top-level param (the
//   bridge injects it into filters) — passing it inside filters is
//   rejected to avoid two sources for one isolation-critical field.
// - list: sort_by/sort_order exist on the dataclass but the 0.1.7 HTTP
//   layer never sends them (memory_service.py filter_mappings maps 7
//   keys) — rejected as the silent-no-op class.
const SEARCH_FILTER_FIELDS = [
  'query',
  'strategy_type',
  'strategy_id',
  'assistant_id',
  'session_id',
  'memory_type',
  'start_time',
  'end_time',
  'top_k',
  'min_score',
];
const LIST_FILTER_FIELDS = [
  'strategy_type',
  'strategy_id',
  'actor_id',
  'assistant_id',
  'session_id',
  'start_time',
  'end_time',
];

function validateFilterKeys(operation, filters) {
  const legal = operation === 'search_memories' ? SEARCH_FILTER_FIELDS : LIST_FILTER_FIELDS;
  for (const key of Object.keys(filters)) {
    if (key === 'actor_id' && operation === 'search_memories') {
      return 'filters.actor_id is managed by the required top-level actor_id parameter — pass it there, not inside filters.';
    }
    if ((key === 'sort_by' || key === 'sort_order') && operation === 'list_memories') {
      return `filters.${key} exists on the MemoryListFilter dataclass but the 0.1.7 HTTP layer never sends it (memory_service.py filter_mappings) — a silent no-op. Sorting is server-default only.`;
    }
    if (!legal.includes(key)) {
      return `Unknown filters key "${key}" — legal keys for ${operation}: ${legal.join(', ')}.`;
    }
  }
  return null;
}

// Boundary validation (the tool's front door — the snippet trusts what
// arrives). Returns an error string or null.
function validateMemoryRead(params) {
  if (!MEMORY_READ_OPERATIONS.includes(params.operation)) {
    return `operation must be one of: ${MEMORY_READ_OPERATIONS.join(', ')}.`;
  }
  const spaceFile = memoryApiKeyFile(params.space_id);
  if (!spaceFile.ok) return spaceFile.error;
  if (typeof params.space_id !== 'string' || params.space_id.length === 0) {
    return 'space_id is required.';
  }
  const need = (field, message) => {
    if (typeof params[field] !== 'string' || params[field].length === 0) return message;
    return null;
  };
  // list_messages: the SDK docstring claims session_id is optional ("query
  // all messages under Space"), but the 0.1.7 HTTP layer builds
  // /sessions/{session_id}/messages unconditionally — None stringifies
  // into the path (memory_service.py list_messages). Required here until
  // an S0 run proves the space-wide form works.
  if (
    params.operation === 'get_session' ||
    params.operation === 'get_last_k_messages' ||
    params.operation === 'list_messages'
  ) {
    const err = need('session_id', 'session_id is required for this operation.');
    if (err) return err;
  }
  if (params.operation === 'get_message') {
    const err =
      need('session_id', 'session_id is required for this operation.') ??
      need('message_id', 'message_id is required for this operation.');
    if (err) return err;
  }
  if (params.operation === 'get_memory') {
    const err = need('memory_id', 'memory_id is required for this operation.');
    if (err) return err;
  }
  if (params.operation === 'search_memories') {
    if (typeof params.actor_id !== 'string' || params.actor_id.length === 0) {
      return "actor_id is REQUIRED for search_memories: server-side isolation is actor-level only — an unscoped search silently returns every actor's memories in the space.";
    }
    const filters = params.filters;
    if (
      !filters ||
      typeof filters !== 'object' ||
      Array.isArray(filters) ||
      typeof filters.query !== 'string' ||
      filters.query.length === 0
    ) {
      return 'search_memories requires filters.query (a non-empty string) — the semantic query.';
    }
  }
  const range = LIMIT_RANGES[params.operation];
  if (range) {
    for (const field of ['limit', 'offset']) {
      if (params[field] !== undefined && params[field] !== null) {
        const value = Number(params[field]);
        if (!Number.isSafeInteger(value)) return `${field} must be an integer.`;
        if (field === 'limit' && (value < range[0] || value > range[1])) {
          return `limit must be ${range[0]}-${range[1]} for ${params.operation} (SDK range).`;
        }
        if (field === 'offset' && value < 0) return 'offset must be >= 0 (0-based).';
      }
    }
  }
  if (params.operation === 'get_last_k_messages') {
    const k = Number(params.k);
    if (!Number.isSafeInteger(k) || k < 1) return 'k must be a positive integer for get_last_k_messages.';
  }
  if (params.filters !== undefined && params.filters !== null) {
    // Only the two list/search operations take filters — on the other six
    // the param would ride the argv JSON and be silently ignored by the
    // snippet (the same silent-no-op class as sort_by).
    if (params.operation !== 'search_memories' && params.operation !== 'list_memories') {
      return `${params.operation} takes no filters — only search_memories and list_memories do.`;
    }
    if (typeof params.filters !== 'object' || Array.isArray(params.filters)) {
      return 'filters must be an object (MemorySearchFilter / MemoryListFilter fields).';
    }
    const filterError = validateFilterKeys(params.operation, params.filters);
    if (filterError) return filterError;
  }
  return null;
}

// Read the one-time data-plane key from the wrapper-captured 0600 file.
// Failure carries the bootstrap remediation: key files exist only for
// spaces created through this wrapper's `memory create` — a space made in
// the user's terminal has no file, and the key is unrecoverable upstream
// (no re-issue command; the S0 question whether `memory get` returns it
// once is open).
function loadMemoryApiKey(spaceId) {
  const file = memoryApiKeyFile(spaceId);
  if (!file.ok) return { ok: false, error: file.error };
  let key;
  try {
    key = readFileSync(file.path, 'utf8').trim();
  } catch {
    return {
      ok: false,
      error: `No data-plane api_key file for space ${spaceId} at ${file.path}. Key files exist only for spaces created through huaweicloud_agentarts_run_approved_command (memory create) — the one-time key is printed once and has no re-issue command. For a space created outside the wrapper, delete and recreate it through the memory create tool to capture a fresh key.`,
    };
  }
  if (!key)
    return {
      ok: false,
      error: `The data-plane api_key file for space ${spaceId} is empty (${file.path}) — delete and recreate the space to capture a fresh key.`,
    };
  return { ok: true, key };
}

export async function readAgentartsMemory(params = {}, options = {}) {
  const invalid = validateMemoryRead(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation || '(unknown)'} (SDK data plane)`,
      error: invalid,
    };
  }
  const keyLoad = loadMemoryApiKey(params.space_id);
  if (!keyLoad.ok) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error: keyLoad.error,
    };
  }

  // The request carries ONLY non-secret parameters. The api_key rides the
  // child env, never argv (process-list visible) and never the payload.
  const request = {
    operation: params.operation,
    space_id: params.space_id,
    region: typeof params.region === 'string' && params.region ? params.region : 'cn-southwest-2',
  };
  for (const field of ['actor_id', 'session_id', 'message_id', 'memory_id']) {
    if (typeof params[field] === 'string' && params[field]) request[field] = params[field];
  }
  for (const field of ['k', 'limit', 'offset']) {
    if (params[field] !== undefined && params[field] !== null) request[field] = Number(params[field]);
  }
  if (params.filters !== undefined && params.filters !== null) {
    const filters = { ...(params.filters || {}) };
    if (params.operation === 'search_memories') filters.actor_id = params.actor_id;
    // Drop null/undefined filter values — the SDK filter dataclasses treat
    // None as "not set", and json null would arrive as None anyway, but
    // dropping here keeps the snippet's kwargs construction honest.
    for (const key of Object.keys(filters)) {
      if (filters[key] === null || filters[key] === undefined) delete filters[key];
    }
    request.filters = filters;
  }
  const jsonArg = JSON.stringify(request);

  // Allowlist env + the data-plane key. injectCredentials stays OFF: the
  // data plane needs no AK/SK (MemoryClient's control plane is lazy and
  // none of these methods reach it) — a narrower credential surface
  // than every other agentarts tool, on purpose.
  const childEnv = { ...buildChildEnv({ injectCredentials: false }), HUAWEICLOUD_SDK_MEMORY_API_KEY: keyLoad.key };
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', MEMORY_READ_SNIPPET, jsonArg];

  return runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => shapeMemoryResult(result, candidate, params, timeoutMs),
  });
}

// Shared payload shaper for the read and write bridges (identical failure
// contract, redaction, and truncation semantics).
function shapeMemoryResult(result, candidate, params, timeoutMs) {
  // Trustworthy exit codes (see the module header): exit 0 means the
  // snippet printed result JSON — a parse failure on exit 0 is a
  // pollution detector, NOT a content scan. No failure signature runs
  // against the payload: memory CONTENT is by design a store of
  // failure experience (tracebacks, ERROR lines), so scanning it
  // guarantees false positives on successful reads.
  let parsed = null;
  if (!result.timedOut && result.exitCode === 0) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }
    // Parsed results pass the SAME redaction as the string paths — the
    // object path masks credential-shaped fields (trap 27 class).
    if (parsed !== null && parsed !== undefined) parsed = redactSecrets(parsed);
  }
  const failed = result.timedOut || result.exitCode !== 0 || parsed === null;
  const safeStdout = redactSecrets(result.stdout || '');
  // Truncation applies to successes AND failures (a long timeout can
  // accumulate a lot of output). When the side file fires, `result`
  // is dropped — the file pointer is the contract; returning an
  // untruncated parsed object next to a truncated stdout would defeat
  // the whole large-output machinery.
  const largeOutputFile = saveLargeOutput(safeStdout);
  const payloadStdout = largeOutputFile
    ? `${safeStdout.slice(0, 2000)}\n...(truncated, full output saved to ${largeOutputFile})`
    : safeStdout;
  const parsePolluted = !result.timedOut && result.exitCode === 0 && parsed === null;
  return {
    ok: !failed,
    service: 'AgentArts',
    operation: `memory ${params.operation} (SDK data plane; no CLI subcommand in 0.1.7)`,
    executable: candidate,
    exitCode: result.exitCode,
    failureDetected: failed,
    ...(largeOutputFile || failed ? {} : { result: parsed }),
    stdout: payloadStdout,
    stderr: redactSecrets(result.stderr || ''),
    ...(result.timedOut
      ? { timedOut: true, error: `agentarts memory ${params.operation} timed out after ${timeoutMs} ms.` }
      : {}),
    ...(parsePolluted
      ? {
          error:
            'exit 0 but stdout was not parseable JSON — output pollution suspected (the snippet prints clean JSON on success).',
        }
      : {}),
  };
}

// The 4 WRITE data-plane methods (U3), token-gated like every approved
// cloud write in this repo. Signatures (pinned venv client.py):
// - create_memory_session(space_id, id?, actor_id?, assistant_id?, meta?)
//   — actor_id REQUIRED at this boundary (the isolation model; a session
//   without an actor breaks actor-scoped retrieval).
// - add_messages(space_id, session_id, messages: TextMessage[], *,
//   timestamp?, idempotency_key?, is_force_extract=False) — TextMessage
//   roles are user/assistant/system ONLY (the dataclass Literal; tool
//   roles are ToolCallMessage shapes this bridge does not expose), and
//   content must be non-empty (to_dict raises on empty). ONE approval
//   covers the whole batch.
// - delete_session(space_id, session_id) — SOFT delete (90-365d async
//   cleanup per the SDK docstring): approved, not irreversible-labeled.
// - delete_memory(space_id, memory_id) — the SDK docstring says
//   "this operation is irreversible": carries the irreversible label.
export const MEMORY_WRITE_OPERATIONS = ['create_session', 'add_messages', 'delete_session', 'delete_memory'];
const MEMORY_WRITE_LABELS = {
  delete_memory: ['irreversible'],
};

// TextMessage's role Literal (config.py:904-905) — 'tool' is NOT a
// TextMessage role; the tool-call/result message shapes are separate
// dataclasses this bridge deliberately does not expose.
const TEXT_MESSAGE_ROLES = new Set(['user', 'assistant', 'system']);

function validateMemoryWrite(params) {
  if (!MEMORY_WRITE_OPERATIONS.includes(params.operation)) {
    return `operation must be one of: ${MEMORY_WRITE_OPERATIONS.join(', ')}.`;
  }
  const spaceFile = memoryApiKeyFile(params.space_id);
  if (!spaceFile.ok) return spaceFile.error;
  if (typeof params.space_id !== 'string' || params.space_id.length === 0) {
    return 'space_id is required.';
  }
  if (params.operation === 'create_session') {
    if (typeof params.actor_id !== 'string' || params.actor_id.length === 0) {
      return 'actor_id is REQUIRED for create_session: the actor is the isolation unit of the whole memory model — a session without one breaks actor-scoped retrieval.';
    }
    for (const field of ['assistant_id', 'session_id']) {
      if (
        params[field] !== undefined &&
        params[field] !== null &&
        (typeof params[field] !== 'string' || !params[field])
      ) {
        return `${field} must be a non-empty string when provided.`;
      }
    }
    if (
      params.meta !== undefined &&
      params.meta !== null &&
      (typeof params.meta !== 'object' || Array.isArray(params.meta))
    ) {
      return 'session meta must be an object.';
    }
  }
  if (params.operation === 'add_messages') {
    if (typeof params.session_id !== 'string' || params.session_id.length === 0) {
      return 'session_id is required for add_messages.';
    }
    if (!Array.isArray(params.messages) || params.messages.length === 0) {
      return 'messages must be a non-empty array (one approval covers the whole batch).';
    }
    for (const [index, message] of params.messages.entries()) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return `messages[${index}] must be an object.`;
      }
      if (!TEXT_MESSAGE_ROLES.has(message.role)) {
        return `messages[${index}].role must be one of user, assistant, system (TextMessage's Literal — tool roles are separate dataclasses this bridge does not expose).`;
      }
      if (typeof message.content !== 'string' || message.content.length === 0) {
        return `messages[${index}].content must be a non-empty string (the SDK raises on empty content).`;
      }
      for (const field of ['actor_id', 'assistant_id', 'meta']) {
        if (message[field] !== undefined && message[field] !== null && typeof message[field] !== 'string') {
          return `messages[${index}].${field} must be a string when provided.`;
        }
      }
    }
    if (params.timestamp !== undefined && params.timestamp !== null && !Number.isSafeInteger(params.timestamp)) {
      return 'timestamp must be an integer (milliseconds).';
    }
    if (
      params.idempotency_key !== undefined &&
      params.idempotency_key !== null &&
      (typeof params.idempotency_key !== 'string' || !params.idempotency_key)
    ) {
      return 'idempotency_key must be a non-empty string when provided.';
    }
    if (
      params.is_force_extract !== undefined &&
      params.is_force_extract !== null &&
      typeof params.is_force_extract !== 'boolean'
    ) {
      return 'is_force_extract must be a boolean.';
    }
  }
  if (params.operation === 'delete_session') {
    if (typeof params.session_id !== 'string' || params.session_id.length === 0) {
      return 'session_id is required for delete_session.';
    }
  }
  if (params.operation === 'delete_memory') {
    if (typeof params.memory_id !== 'string' || params.memory_id.length === 0) {
      return 'memory_id is required for delete_memory.';
    }
  }
  return null;
}

// The canonical request: plan and write build it from params the SAME way,
// so the approval token binds byte-identical JSON. It carries ONLY
// non-secret parameters (the key rides the child env, never here).
function buildMemoryWriteRequest(params) {
  const request = {
    operation: params.operation,
    space_id: params.space_id,
    region: typeof params.region === 'string' && params.region ? params.region : 'cn-southwest-2',
  };
  if (params.operation === 'create_session') {
    request.actor_id = params.actor_id;
    for (const field of ['assistant_id', 'session_id']) {
      if (typeof params[field] === 'string' && params[field]) request[field] = params[field];
    }
    if (params.meta !== undefined && params.meta !== null) request.meta = params.meta;
  }
  if (params.operation === 'add_messages') {
    request.session_id = params.session_id;
    request.messages = params.messages.map((message) => {
      const entry = { role: message.role, content: message.content };
      for (const field of ['actor_id', 'assistant_id', 'meta']) {
        if (typeof message[field] === 'string' && message[field]) entry[field] = message[field];
      }
      return entry;
    });
    if (params.timestamp !== undefined && params.timestamp !== null) request.timestamp = params.timestamp;
    if (typeof params.idempotency_key === 'string' && params.idempotency_key) {
      request.idempotency_key = params.idempotency_key;
    }
    if (params.is_force_extract === true) request.is_force_extract = true;
  }
  if (params.operation === 'delete_session') request.session_id = params.session_id;
  if (params.operation === 'delete_memory') request.memory_id = params.memory_id;
  return request;
}

// Token namespace for the memory data-plane writes — distinct from the
// agentarts CLI namespace so a CLI token can never authorize an SDK write
// (and vice versa). The request JSON carries no secrets, so hash-exact
// binding is the whole check (the CLI's scrub-tolerance fallback exists
// for argv secrets; there are none here by construction).
const MEMORY_WRITE_TOKEN_CLI = 'agentarts-memory-sdk';

export function planAgentartsMemoryWrite(params = {}) {
  const invalid = validateMemoryWrite(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation || '(unknown)'} (SDK data plane)`,
      error: invalid,
    };
  }
  const keyLoad = loadMemoryApiKey(params.space_id);
  if (!keyLoad.ok) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error: keyLoad.error,
    };
  }
  const request = buildMemoryWriteRequest(params);
  const approvalToken = createApprovalTokenStore(MEMORY_WRITE_TOKEN_CLI).create([JSON.stringify(request)]);
  return {
    ok: true,
    service: 'AgentArts',
    tier: 'approved',
    operation: `memory ${params.operation} (SDK data plane; no CLI subcommand in 0.1.7)`,
    labels: MEMORY_WRITE_LABELS[params.operation] ?? [],
    request,
    approvalToken,
    approvalNote:
      'Present the request above to the user. On explicit approval, run huaweicloud_agentarts_memory_write with THIS approvalToken and the SAME parameters (the token binds them exactly); otherwise discard it. One approval covers the whole add_messages batch.',
  };
}

const MEMORY_WRITE_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk.memory.client import MemoryClient',
  '    from agentarts.sdk.memory.inner.config import TextMessage',
  '    params = json.loads(sys.argv[1])',
  '    client = MemoryClient(region_name=params["region"])',
  '    op = params["operation"]',
  '    space = params["space_id"]',
  '    if op == "create_session":',
  '        kwargs = {"actor_id": params["actor_id"]}',
  '        if params.get("assistant_id"): kwargs["assistant_id"] = params["assistant_id"]',
  '        if params.get("session_id"): kwargs["id"] = params["session_id"]',
  '        if params.get("meta"): kwargs["meta"] = params["meta"]',
  '        result = client.create_memory_session(space, **kwargs)',
  '    elif op == "add_messages":',
  '        messages = [TextMessage(role=m["role"], content=m["content"], actor_id=m.get("actor_id"), assistant_id=m.get("assistant_id"), meta=m.get("meta")) for m in params["messages"]]',
  '        kwargs = {}',
  '        if params.get("timestamp") is not None: kwargs["timestamp"] = params["timestamp"]',
  '        if params.get("idempotency_key"): kwargs["idempotency_key"] = params["idempotency_key"]',
  '        if params.get("is_force_extract") is not None: kwargs["is_force_extract"] = params["is_force_extract"]',
  '        result = client.add_messages(space, params["session_id"], messages, **kwargs)',
  '    elif op == "delete_session":',
  '        client.delete_session(space, params["session_id"])',
  '        result = {"deleted": True, "session_id": params["session_id"]}',
  '    elif op == "delete_memory":',
  '        client.delete_memory(space, params["memory_id"])',
  '        result = {"deleted": True, "memory_id": params["memory_id"]}',
  '    else:',
  '        print("AGENTARTS_MEMORY_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'except Exception as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

export async function runAgentartsMemoryWrite({ approvalToken, ...params } = {}, options = {}) {
  const invalid = validateMemoryWrite(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation || '(unknown)'} (SDK data plane)`,
      error: invalid,
    };
  }
  if (typeof approvalToken !== 'string' || !approvalToken) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error:
        'approvalToken is required — run huaweicloud_agentarts_memory_plan first, present the request to the user, and pass the token plus the SAME parameters here on explicit approval.',
    };
  }
  const store = createApprovalTokenStore(MEMORY_WRITE_TOKEN_CLI);
  const inspection = store.inspect(approvalToken);
  if (inspection.state !== 'valid') {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error: `approvalToken is ${inspection.state} — re-plan with huaweicloud_agentarts_memory_plan and get a fresh approval.`,
    };
  }
  const request = buildMemoryWriteRequest(params);
  const requestHash = hashNamespacedArgs(MEMORY_WRITE_TOKEN_CLI, [JSON.stringify(request)]);
  if (requestHash !== inspection.entry.argsHash) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error:
        'approvalToken was minted for DIFFERENT parameters — the write binds the exact planned request. Re-plan with the changed parameters (the token stays valid for the original ones).',
    };
  }
  // Binding verified — consume (single-use tombstone) before executing.
  if (!store.consume(approvalToken)) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error: 'approvalToken could not be consumed (concurrent use?) — re-plan.',
    };
  }
  const keyLoad = loadMemoryApiKey(params.space_id);
  if (!keyLoad.ok) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error: keyLoad.error,
    };
  }
  const childEnv = { ...buildChildEnv({ injectCredentials: false }), HUAWEICLOUD_SDK_MEMORY_API_KEY: keyLoad.key };
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVED_TIMEOUT_MS;
  const args = ['-c', MEMORY_WRITE_SNIPPET, JSON.stringify(request)];
  return runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => shapeMemoryResult(result, candidate, params, timeoutMs),
  });
}

// Tool surface: definitions exported so tools.mjs stays a thin
// registration site (the agentarts-cli pattern — dispatch lives in
// callAgentartsMemoryTool, definitions carry no handlers).
export const AGENTARTS_MEMORY_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_memory_read',
    description:
      "Read the AgentArts memory DATA plane (SDK MemoryClient — the 0.1.7 CLI has NO data-plane subcommands): sessions, messages, and memories of an existing memory space. The one-time data-plane api_key is read from the wrapper-captured 0600 key file (spaces created through the memory create tool); it never enters argv, tool arguments, or output. actor_id is REQUIRED for search_memories — server-side isolation is actor-level only, and an unscoped search silently spans every actor in the space; list_memories without filters.actor_id lists ALL actors' memories (an ops/debug stance). list_messages requires session_id (the SDK's space-wide form builds a broken /sessions/None path in 0.1.7). Pagination is 0-based; sessions limit 1-20, messages/memories limit 1-100. Region defaults to cn-southwest-2 (the only e2e-measured region). Read-only: no approval needed.",
    inputSchema: {
      type: 'object',
      required: ['operation', 'space_id'],
      properties: {
        operation: {
          type: 'string',
          enum: MEMORY_READ_OPERATIONS,
          description:
            'The read operation. Required params: get_session/get_last_k_messages/list_messages → session_id; get_message → message_id + session_id; get_memory → memory_id; search_memories → actor_id + filters.query.',
        },
        space_id: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]+$',
          description: 'Memory space ID (the create tool captured its key file).',
        },
        actor_id: {
          type: 'string',
          description:
            'Actor whose perspective filters the query. REQUIRED for search_memories (actor-level server isolation); optional filter for list_sessions/list_memories.',
        },
        session_id: { type: 'string' },
        message_id: { type: 'string' },
        memory_id: { type: 'string' },
        k: { type: 'integer', minimum: 1, description: 'get_last_k_messages: how many trailing messages.' },
        limit: {
          type: 'integer',
          description: 'Page size: sessions 1-20 (default 20), messages/memories 1-100 (default 10).',
        },
        offset: { type: 'integer', minimum: 0, description: '0-based pagination offset.' },
        region: { type: 'string', description: 'Defaults to cn-southwest-2.' },
        filters: {
          type: 'object',
          description:
            'search_memories: MemorySearchFilter fields (query REQUIRED, plus strategy_type/strategy_id/assistant_id/session_id/memory_type/start_time/end_time/top_k/min_score — actor_id goes in the top-level param). list_memories: MemoryListFilter fields (strategy_type/strategy_id/actor_id/assistant_id/session_id/start_time/end_time — sort_by/sort_order exist on the SDK dataclass but 0.1.7 never sends them; rejected here). Unknown keys are rejected.',
        },
      },
    },
  },
];

// Write-bridge tool definitions (token-gated like every approved cloud
// write in this repo).
export const AGENTARTS_MEMORY_WRITE_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_memory_plan',
    description:
      'Plan an AgentArts memory DATA-PLANE WRITE (SDK MemoryClient — the 0.1.7 CLI has no data-plane subcommands): create_session, add_messages (a whole batch per approval), delete_session (soft delete), delete_memory (irreversible). Validates the request, reads nothing from the cloud, and returns the exact request plus an approvalToken. Present the request to the user; on explicit approval run huaweicloud_agentarts_memory_write with the token and the SAME parameters. The token binds the exact planned request — changed parameters need a fresh plan. The one-time data-plane api_key rides the wrapper-captured 0600 key file (env-only). actor_id is REQUIRED for create_session (the actor is the isolation unit). TextMessage roles: user/assistant/system only.',
    inputSchema: {
      type: 'object',
      required: ['operation', 'space_id'],
      properties: {
        operation: { type: 'string', enum: MEMORY_WRITE_OPERATIONS },
        space_id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
        actor_id: { type: 'string', description: 'REQUIRED for create_session.' },
        session_id: {
          type: 'string',
          description: 'Required for add_messages/delete_session; optional custom id for create_session.',
        },
        assistant_id: { type: 'string', description: 'create_session/add_messages optional.' },
        meta: { type: 'object', description: 'create_session: session metadata object.' },
        messages: {
          type: 'array',
          description:
            'add_messages: non-empty array of {role: user|assistant|system, content: non-empty string, actor_id?, assistant_id?, meta? (strings)}. One approval covers the whole batch.',
          items: { type: 'object' },
        },
        timestamp: { type: 'integer', description: 'add_messages: message time in ms.' },
        idempotency_key: { type: 'string', description: 'add_messages: duplicate-submission guard.' },
        is_force_extract: {
          type: 'boolean',
          description:
            'add_messages: force memory extraction (default false — extraction is async; a write is not immediately retrievable).',
        },
        memory_id: { type: 'string', description: 'delete_memory.' },
        region: { type: 'string', description: 'Defaults to cn-southwest-2.' },
      },
    },
  },
  {
    name: 'huaweicloud_agentarts_memory_write',
    description:
      'Execute a PLANNED and USER-APPROVED AgentArts memory data-plane write. Requires the approvalToken from huaweicloud_agentarts_memory_plan plus the EXACT same parameters (the token binds them; a mismatch rejects without consuming the token). Single-use: the token is consumed on execution. delete_memory is irreversible; delete_session is a soft delete; add_messages extraction is asynchronous (not immediately searchable — use is_force_extract consciously).',
    inputSchema: {
      type: 'object',
      required: ['approvalToken', 'operation', 'space_id'],
      properties: {
        approvalToken: { type: 'string' },
        operation: { type: 'string', enum: MEMORY_WRITE_OPERATIONS },
        space_id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
        actor_id: { type: 'string' },
        session_id: { type: 'string' },
        assistant_id: { type: 'string' },
        meta: { type: 'object' },
        messages: { type: 'array', items: { type: 'object' } },
        timestamp: { type: 'integer' },
        idempotency_key: { type: 'string' },
        is_force_extract: { type: 'boolean' },
        memory_id: { type: 'string' },
        region: { type: 'string' },
      },
    },
  },
];

export async function callAgentartsMemoryTool(name, rawArgs = {}) {
  if (name === 'huaweicloud_agentarts_memory_read') return readAgentartsMemory(rawArgs);
  if (name === 'huaweicloud_agentarts_memory_plan') return planAgentartsMemoryWrite(rawArgs);
  if (name === 'huaweicloud_agentarts_memory_write') return runAgentartsMemoryWrite(rawArgs);
  return { ok: false, error: `Unknown agentarts memory tool: ${name}` };
}
