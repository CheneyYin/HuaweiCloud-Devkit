// AgentArts code interpreter CONTROL-PLANE read bridge (CI2). The 0.1.7
// CLI has zero code-interpreter subcommands (43-fixture tree grep —
// findings trap 81 context), so the SDK CodeInterpreter class is the only
// path. This module mirrors the browser read bridge
// (agentarts-browser.mjs): inline python snippet over the CLI-owned
// interpreter, our own exit codes, allowlist child env, redaction on
// every surface, boundary validation with no coercion.
//
// Credential model: the control plane authenticates with the injected
// AK/SK (SDK-HMAC-SHA256, the list_agents posture) — injectCredentials
// stays ON. These reads never touch the data plane: no data endpoint, no
// interpreter api_key.
//
// Request transport: STDIN, not argv (the repo-wide rule since the
// memory bridge's round 2 — argv is process-list visible and long name
// filters would hit the kernel per-argument limit).
//
// Failure contract: the snippet's exit codes are OURS (0 = JSON printed,
// 1 = failure, 3 = module missing) and the exception handler catches
// BaseException, NOT Exception — the SDK's ToolsAPIError extends
// BaseException (tools_http.py:10), so an `except Exception` bridge leaks
// the error past the handler and kills the child with an uncaught
// traceback (the browser bridge's single deviation, inherited here).

import {
  buildChildEnv,
  DEFAULT_APPROVED_TIMEOUT_MS,
  hasInjectableCredentials,
  READONLY_TIMEOUT_MS,
  runOverPythonCandidates,
  saveLargeOutput,
} from './agentarts-cli.mjs';
import { INTERPRETER_READ_OPERATIONS, INTERPRETER_WRITE_OPERATIONS } from './agentarts-interpreter-tools.mjs';
import { createApprovalTokenStore, hashNamespacedArgs } from './approval-tokens.mjs';
import { CREDENTIAL_KEY_TOKENS, redactCredentialShapes } from './redact-core.mjs';
import { redactSecrets } from './safety-policy.mjs';

const INTERPRETER_READ_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk import CodeInterpreter',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    params = json.loads(sys.stdin.read())',
  '    client = CodeInterpreter(region=params["region"], auth_type="IAM")',
  '    op = params["operation"]',
  '    if op == "list_code_interpreters":',
  '        kwargs = {}',
  '        if params.get("name"): kwargs["name"] = params["name"]',
  '        if params.get("limit") is not None: kwargs["limit"] = params["limit"]',
  '        if params.get("offset") is not None: kwargs["offset"] = params["offset"]',
  '        if params.get("sort_key"): kwargs["sort_key"] = params["sort_key"]',
  '        if params.get("sort_dir"): kwargs["sort_dir"] = params["sort_dir"]',
  '        result = client.list_code_interpreters(**kwargs)',
  '    elif op == "get_code_interpreter":',
  '        result = client.get_code_interpreter(params["code_interpreter_id"])',
  '    else:',
  '        print("AGENTARTS_INTERPRETER_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  // SystemExit must propagate (the browser bridge's R1 rule): the
  // bad-operation sys.exit(2) inside the try raises SystemExit, which
  // extends BaseException — an unqualified handler would convert our own
  // exit-2 contract into "SystemExit: 2" on stderr with exit 1.
  'except SystemExit:',
  '    raise',
  // ToolsAPIError extends BaseException (tools_http.py:10) — an
  // `except Exception` handler cannot catch it and the child dies with
  // an uncaught traceback instead of our exit-1 contract.
  'except BaseException as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Legal top-level parameter keys — a typo'd field must not vanish
// silently (the silent-no-op class). Tag filters exist on the SDK list
// method but are deliberately NOT exposed: they stay
// unknown-param-rejected until a measured need.
const INTERPRETER_READ_PARAM_KEYS = [
  'operation',
  'code_interpreter_id',
  'name',
  'limit',
  'offset',
  'sort_key',
  'sort_dir',
  'region',
];

// Per-operation applicability: a legal key in the wrong operation is a
// silent no-op otherwise. Both operations take operation/region; the map
// lists the rest.
const READ_OP_APPLICABILITY = {
  list_code_interpreters: ['name', 'limit', 'offset', 'sort_key', 'sort_dir'],
  get_code_interpreter: ['code_interpreter_id'],
};

function rejectUnknownParams(params, operation) {
  const applicable = READ_OP_APPLICABILITY[operation] ?? [];
  for (const key of Object.keys(params)) {
    if (!INTERPRETER_READ_PARAM_KEYS.includes(key)) {
      return `Unknown parameter "${redactSecrets(key)}" — legal keys: ${INTERPRETER_READ_PARAM_KEYS.join(', ')}.`;
    }
    if (!['operation', 'region'].includes(key) && !applicable.includes(key)) {
      return `"${redactSecrets(key)}" is not a parameter of ${operation} — it would be silently ignored. Applicable keys for ${operation}: ${applicable.join(', ') || '(none beyond operation/region)'}.`;
    }
  }
  return null;
}

// Boundary validation (the tool's front door — the snippet trusts what
// arrives). Strict typing throughout: mistyped values are rejected,
// never coerced (the family-wide interrogate policy). The SDK's own
// client-side validators are enforced at THIS boundary so a deterministic
// child failure cannot waste a spawn: sort_key is created_at|updated_at
// and the list name filter is 2-40 chars (code_interpreter_client.py
// list validation). UUID ids and the region charset are BRIDGE gates,
// not SDK rules: the CI SDK performs no client-side id validation (the
// server answers not-found for a malformed id, CI1-R1 measured) and the
// region steers the hostname of the AK/SK-signed request, so a
// non-region-shaped string must never ride it.
const INTERPRETER_SORT_KEYS = ['created_at', 'updated_at'];
const INTERPRETER_NAME_FILTER_RANGE = [2, 40];
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const REGION_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

// The SDK applies no limit/offset cap on the list call, so the bridge
// holds the conservative 1-100 window (the family posture).
const INTERPRETER_LIMIT_RANGE = [1, 100];

function validateInterpreterRead(params) {
  if (!INTERPRETER_READ_OPERATIONS.includes(params.operation)) {
    return `operation must be one of: ${INTERPRETER_READ_OPERATIONS.join(', ')}.`;
  }
  const unknown = rejectUnknownParams(params, params.operation);
  if (unknown) return unknown;
  if (params.operation === 'get_code_interpreter') {
    if (typeof params.code_interpreter_id !== 'string' || params.code_interpreter_id.length === 0) {
      return 'code_interpreter_id is required for get_code_interpreter.';
    }
    if (!UUID_PATTERN.test(params.code_interpreter_id)) {
      return 'code_interpreter_id must be a valid UUID (a bridge-side gate — the CI SDK performs no client-side id validation and the server answers not-found for a malformed id; pass the id exactly as list_code_interpreters returned it).';
    }
  }
  for (const field of ['name', 'sort_key']) {
    if (params[field] !== undefined && params[field] !== null) {
      if (typeof params[field] !== 'string' || params[field].length === 0) {
        return `${field} must be a non-empty string when provided — mistyped values are rejected, not coerced.`;
      }
    }
  }
  if (params.name !== undefined && params.name !== null) {
    if (
      params.name.length < INTERPRETER_NAME_FILTER_RANGE[0] ||
      params.name.length > INTERPRETER_NAME_FILTER_RANGE[1]
    ) {
      return `name must be ${INTERPRETER_NAME_FILTER_RANGE[0]}-${INTERPRETER_NAME_FILTER_RANGE[1]} characters (the SDK's own client-side filter rule).`;
    }
  }
  if (params.sort_key !== undefined && params.sort_key !== null && !INTERPRETER_SORT_KEYS.includes(params.sort_key)) {
    return `sort_key must be one of: ${INTERPRETER_SORT_KEYS.join(', ')} (the SDK's own client-side rule).`;
  }
  if (params.sort_dir !== undefined && params.sort_dir !== null && !['asc', 'desc'].includes(params.sort_dir)) {
    return 'sort_dir must be "asc" or "desc".';
  }
  for (const field of ['limit', 'offset']) {
    if (params[field] !== undefined && params[field] !== null) {
      const value = params[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)) {
        return `${field} must be an integer (got ${typeof value}) — mistyped values are rejected, not coerced.`;
      }
      if (field === 'limit' && (value < INTERPRETER_LIMIT_RANGE[0] || value > INTERPRETER_LIMIT_RANGE[1])) {
        return `limit must be ${INTERPRETER_LIMIT_RANGE[0]}-${INTERPRETER_LIMIT_RANGE[1]} (conservative bridge window; SDK applies no cap).`;
      }
      if (field === 'offset' && value < 0) return 'offset must be >= 0 (0-based).';
    }
  }
  // region: a mistyped region silently became the cn-southwest-2 default
  // in the memory bridge once — rejected at the boundary here too. The
  // charset gate is the CI2-R1 review's steering fix: the region
  // interpolates into the hostname of the AK/SK-signed control-plane
  // request (https://agentarts.<region>.myhuaweicloud.com), and a
  // non-region-shaped string would aim the signed request at a host of
  // the caller's choosing. Region ids are lowercase alnum+hyphen.
  if (params.region !== undefined && params.region !== null) {
    if (typeof params.region !== 'string' || params.region.length === 0) {
      return 'region must be a non-empty string when provided.';
    }
    if (!REGION_ID_PATTERN.test(params.region)) {
      return 'region must match ^[a-z0-9-]{1,64}$ — it steers the hostname of the AK/SK-signed request, so free-text regions are rejected (use a region id like cn-southwest-2).';
    }
  }
  return null;
}

// Parse the snippet's stdout into a redacted object, or null (exit 0
// with unparseable stdout is output pollution — the envelope's detector).
function parseSnippetStdout(result) {
  if (result.timedOut || result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed === null || parsed === undefined ? null : redactSecrets(parsed);
  } catch {
    return null;
  }
}

// Shared payload ENVELOPE, the family shape verbatim (parse, redact,
// fail, truncate, assemble — no operation-specific enrichment).
function shapeInterpreterResult(result, candidate, params, timeoutMs, parsed = parseSnippetStdout(result)) {
  const failed = result.timedOut || result.exitCode !== 0 || parsed === null;
  const safeStdout = redactSecrets(result.stdout || '');
  const largeOutputFile = saveLargeOutput(safeStdout);
  const payloadStdout = largeOutputFile
    ? `${safeStdout.slice(0, 2000)}\n...(truncated, full output saved to ${largeOutputFile})`
    : safeStdout;
  const parsePolluted = !result.timedOut && result.exitCode === 0 && parsed === null;
  return {
    ok: !failed,
    service: 'AgentArts',
    operation: `interpreter ${params.operation} (SDK control plane; no CLI subcommand in 0.1.7)`,
    executable: candidate,
    exitCode: result.exitCode,
    failureDetected: failed,
    ...(largeOutputFile || failed ? {} : { result: parsed }),
    stdout: payloadStdout,
    stderr: redactSecrets(result.stderr || ''),
    ...(result.timedOut
      ? { timedOut: true, error: `agentarts interpreter ${params.operation} timed out after ${timeoutMs} ms.` }
      : {}),
    ...(parsePolluted
      ? {
          error:
            'exit 0 but stdout was not parseable JSON — output pollution suspected (the snippet prints clean JSON on success).',
        }
      : {}),
    // An ok:false payload ALWAYS carries an error — a plain exit-1
    // failure previously carried none, and every downstream
    // `${payload.error}` mapping then prefixed its guidance with the
    // literal "undefined" (the browser bridge's R10 rule).
    ...(failed && !result.timedOut && !parsePolluted
      ? { error: 'Execution failed (see stderr for the SDK error).' }
      : {}),
  };
}

// Read-bridge post-processing. Two load-bearing advisories: an
// API_KEY-typed interpreter cannot be driven by this toolkit's default
// posture (the console key is the only route — trap 81), and list items
// NEVER carry auth_type (trap 89) so a non-empty list teaches the get
// step before the agent picks a resource to drive.
function enrichInterpreterRead(payload, params, parsed) {
  if (!payload.ok) return payload; // advisories describe RESULTS — a failed call has none
  const notes = [];
  const authType =
    parsed && typeof parsed === 'object' && typeof parsed.auth_type === 'string' ? parsed.auth_type : null;
  if (params.operation === 'get_code_interpreter' && authType === 'API_KEY') {
    notes.push(
      'API_KEY-typed interpreter: the data plane needs the console api_key (HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY env) — the response is not known to return the key value (browser family measured this for browsers, trap 61; CI-side unmeasured). Prefer an IAM-typed interpreter (or create one through the interpreter create tool), which signs the data plane with the same AK/SK this toolkit injects.',
    );
  }
  if (params.operation === 'list_code_interpreters' && Array.isArray(parsed?.items) && parsed.items.length > 0) {
    notes.push(
      'list items carry NO auth_type (measured, trap 89) — get_code_interpreter is the only read that proves the auth posture. Get an interpreter by id before driving a resource you did not create through this toolkit.',
    );
  }
  if (notes.length > 0) payload.notes = notes;
  return payload;
}

// Operation label for rejection payloads. The echoed operation is
// CALLER-CONTROLLED text (validation failed, so nothing about it is
// trusted): a secret pasted into it must not ride the reject response
// verbatim (the CI2-R1 review's echo finding — the CLI wrapper's reject()
// redacts its args for exactly this reason, agentarts-cli.mjs).
function operationLabel(operation) {
  const raw = typeof operation === 'string' && operation ? operation : '(unknown)';
  const safe = redactSecrets(raw);
  return `interpreter ${safe} (SDK control plane)`;
}

export async function readAgentartsInterpreter(params = {}, options = {}) {
  const invalid = validateInterpreterRead(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error: invalid,
    };
  }
  // Credential pre-gate: without injectable AK/SK the child falls through
  // the profile/metadata chain — the SDK's metadata provider
  // (http://169.254.169.254) is a live third link on runtime hosts, so an
  // unmanaged ambient identity can silently authenticate the read (the
  // browser bridge's R1 unanimous finding; list_agents gates the same
  // way).
  if (hasInjectableCredentials() === false) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `interpreter ${params.operation} (SDK control plane)`,
      error:
        'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files or the metadata chain.',
    };
  }

  // The request carries ONLY non-secret parameters; AK/SK ride the child
  // env (injectCredentials on — the control plane is AK/SK-signed, the
  // list_agents posture).
  const request = {
    operation: params.operation,
    region: typeof params.region === 'string' && params.region ? params.region : 'cn-southwest-2',
  };
  for (const field of ['code_interpreter_id', 'name', 'sort_key', 'sort_dir']) {
    if (typeof params[field] === 'string' && params[field]) request[field] = params[field];
  }
  for (const field of ['limit', 'offset']) {
    if (params[field] !== undefined && params[field] !== null) request[field] = params[field];
  }
  const jsonArg = JSON.stringify(request);

  const childEnv = buildChildEnv({ injectCredentials: true });
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', INTERPRETER_READ_SNIPPET];

  return runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: jsonArg,
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      return enrichInterpreterRead(
        shapeInterpreterResult(result, candidate, params, timeoutMs, parsed),
        params,
        parsed,
      );
    },
  });
}

// Tool dispatch (definitions live in agentarts-interpreter-tools.mjs).
export async function callAgentartsInterpreterTool(name, rawArgs = {}) {
  if (name === 'huaweicloud_agentarts_interpreter_read') return readAgentartsInterpreter(rawArgs);
  if (name === 'huaweicloud_agentarts_interpreter_plan') return planAgentartsInterpreterWrite(rawArgs);
  if (name === 'huaweicloud_agentarts_interpreter_write') return runAgentartsInterpreterWrite(rawArgs);
  return { ok: false, error: `Unknown agentarts interpreter tool: ${redactSecrets(String(name))}` };
}

// ---------------------------------------------------------------------------
// WRITE bridge (CI3): interpreter resource lifecycle, token-gated like
// every approved cloud write in this repo. The canonical request carries
// ONLY non-secret parameters (name, ids, tags, region); AK/SK ride the
// child env exactly as the read bridge does.
//
// Plan-time credential-shape warning over description and tag values
// (the browser bridge's loud-storage pattern, interpreter-worded): the
// tag {key, value} JSON shape defeats the at-rest redactor's key[:=]
// adjacency, so a secret-shaped value riding tags lands UNMASKED in
// approvals.json (0600, 5-minute TTL). The warning is the only surface
// that flags it.

// Per-operation WRITE metadata (the family registry pattern): labels on
// the plan/approval surface, replay guidance per op. A new write
// operation without an entry fails LOUDLY here — key parity with
// INTERPRETER_WRITE_OPERATIONS is pinned in structure.test.mjs.
const WRITE_OPERATION_META = {
  create_code_interpreter: { labels: [] },
  update_code_interpreter: { labels: [] },
  delete_code_interpreter: { labels: ['irreversible'] },
};

const INTERPRETER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const API_KEY_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// Bare-token prefixes for the plan-time loud-storage warning: Huawei AKs
// (AKLT...), GitHub (ghp_/gho_), OpenAI-style (sk-), Slack (xox),
// Anthropic (sk-ant-), and URL-with-credentials shapes. Detection only —
// nothing here redacts; the warning text carries the decision to the user.
const BARE_TOKEN_PREFIX =
  /\b(?:AKLT[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9-]{16,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@)/;

const INTERPRETER_WRITE_PARAM_KEYS = [
  'operation',
  'name',
  'auth_type',
  'api_key_name',
  'description',
  'code_interpreter_id',
  'tags',
  'region',
];

const INTERPRETER_WRITE_OP_APPLICABILITY = {
  create_code_interpreter: ['name', 'auth_type', 'api_key_name', 'description', 'tags'],
  update_code_interpreter: ['code_interpreter_id', 'tags'],
  delete_code_interpreter: ['code_interpreter_id'],
};

function rejectUnknownWriteParams(params, operation) {
  const applicable = INTERPRETER_WRITE_OP_APPLICABILITY[operation] ?? [];
  for (const key of Object.keys(params)) {
    if (!INTERPRETER_WRITE_PARAM_KEYS.includes(key)) {
      return `Unknown parameter "${redactSecrets(key)}" — legal keys: ${INTERPRETER_WRITE_PARAM_KEYS.join(', ')}.`;
    }
    if (!['operation', 'region'].includes(key) && !applicable.includes(key)) {
      return `"${redactSecrets(key)}" is not a parameter of ${operation} — it would be silently ignored. Applicable keys for ${operation}: ${applicable.join(', ') || '(none beyond operation/region)'}.`;
    }
  }
  return null;
}

// Tags: max 20, unique keys, {key, value} string pairs (the SDK's own
// create-side rules). A malformed tag must fail at THIS boundary, not as
// a server 400 after the token is minted (or burned).
function validateTags(tags) {
  if (tags.length > 20) return 'tags must contain at most 20 items.';
  const seen = new Set();
  for (const [index, tag] of tags.entries()) {
    if (!tag || typeof tag !== 'object' || Array.isArray(tag)) {
      return `tags[${index}] must be an object {key, value}.`;
    }
    const keys = Object.keys(tag);
    if (keys.length !== 2 || !keys.includes('key') || !keys.includes('value')) {
      return `tags[${index}] must have exactly the keys "key" and "value" — got {${keys.join(', ')}}.`;
    }
    if (
      typeof tag.key !== 'string' ||
      tag.key.length === 0 ||
      typeof tag.value !== 'string' ||
      tag.value.length === 0
    ) {
      return `tags[${index}].key and .value must be non-empty strings.`;
    }
    if (seen.has(tag.key)) return `tags[${index}] duplicates key "${tag.key}" — tag keys must be unique.`;
    seen.add(tag.key);
  }
  return null;
}

function validateInterpreterWrite(params) {
  if (!INTERPRETER_WRITE_OPERATIONS.includes(params.operation)) {
    return `operation must be one of: ${INTERPRETER_WRITE_OPERATIONS.join(', ')}.`;
  }
  const unknown = rejectUnknownWriteParams(params, params.operation);
  if (unknown) return unknown;
  const need = (field, message) => {
    if (typeof params[field] !== 'string' || params[field].length === 0) return message;
    return null;
  };
  if (params.operation === 'create_code_interpreter') {
    const err = need(
      'name',
      'name is required for create_code_interpreter (pattern ^[a-z][a-z0-9-]{0,38}[a-z0-9]$, 2-40 chars).',
    );
    if (err) return err;
    if (!INTERPRETER_NAME_PATTERN.test(params.name)) {
      return 'name must match ^[a-z][a-z0-9-]{0,38}[a-z0-9]$ — 2-40 chars, lowercase letters/digits/hyphens, start lowercase letter, end lowercase letter or digit.';
    }
    if (params.description !== undefined && params.description !== null) {
      if (typeof params.description !== 'string' || params.description.length === 0) {
        return 'description must be a non-empty string when provided.';
      }
    }
    if (params.auth_type !== undefined && params.auth_type !== null && !['IAM', 'API_KEY'].includes(params.auth_type)) {
      return 'auth_type must be "IAM" or "API_KEY".';
    }
    const effectiveAuth = params.auth_type || 'IAM';
    if (effectiveAuth === 'API_KEY') {
      const err = need(
        'api_key_name',
        'api_key_name is required when auth_type=API_KEY (the SDK rejects the create without it).',
      );
      if (err) return err;
    }
    if (params.api_key_name !== undefined && params.api_key_name !== null) {
      if (effectiveAuth === 'IAM') {
        return 'api_key_name only applies to auth_type=API_KEY — with IAM the data plane signs with AK/SK and no key is ever issued (passing a name would name a key nothing uses).';
      }
      if (typeof params.api_key_name !== 'string' || !API_KEY_NAME_PATTERN.test(params.api_key_name)) {
        return 'api_key_name must match ^[a-zA-Z0-9_-]{1,64}$.';
      }
    }
  }
  if (params.operation === 'update_code_interpreter') {
    const err = need('code_interpreter_id', 'code_interpreter_id is required for update_code_interpreter.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.code_interpreter_id)) {
      return 'code_interpreter_id must be a valid UUID (a bridge-side gate — pass the id exactly as list_code_interpreters returned it).';
    }
    if (!Array.isArray(params.tags) || params.tags.length === 0) {
      return 'update_code_interpreter requires a non-empty tags array — tags are the only updatable field this bridge exposes (the SDK also updates observability, an opaque dict not exposed here). An update with nothing to update is rejected.';
    }
  }
  if (params.operation === 'delete_code_interpreter') {
    const err = need('code_interpreter_id', 'code_interpreter_id is required for delete_code_interpreter.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.code_interpreter_id)) {
      return 'code_interpreter_id must be a valid UUID (a bridge-side gate — pass the id exactly as list_code_interpreters returned it).';
    }
  }
  if (params.tags !== undefined && params.tags !== null) {
    if (!Array.isArray(params.tags)) return 'tags must be an array of {key, value} objects.';
    const tagError = validateTags(params.tags);
    if (tagError) return tagError;
  }
  // The region steering gate (CI2-R1) binds the write pair too.
  if (params.region !== undefined && params.region !== null) {
    if (typeof params.region !== 'string' || params.region.length === 0) {
      return 'region must be a non-empty string when provided.';
    }
    if (!REGION_ID_PATTERN.test(params.region)) {
      return 'region must match ^[a-z0-9-]{1,64}$ — it steers the hostname of the AK/SK-signed request, so free-text regions are rejected (use a region id like cn-southwest-2).';
    }
  }
  return null;
}

// The canonical request: plan and write build it from params the SAME
// way, so the approval token binds byte-identical JSON. create
// canonicalizes auth_type=IAM when absent (the CI1 verdict — the approval
// shows the EFFECTIVE request). Tags SORT by key (code-unit, not
// localeCompare — the token binds bytes and plan/write may run in
// different processes or locales); tag ORDER is semantically irrelevant.
// An empty tags array is dropped (the SDK's `if tags:` treats [] as
// unset — the approval must show what executes).
function buildInterpreterWriteRequest(params) {
  const request = {
    operation: params.operation,
    region: typeof params.region === 'string' && params.region ? params.region : 'cn-southwest-2',
  };
  const canonicalTags = (tags) => {
    if (!Array.isArray(tags) || tags.length === 0) return undefined;
    return [...tags]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((tag) => ({
        key: tag.key,
        value: tag.value,
      }));
  };
  if (params.operation === 'create_code_interpreter') {
    request.name = params.name;
    request.auth_type = params.auth_type === 'API_KEY' ? 'API_KEY' : 'IAM';
    if (request.auth_type === 'API_KEY') request.api_key_name = params.api_key_name;
    if (typeof params.description === 'string' && params.description) request.description = params.description;
    const tags = canonicalTags(params.tags);
    if (tags) request.tags = tags;
  }
  if (params.operation === 'update_code_interpreter') {
    request.code_interpreter_id = params.code_interpreter_id;
    const tags = canonicalTags(params.tags);
    if (tags) request.tags = tags;
  }
  if (params.operation === 'delete_code_interpreter') request.code_interpreter_id = params.code_interpreter_id;
  return request;
}

// Token namespace — distinct from the agentarts CLI, memory, and browser
// namespaces so a CLI/memory/browser token can never authorize an
// interpreter write (and vice versa). The request JSON carries no
// secrets; hash-exact binding is the whole check.
const INTERPRETER_WRITE_TOKEN_CLI = 'agentarts-interpreter-sdk';

export function planAgentartsInterpreterWrite(params = {}) {
  const invalid = validateInterpreterWrite(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error: invalid,
    };
  }
  const request = buildInterpreterWriteRequest(params);
  let approvalToken;
  try {
    approvalToken = createApprovalTokenStore(INTERPRETER_WRITE_TOKEN_CLI).create([JSON.stringify(request)]);
  } catch (error) {
    // Fail-closed store surfaced as a structured rejection (the browser
    // bridge's R3 rule: the raw throw escaped to the MCP layer as a bare
    // -32603).
    return {
      ok: false,
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error: `The approval-token store could not be written (${error.message}) — no token was minted and nothing was executed. Fix the store access (~/.config/huaweicloud/approvals.json) and re-plan.`,
    };
  }
  // Loud-storage warning (the browser bridge's R1/R2 pattern,
  // interpreter-worded): the tag {key, value} shape puts a
  // credential-shaped NAME and its VALUE in separate JSON keys, so
  // neither redactSecrets' key[:=]-adjacency nor the approvals-store
  // scrub can mask them at rest — the warning is the only surface that
  // flags a secret riding tags or description into approvals.json.
  // Detection covers BOTH halves: a secret-shaped tag KEY and
  // credential-shaped free text in tag values or description.
  const warnings = [];
  const credentialShaped = (text) =>
    typeof text === 'string' && (redactCredentialShapes(text) !== text || BARE_TOKEN_PREFIX.test(text));
  const secretKeyName = new RegExp(`(${CREDENTIAL_KEY_TOKENS.map((t) => t.replace(/_/g, '[_-]?')).join('|')})`, 'i');
  const descriptionFlagged = typeof params.description === 'string' && credentialShaped(params.description);
  const tagsFlagged =
    Array.isArray(params.tags) &&
    params.tags.some(
      (tag) =>
        tag &&
        typeof tag === 'object' &&
        (secretKeyName.test(String(tag.key || '')) || credentialShaped(String(tag.value || ''))),
    );
  if (descriptionFlagged || tagsFlagged) {
    warnings.push(
      'Some request content (description or tag key/value pairs) matches credential shapes (api_key/password/token patterns — the check is over-inclusive on ordinary key:value phrasing). The request persists in the approval store (0600, 5-minute TTL) with tag values UNMASKABLE by the at-rest redactor (the {key, value} JSON shape defeats key[:=] adjacency), and tags are visible on every future list/get of the resource — confirm the user intends THIS content on a cloud resource before presenting the request for approval.',
    );
  }
  // No ?? fallback (the family round-3 rule): a write operation added to
  // the enum without a meta entry must FAIL LOUDLY here. Key parity with
  // INTERPRETER_WRITE_OPERATIONS is pinned in structure.test.mjs.
  const meta = WRITE_OPERATION_META[params.operation];
  const labels = meta.labels;
  const labelSuffix = labels.length > 0 ? ` Labels: ${labels.join(', ')}.` : '';
  const authTypeNote =
    params.operation === 'create_code_interpreter'
      ? request.auth_type === 'IAM'
        ? ' auth_type defaults to IAM (canonicalized): the data plane signs with the same AK/SK this toolkit injects — no further setup needed for sessions and actions.'
        : ' auth_type=API_KEY: the data plane will need the console api_key (HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY) — the response is not known to return the key value (browser family measured this for browsers, trap 61; CI-side unmeasured).'
      : '';
  return {
    ok: true,
    service: 'AgentArts',
    tier: 'approved',
    operation: `interpreter ${params.operation} (SDK control plane; no CLI subcommand in 0.1.7)`,
    labels,
    warnings,
    request,
    approvalToken,
    approvalNote: `Present the request above to the user.${labelSuffix} On explicit approval, run huaweicloud_agentarts_interpreter_write with THIS approvalToken, the SAME parameters, and approvedByUser: true (the token binds them exactly); otherwise discard it.${authTypeNote}`,
  };
}

const INTERPRETER_WRITE_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk import CodeInterpreter',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    # The request rides STDIN (the repo-wide rule): argv is process-list',
  '    # visible and a long description would hit the kernel argv limit.',
  '    params = json.loads(sys.stdin.read())',
  '    client = CodeInterpreter(region=params["region"], auth_type="IAM")',
  '    op = params["operation"]',
  '    if op == "create_code_interpreter":',
  '        kwargs = {"name": params["name"], "auth_type": params["auth_type"]}',
  '        if params.get("api_key_name"): kwargs["api_key_name"] = params["api_key_name"]',
  '        if params.get("description"): kwargs["description"] = params["description"]',
  '        if params.get("tags"): kwargs["tags"] = params["tags"]',
  '        result = client.create_code_interpreter(**kwargs)',
  '    elif op == "update_code_interpreter":',
  '        result = client.update_code_interpreter(params["code_interpreter_id"], tags=params["tags"])',
  '        if result is None:',
  "            # Empty-body 200 (the browser bridge's R2 rule): the SDK",
  '            # transport returns None when the response has no content — a',
  '            # SUCCESS misread as pollution by the envelope without this',
  '            # synthesis (the delete branch synthesizes for the same',
  '            # reason).',
  '            result = {"updated": True, "code_interpreter_id": params["code_interpreter_id"]}',
  '    elif op == "delete_code_interpreter":',
  '        client.delete_code_interpreter(params["code_interpreter_id"])',
  '        result = {"deleted": True, "code_interpreter_id": params["code_interpreter_id"]}',
  '    else:',
  '        print("AGENTARTS_INTERPRETER_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  // SystemExit re-raise + BaseException catch: same as the read snippet
  // (SystemExit must not become "SystemExit: 2" with exit 1; the
  // bad-operation exit-2 path lives inside this try). ToolsAPIError
  // extends BaseException (tools_http.py:10).
  'except SystemExit:',
  '    raise',
  'except BaseException as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Replay (already_consumed) guidance, per-operation: what verify call
// answers "did it land" for each write shape.
function replayGuidanceNote(operation, concurrency) {
  const prefix = concurrency
    ? 'This token was consumed by a concurrent call — the write may already have executed.'
    : 'This token was already used — the write may already have executed.';
  const verify =
    operation === 'create_code_interpreter'
      ? 'huaweicloud_agentarts_interpreter_read (list_code_interpreters by name)'
      : 'huaweicloud_agentarts_interpreter_read (get_code_interpreter by id — not-found on a delete means deleted; the update-family rule is success ≠ applied)';
  return `${prefix} Verify with ${verify} BEFORE re-planning anything.`;
}

// Write-side post-processing, composed around the envelope at the write
// call site (the family's symmetric extension point). Success notes
// teach the measured traps at the result surface; failure carries the
// burn disclosure.
function enrichInterpreterWrite(payload, params) {
  if (!payload.ok) {
    payload.error = `${payload.error || 'Execution failed.'} The single-use token was consumed by this attempt — re-plan for a retry.`;
    return payload;
  }
  const notes = [];
  if (params.operation === 'create_code_interpreter') {
    const authType = params.auth_type === 'API_KEY' ? 'API_KEY' : 'IAM';
    if (authType === 'API_KEY') {
      notes.push(
        'API_KEY-typed interpreter created: the data plane needs the console api_key (HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY) — the response is not known to return the key value (browser family measured this for browsers, trap 61; CI-side unmeasured). Sessions and actions on this interpreter require that env var.',
      );
    }
    notes.push(
      'The create attaches the tenant-shared default gateway (persists across deletes — trap 63 family) and the response access_endpoint is the bare data-plane base URL — the SDK constructor auto-prepends https:// (trap 82).',
    );
  }
  if (params.operation === 'update_code_interpreter') {
    notes.push(
      'Verify with huaweicloud_agentarts_interpreter_read (get_code_interpreter): the update-family rule is success ≠ applied (measured on the sibling gateway family, trap 45) — the server may accept and silently drop fields.',
    );
  }
  if (params.operation === 'delete_code_interpreter') {
    notes.push(
      'The delete cascades to the interpreter\'s live sessions (trap 86 — they start answering "No matching policy found") and returned before the list converged — a 2-10 seconds staleness window may still show the resource (trap 89). Poll list_code_interpreters to confirm deletion.',
    );
  }
  if (notes.length > 0) payload.notes = notes;
  return payload;
}

export async function runAgentartsInterpreterWrite({ approvalToken, approvedByUser, ...params } = {}, options = {}) {
  const invalid = validateInterpreterWrite(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error: invalid,
    };
  }
  // The repo's three-element approval contract: token + exact parameters +
  // the explicit attestation. Param validation runs FIRST (a pure data
  // error needs no attestation), the attestation throw second — the
  // family's deliberate ordering.
  if (approvedByUser !== true) {
    throw new Error(
      'approvedByUser must be true after explicit user approval of the plan request — run huaweicloud_agentarts_interpreter_plan, present the request to the user, and only then execute with the token.',
    );
  }
  if (typeof approvalToken !== 'string' || !approvalToken) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error:
        'approvalToken is required — run huaweicloud_agentarts_interpreter_plan first, present the request to the user, and pass the token plus the SAME parameters here on explicit approval.',
    };
  }
  const store = createApprovalTokenStore(INTERPRETER_WRITE_TOKEN_CLI);
  const inspection = store.inspect(approvalToken);
  if (inspection.state === 'already_consumed') {
    return {
      ok: true,
      status: 'ok',
      outcome: 'already_processed',
      note: replayGuidanceNote(params.operation, false),
    };
  }
  if (inspection.state === 'expired') {
    return {
      ok: false,
      status: 'rejected',
      code: 'CONFIRM_TOKEN_EXPIRED',
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error: 'approvalToken expired — re-plan with huaweicloud_agentarts_interpreter_plan and get a fresh approval.',
    };
  }
  if (inspection.state === 'not_found') {
    return {
      ok: false,
      status: 'rejected',
      code: 'CONFIRM_TOKEN_NOT_FOUND',
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error:
        'approvalToken not found (never created, pruned after the TTL, or minted in a different namespace) — a token consumed long ago may have had its tombstone pruned, in which case the write may already have executed: verify with huaweicloud_agentarts_interpreter_read BEFORE re-planning anything.',
    };
  }
  const request = buildInterpreterWriteRequest(params);
  const requestHash = hashNamespacedArgs(INTERPRETER_WRITE_TOKEN_CLI, [JSON.stringify(request)]);
  if (requestHash !== inspection.entry.argsHash) {
    return {
      ok: false,
      status: 'rejected',
      code: 'CONFIRM_TOKEN_MISMATCH',
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error:
        'approvalToken was minted for DIFFERENT parameters — the write binds the exact planned request. Re-plan with the changed parameters (the token stays valid for the original ones).',
    };
  }
  // Credentials BEFORE consumption (the family's order): the control
  // plane needs injectable AK/SK, and a missing-credential rejection must
  // not burn the approval on a guaranteed no-op spawn.
  if (hasInjectableCredentials() === false) {
    return {
      ok: false,
      status: 'rejected',
      code: 'NO_DEVKIT_CREDENTIALS',
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error:
        'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files or the metadata chain. The token was NOT consumed.',
    };
  }
  // Binding + credentials verified — consume (single-use tombstone) before
  // executing. The store write FAILS CLOSED (the family's R2 rule): a
  // store that cannot persist the tombstone must not let the write
  // execute (a swallowed failure used to report consume-success without
  // the tombstone, and a replay re-executed an approved write).
  let stored;
  try {
    stored = store.consume(approvalToken);
  } catch (error) {
    return {
      ok: false,
      status: 'rejected',
      code: 'TOKEN_STORE_UNWRITABLE',
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error: `The approval-token store could not be updated (${error.message}) — the token was NOT consumed and the write did NOT execute. Fix the store access (~/.config/huaweicloud/approvals.json), then retry with the SAME token.`,
    };
  }
  if (!stored) {
    const recheck = store.inspect(approvalToken);
    if (recheck.state === 'already_consumed') {
      return {
        ok: true,
        status: 'ok',
        outcome: 'already_processed',
        note: replayGuidanceNote(params.operation, true),
      };
    }
    return {
      ok: false,
      status: 'rejected',
      code: recheck.state === 'expired' ? 'CONFIRM_TOKEN_EXPIRED' : 'CONFIRM_TOKEN_NOT_FOUND',
      service: 'AgentArts',
      operation: operationLabel(params.operation),
      error: 'approvalToken could not be consumed (raced and pruned?) — re-plan.',
    };
  }
  const childEnv = buildChildEnv({ injectCredentials: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVED_TIMEOUT_MS;
  const args = ['-c', INTERPRETER_WRITE_SNIPPET];
  const outcome = await runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: JSON.stringify(request),
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      return enrichInterpreterWrite(shapeInterpreterResult(result, candidate, params, timeoutMs, parsed), params);
    },
  });
  // Fallthrough honesty (the family's round-1/2 rule): when NO python
  // candidate could run the SDK, the generic install remediation comes
  // back marked unshaped: true — shapeResult never ran, so the
  // consumed-token disclosure must come from here.
  if (!outcome.ok && outcome.unshaped === true) {
    outcome.error = `${outcome.error} The single-use approval token was already CONSUMED by this attempt and stays burned — after fixing the SDK install, re-plan (replaying this token returns already_processed without executing anything).`;
  }
  return outcome;
}
