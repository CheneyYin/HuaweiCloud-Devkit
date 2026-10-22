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

import { readFileSync } from 'node:fs';

import {
  buildChildEnv,
  detectFailure,
  memoryApiKeyFile,
  pinnedSdkVersion,
  pythonCandidatesForAgentarts,
  READONLY_TIMEOUT_MS,
  runPythonSnippet,
  saveLargeOutput,
} from './agentarts-cli.mjs';
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
  if (params.operation === 'get_session' || params.operation === 'get_last_k_messages') {
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
    if (typeof params.filters !== 'object' || Array.isArray(params.filters)) {
      return 'filters must be an object (MemorySearchFilter / MemoryListFilter fields).';
    }
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
  // none of these 8 methods reach it) — a narrower credential surface
  // than every other agentarts tool, on purpose.
  const childEnv = { ...buildChildEnv({ injectCredentials: false }), HUAWEICLOUD_SDK_MEMORY_API_KEY: keyLoad.key };
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', MEMORY_READ_SNIPPET, jsonArg];
  const runCandidate = options.runCandidate || ((candidate) => runPythonSnippet(candidate, args, childEnv, timeoutMs));

  for (const candidate of pythonCandidatesForAgentarts()) {
    const result = await runCandidate(candidate, args, childEnv);
    const moduleMissing =
      result.exitCode === 3 || /ModuleNotFoundError|AGENTARTS_SDK_MISSING/.test(result.stderr || '');
    // Only "this python cannot run the SDK" advances the chain (the
    // list_agents contract): a candidate that found the SDK and failed
    // (auth, network, API error) is FINAL.
    if (result.spawnError || moduleMissing) continue;
    const failed = result.timedOut || result.exitCode !== 0 || detectFailure(result.stdout || '', result.stderr || '');
    let parsed = null;
    if (!failed) {
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = null;
      }
      // Parsed results pass the SAME redaction as the string paths — the
      // object path masks credential-shaped fields (trap 27 class).
      if (parsed !== null && parsed !== undefined) parsed = redactSecrets(parsed);
    }
    const safeStdout = redactSecrets(result.stdout || '');
    const largeOutputFile = failed ? null : saveLargeOutput(safeStdout);
    const payloadStdout = largeOutputFile
      ? `${safeStdout.slice(0, 2000)}\n...(truncated, full output saved to ${largeOutputFile})`
      : safeStdout;
    return {
      ok: !failed,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane; no CLI subcommand in 0.1.7)`,
      executable: candidate,
      exitCode: result.exitCode,
      failureDetected: failed,
      result: parsed,
      stdout: payloadStdout,
      stderr: redactSecrets(result.stderr || ''),
      ...(result.timedOut
        ? { timedOut: true, error: `agentarts memory ${params.operation} timed out after ${timeoutMs} ms.` }
        : {}),
    };
  }
  return {
    ok: false,
    error: `No python candidate could import agentarts (tried: ${pythonCandidatesForAgentarts().join(', ')}). Install the SDK: npx huaweicloud-devkit install-agentarts (or pip install agentarts-sdk==${pinnedSdkVersion() || 'the pinned version'} -i https://mirrors.huaweicloud.com/repository/pypi/simple).`,
  };
}

// Tool surface: definitions and the dispatch handler exported so tools.mjs
// stays a thin registration site (the agentarts-cli pattern).
export const AGENTARTS_MEMORY_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_memory_read',
    description:
      "Read the AgentArts memory DATA plane (SDK MemoryClient — the 0.1.7 CLI has NO data-plane subcommands): sessions, messages, and memories of an existing memory space. The one-time data-plane api_key is read from the wrapper-captured 0600 key file (spaces created through the memory create tool); it never enters argv, tool arguments, or output. actor_id is REQUIRED for search_memories — server-side isolation is actor-level only, and an unscoped search silently spans every actor in the space; list_memories without filters.actor_id lists ALL actors' memories (an ops/debug stance). Pagination is 0-based; sessions limit 1-20, messages/memories limit 1-100. Region defaults to cn-southwest-2 (the only e2e-measured region). Read-only: no approval needed.",
    inputSchema: {
      type: 'object',
      required: ['operation', 'space_id'],
      properties: {
        operation: {
          type: 'string',
          enum: MEMORY_READ_OPERATIONS,
          description:
            'The read operation. Required params: get_session/get_last_k_messages → session_id; get_message → message_id + session_id; get_memory → memory_id; search_memories → actor_id + filters.query.',
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
            'search_memories: MemorySearchFilter fields (query REQUIRED, plus strategy_type/strategy_id/assistant_id/session_id/memory_type/start_time/end_time/top_k/min_score). list_memories: MemoryListFilter fields (strategy_type/strategy_id/actor_id/assistant_id/session_id/start_time/end_time/sort_by/sort_order).',
        },
      },
    },
    handler: async (args) => readAgentartsMemory(args || {}),
  },
];

export async function callAgentartsMemoryTool(name, rawArgs = {}) {
  if (name !== 'huaweicloud_agentarts_memory_read') {
    return { ok: false, error: `Unknown agentarts memory tool: ${name}` };
  }
  return readAgentartsMemory(rawArgs);
}
