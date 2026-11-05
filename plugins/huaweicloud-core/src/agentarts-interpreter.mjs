// AgentArts code interpreter CONTROL-PLANE read bridge (CI2). The 0.1.10
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

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync as writeSessionFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildChildEnv,
  DEFAULT_APPROVED_TIMEOUT_MS,
  hasInjectableCredentials,
  OUTPUT_DIR,
  READONLY_TIMEOUT_MS,
  runOverPythonCandidates,
  saveLargeOutput,
} from './agentarts-cli.mjs';
import {
  INTERPRETER_INVOKE_ACTIONS,
  INTERPRETER_READ_OPERATIONS,
  INTERPRETER_WRITE_OPERATIONS,
} from './agentarts-interpreter-tools.mjs';
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
    operation: `interpreter ${params.operation} (SDK control plane; no CLI subcommand in 0.1.10)`,
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
  if (name === 'huaweicloud_agentarts_interpreter_session') return runAgentartsInterpreterSession(rawArgs);
  if (name === 'huaweicloud_agentarts_interpreter_invoke') return runAgentartsInterpreterInvoke(rawArgs);
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
  start_session: {
    labels: [],
    approvalScope:
      ' One approval starts the session AND its lease: the session_timeout shown is what the LOCAL lease record enforces as the consent boundary, while the cloud session dies independently and is measured NOT a wall clock at 60s (trap 85) — stop is the only deterministic cleanup.',
  },
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
  'code_interpreter_name',
  'session_name',
  'session_timeout',
  'tags',
  'region',
];

const INTERPRETER_WRITE_OP_APPLICABILITY = {
  create_code_interpreter: ['name', 'auth_type', 'api_key_name', 'description', 'tags'],
  update_code_interpreter: ['code_interpreter_id', 'tags'],
  delete_code_interpreter: ['code_interpreter_id'],
  start_session: ['code_interpreter_name', 'session_name', 'session_timeout'],
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
      return `tags[${index}] must have exactly the keys "key" and "value" — got {${keys.map((k) => redactSecrets(k)).join(', ')}}.`;
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
  const sessionError = validateInterpreterWriteSessionExtension(params);
  if (sessionError) return sessionError;
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
  return buildInterpreterWriteRequestSessionExtension(request, params);
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
  // Orphan guard (plan-time local check; the write rechecks pre-consume
  // with a coded rejection): a second start_session on the same
  // interpreter while a live lease exists would orphan the cloud session.
  if (params.operation === 'start_session') {
    const guard = guardExistingSession(params.code_interpreter_name);
    if (guard) {
      return {
        ok: false,
        service: 'AgentArts',
        operation: operationLabel(params.operation),
        error: guard,
      };
    }
  }
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
  const scopeText = typeof meta.approvalScope === 'function' ? meta.approvalScope(request) : meta.approvalScope;
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
    operation: `interpreter ${params.operation} (SDK control plane; no CLI subcommand in 0.1.10)`,
    labels,
    warnings,
    request,
    approvalToken,
    approvalNote: `Present the request above to the user.${labelSuffix} On explicit approval, run huaweicloud_agentarts_interpreter_write with THIS approvalToken, the SAME parameters, and approvedByUser: true (the token binds them exactly); otherwise discard it.${scopeText ?? ''}${authTypeNote}`,
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
      : operation === 'start_session'
        ? 'huaweicloud_agentarts_interpreter_session (get_session by the session id from the original result) or the local session state file'
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
  // Session-op pre-consumption guard (the family's order): the orphan
  // guard rechecks at write time (state may have changed since plan) —
  // a policy-blocked write must not burn the approval.
  if (params.operation === 'start_session') {
    const guard = guardExistingSession(params.code_interpreter_name);
    if (guard) {
      return {
        ok: false,
        status: 'rejected',
        code: 'SESSION_LEASE_CONFLICT',
        service: 'AgentArts',
        operation: operationLabel(params.operation),
        error: `${guard} The token was NOT consumed.`,
      };
    }
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
  // Session ops take the session snippet (endpoint/auth resolve inside
  // the snippet via the control-plane probe); resource ops run the
  // canonical request verbatim.
  const isSessionWrite = params.operation === 'start_session';
  const args = ['-c', isSessionWrite ? INTERPRETER_SESSION_WRITE_SNIPPET : INTERPRETER_WRITE_SNIPPET];
  const outcome = await runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: JSON.stringify(request),
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      const payload = enrichInterpreterWrite(
        shapeInterpreterResult(result, candidate, params, timeoutMs, parsed),
        params,
      );
      if (isSessionWrite) return enrichInterpreterSessionWrite(payload, params, request, result);
      return payload;
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

// ---------------------------------------------------------------------------
// CI4: session lifecycle. start_session extends the WRITE pair (the
// session lease IS an approved boundary — it carries the timeout the user
// consented to); get/stop are the FREE session tool (reads + cleanup —
// risk only decreases). The lease's local carrier is the 0600 session
// state file, written by the start write and deleted by stop.
//
// The state file carries NO credentials (IAM-typed interpreters sign the
// data plane with the injected AK/SK; API_KEY-typed ones need the console
// key in HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY, allowlisted through
// buildChildEnv) — the file stores only the session context: the
// addressing pair (code_interpreter_name + session_id), the data-plane
// endpoint, auth posture, region, and the lease expiry.
//
// CI addressing differs from the browser family: the SDK's get_session
// takes the (code_interpreter_name, session_id) PAIR and stop_session
// addresses the client's OWN state — every snippet sets both fields
// first (the cross-process continuity model, trap 87).
//
// Lease semantics differ too (trap 85, measured): the cloud session
// OUTLIVES the nominal timeout (60s session answered 65s later), so the
// local lease is the CONSENT boundary (expiry = re-approval needed for
// NEW work via invoke) while get/stop stay reachable past it — stop is
// the only deterministic cleanup and must never gate on the local clock.

const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const SESSION_TIMEOUT_RANGE = [60, 86400];

function interpreterSessionFile(sessionId) {
  if (!UUID_PATTERN.test(sessionId)) {
    return { ok: false, error: 'session_id must be a valid UUID (the id start_session returned).' };
  }
  const root = process.env.HUAWEICLOUD_HOME || homedir();
  return {
    ok: true,
    path: join(root, '.config', 'huaweicloud', `agentarts-interpreter-session-${sessionId}.json`),
  };
}

function loadInterpreterSession(sessionId) {
  const file = interpreterSessionFile(sessionId);
  if (!file.ok) return { ok: false, error: file.error };
  let raw;
  try {
    raw = readFileSync(file.path, 'utf8');
  } catch {
    return {
      ok: false,
      error: `No session state file for session ${sessionId} (${file.path}). Sessions are recorded by the start_session write — if the session was started outside this toolkit, or its lease already ended and the file was removed, there is no local record to drive it from. Re-start the session through the interpreter write pair.`,
    };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.session_id || !parsed.code_interpreter_name) {
      return {
        ok: false,
        error: `The session state file ${file.path} is malformed — delete it and re-start the session.`,
      };
    }
    // The lease record must carry the full addressing context: a missing
    // numeric lease, a non-UUID session id, or a missing endpoint/auth
    // field leaves the session undriveable — malformed, not ungated.
    if (
      typeof parsed.lease_expires_at !== 'number' ||
      !UUID_PATTERN.test(String(parsed.session_id)) ||
      typeof parsed.data_endpoint !== 'string' ||
      !parsed.data_endpoint ||
      typeof parsed.auth_type !== 'string' ||
      !parsed.auth_type ||
      typeof parsed.region !== 'string' ||
      !parsed.region
    ) {
      return {
        ok: false,
        error: `The session state file ${file.path} is malformed (missing lease, endpoint, auth, or region) — delete it and re-start the session.`,
      };
    }
    return { ok: true, session: parsed };
  } catch {
    return {
      ok: false,
      error: `The session state file ${file.path} is not parseable JSON — delete it and re-start the session.`,
    };
  }
}

function saveInterpreterSession(state) {
  const file = interpreterSessionFile(state.session_id);
  if (!file.ok) return file;
  mkdirSync(dirname(file.path), { recursive: true });
  writeSessionFileSync(file.path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, path: file.path };
}

function deleteInterpreterSession(sessionId) {
  const file = interpreterSessionFile(sessionId);
  if (!file.ok) return;
  try {
    unlinkSync(file.path);
  } catch {
    // Already gone — the desired end state.
  }
}

// Session-file scan for the orphan guard: every record carries its FILE
// PATH (a non-UUID inner id cannot address the file through the
// UUID-gated helpers, and the sweep must unlink malformed records
// regardless).
function scanInterpreterSessions() {
  const root = process.env.HUAWEICLOUD_HOME || homedir();
  const dir = join(root, '.config', 'huaweicloud');
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.startsWith('agentarts-interpreter-session-') || !entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.session_id && parsed.code_interpreter_name) {
        sessions.push({ ...parsed, __path: join(dir, entry) });
      }
    } catch {
      // Malformed session records are not this scan's problem —
      // load-time errors disclose them by session id.
    }
  }
  return sessions;
}

// The orphan guard: a second start_session on the same
// code_interpreter_name while an unexpired local lease exists would
// orphan the cloud session (the SDK's second start just overwrites its
// own state; the first cloud session keeps running — trap 85's cloud
// lifetime). Reject the second start, and opportunistically sweep
// EXPIRED or malformed records for that interpreter (stale leases
// describe nothing consented-to).
function guardExistingSession(codeInterpreterName) {
  const now = Date.now();
  const matches = [];
  for (const session of scanInterpreterSessions()) {
    if (session.code_interpreter_name !== codeInterpreterName) continue;
    const shapeOk =
      typeof session.lease_expires_at === 'number' &&
      UUID_PATTERN.test(String(session.session_id)) &&
      typeof session.data_endpoint === 'string' &&
      session.data_endpoint &&
      typeof session.auth_type === 'string' &&
      session.auth_type &&
      typeof session.region === 'string' &&
      session.region;
    if (shapeOk && session.lease_expires_at > now) {
      matches.push(session);
    } else {
      // Stale or malformed record: sweep it BY PATH (the UUID-gated
      // delete helper cannot address a non-UUID inner id).
      try {
        unlinkSync(session.__path);
      } catch {
        // Already gone.
      }
    }
  }
  if (matches.length > 0) {
    const live = matches
      .map((m) => `${m.session_id} (lease until ${new Date(m.lease_expires_at).toISOString()})`)
      .join(', ');
    return `An unexpired session lease already exists for interpreter "${codeInterpreterName}": ${live}. A second start would orphan the cloud session (the SDK's own state just overwrites; the cloud session outlives the nominal timeout — trap 85). Stop it first with huaweicloud_agentarts_interpreter_session (operation stop_session), or wait for the lease to expire.`;
  }
  return null;
}

// Session-lifecycle validation, composed INTO validateInterpreterWrite
// at its tail (the write pair's single front door stays one function).
function validateInterpreterWriteSessionExtension(candidate) {
  if (candidate.operation === 'start_session') {
    const need = (field, message) => {
      if (typeof candidate[field] !== 'string' || candidate[field].length === 0) return message;
      return null;
    };
    const err =
      need(
        'code_interpreter_name',
        'code_interpreter_name is required for start_session (pattern ^[a-z][a-z0-9-]{0,38}[a-z0-9]$).',
      ) ?? need('session_name', 'session_name is required for start_session.');
    if (err) return err;
    if (!INTERPRETER_NAME_PATTERN.test(candidate.code_interpreter_name)) {
      return 'code_interpreter_name must match ^[a-z][a-z0-9-]{0,38}[a-z0-9]$ — the interpreter resource name (list_code_interpreters carries it).';
    }
    if (!SESSION_NAME_PATTERN.test(candidate.session_name)) {
      return 'session_name must match ^[a-zA-Z0-9_-]{1,128}$ (a conservative bridge window — the SDK applies no rule of its own).';
    }
    if (candidate.session_timeout !== undefined && candidate.session_timeout !== null) {
      const t = candidate.session_timeout;
      if (typeof t !== 'number' || !Number.isSafeInteger(t) || Object.is(t, -0)) {
        return 'session_timeout must be an integer (seconds).';
      }
      if (t < SESSION_TIMEOUT_RANGE[0] || t > SESSION_TIMEOUT_RANGE[1]) {
        return `session_timeout must be ${SESSION_TIMEOUT_RANGE[0]}-${SESSION_TIMEOUT_RANGE[1]} seconds (SDK default 900; docstring range with both bounds measured accepted, trap 85).`;
      }
    }
  }
  return null;
}

// Canonical request extension for start_session: the token binds
// code_interpreter_name + session_name, and session_timeout ONLY when
// explicitly set (the SDK default 900 applies when omitted on BOTH sides
// of the binding).
function buildInterpreterWriteRequestSessionExtension(request, params) {
  if (params.operation === 'start_session') {
    request.code_interpreter_name = params.code_interpreter_name;
    request.session_name = params.session_name;
    if (params.session_timeout !== undefined && params.session_timeout !== null) {
      request.session_timeout = params.session_timeout;
    }
  }
  return request;
}

const INTERPRETER_SESSION_WRITE_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk import CodeInterpreter',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    params = json.loads(sys.stdin.read())',
  '    op = params["operation"]',
  '    if op == "start_session":',
  '        # The data-plane endpoint and auth_type resolve from the control',
  '        # plane FIRST: list_code_interpreters by name carries id/name/',
  '        # access_endpoint but NOT auth_type (trap 89) — the get by id is',
  '        # the only read that proves the auth posture.',
  '        probe = CodeInterpreter(region=params["region"], auth_type="IAM")',
  '        found = probe.list_code_interpreters(name=params["code_interpreter_name"])',
  '        items = found.get("items") or []',
  '        if not items:',
  '            print("ToolsAPIError: interpreter {} not found — list_code_interpreters by name returned nothing (verify with huaweicloud_agentarts_interpreter_read)".format(params["code_interpreter_name"]), file=sys.stderr)',
  '            sys.exit(1)',
  '        info = items[0]',
  '        # The server-side name filter is EXACTNESS-UNMEASURED — a fuzzy or',
  '        # reordered match must not silently start the wrong interpreter',
  '        # (the approval bound this exact name).',
  '        if info.get("name") != params["code_interpreter_name"]:',
  '            print("ToolsAPIError: list_code_interpreters returned {} for name {} — the name filter did not match exactly; refusing to start the wrong interpreter".format(info.get("name"), params["code_interpreter_name"]), file=sys.stderr)',
  '            sys.exit(1)',
  '        endpoint = info.get("access_endpoint")',
  '        if not endpoint:',
  '            print("ToolsAPIError: interpreter {} carries no access_endpoint (unexpected shape)".format(params["code_interpreter_name"]), file=sys.stderr)',
  '            sys.exit(1)',
  '        # The constructor data_endpoint auto-prepends the scheme (trap 82)',
  '        # — the bare defaultgw domain passes through as-is.',
  '        detail = probe.get_code_interpreter(info.get("id"))',
  '        auth = detail.get("auth_type") or "IAM"',
  '        client = CodeInterpreter(region=params["region"], data_endpoint=endpoint, auth_type=auth)',
  '        kwargs = {"code_interpreter_name": params["code_interpreter_name"], "session_name": params["session_name"]}',
  '        if params.get("session_timeout") is not None: kwargs["session_timeout"] = params["session_timeout"]',
  '        session_id = client.start_session(**kwargs)',
  '        # The bridge captures the lease record from THIS envelope: the',
  '        # interpreter half (endpoint/auth resolution context) plus the',
  '        # bare session id the SDK returns.',
  '        result = {"interpreter": {"id": info.get("id"), "name": info.get("name"), "auth_type": auth, "access_endpoint": endpoint}, "session_id": session_id}',
  '    else:',
  '        print("AGENTARTS_INTERPRETER_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  // SystemExit re-raise + BaseException catch: same contract as every
  // interpreter snippet (the bad-operation exit-2 path lives inside this
  // try; ToolsAPIError extends BaseException).
  'except SystemExit:',
  '    raise',
  'except BaseException as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Post-execution lease capture for start_session: parsed from the RAW
// stdout (not the envelope's possibly-truncated result) — the lease
// record must exist even when the display payload truncated.
function captureInterpreterSessionState(rawResult, request) {
  if (rawResult.timedOut || rawResult.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(rawResult.stdout);
    const interpreter = parsed && parsed.interpreter;
    const sessionId = parsed && parsed.session_id;
    if (!interpreter || typeof interpreter !== 'object' || typeof sessionId !== 'string') return null;
    if (!UUID_PATTERN.test(sessionId)) return null;
    const startedAt = Date.now();
    const timeout = typeof request.session_timeout === 'number' ? request.session_timeout : 900;
    return {
      code_interpreter_id: interpreter.id,
      code_interpreter_name: request.code_interpreter_name,
      auth_type: interpreter.auth_type,
      region: request.region,
      data_endpoint: interpreter.access_endpoint,
      session_id: sessionId,
      session_name: request.session_name,
      session_timeout: timeout,
      started_at: startedAt,
      lease_expires_at: startedAt + timeout * 1000,
    };
  } catch {
    return null;
  }
}

// Session-write post-processing: the start's lease capture, the
// concurrent-lease disclosure (check-then-act across the async spawn),
// and the API_KEY-missing error mapping.
function enrichInterpreterSessionWrite(payload, params, request, rawResult) {
  if (params.operation === 'start_session' && payload.ok) {
    const state = captureInterpreterSessionState(rawResult, request);
    if (state) {
      const concurrentNote = (name, ownId) => {
        const live = scanInterpreterSessions().filter(
          (other) =>
            other.code_interpreter_name === name &&
            other.session_id !== ownId &&
            typeof other.lease_expires_at === 'number' &&
            other.lease_expires_at > Date.now(),
        );
        return live.length > 0
          ? ` CONCURRENT-START WARNING: ${live.length} other live lease(s) exist for interpreter "${name}" (${live.map((c) => c.session_id).join(', ')}) — the earlier cloud session is likely ORPHANED (the guard is check-then-act across the spawn; the SDK's own second start overwrites its state silently). Stop the orphaned one via the console or wait for its timeout.`
          : '';
      };
      let saved = null;
      try {
        saved = saveInterpreterSession(state);
      } catch (error) {
        // The lease carrier itself failed — the cloud session is LIVE:
        // disclose loudly instead of throwing past the consumed-token
        // disclosure.
        payload.notes = [
          ...(payload.notes || []),
          `WARNING: the session state file could NOT be written (${error.message}) — the cloud session is live as session_id ${state.session_id} but this toolkit cannot drive or stop it. Stop the session via the console before it times out (${state.session_timeout}s).${concurrentNote(state.code_interpreter_name, state.session_id)}`,
        ];
      }
      if (saved && saved.ok) {
        payload.notes = [
          ...(payload.notes || []),
          `Session lease recorded: session_id ${state.session_id}, lease expires at ${new Date(state.lease_expires_at).toISOString()} (${state.session_timeout}s). Drive it with huaweicloud_agentarts_interpreter_session (get_session / stop_session) by session_id; the state file is ${saved.path} (0600). The local lease is the consent boundary — the cloud session dies independently and is measured NOT a wall clock (trap 85), so stop is the only deterministic cleanup.${concurrentNote(state.code_interpreter_name, state.session_id)}`,
        ];
      } else if (saved && !saved.ok) {
        payload.notes = [
          ...(payload.notes || []),
          `WARNING: the session state file could not be recorded (${saved.error}) — the cloud session is live as session_id ${state.session_id} but this toolkit cannot drive it. Stop it via the console before it times out.${concurrentNote(state.code_interpreter_name, state.session_id)}`,
        ];
      }
    } else {
      // The session is LIVE in the cloud but the local lease could not be
      // captured (unexpected shape) — disclose loudly.
      let rawId = '(unreadable)';
      try {
        const raw = JSON.parse(rawResult.stdout);
        if (raw && typeof raw.session_id === 'string') rawId = raw.session_id;
      } catch {
        // leave unreadable
      }
      payload.notes = [
        ...(payload.notes || []),
        `WARNING: the session state file could NOT be captured from the start response (unexpected shape) — the cloud session is live as session_id ${rawId} but this toolkit cannot drive or stop it by id. Stop the session via the console before it times out.`,
      ];
    }
  }
  const apiKeyMissing =
    /API Key is not provided/i.test(rawResult?.stderr || '') || /API Key is not provided/i.test(payload?.stderr || '');
  if (!payload.ok && apiKeyMissing) {
    payload.error = `${payload.error || 'Execution failed.'} The interpreter is API_KEY-typed: the data plane needs the console api_key exported as HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY in the agent launcher's environment (the response is not known to return the key value — browser-family measurement, trap 61; CI-side unmeasured). The token was consumed by this attempt — re-plan after exporting the key.`;
  }
  return payload;
}

const INTERPRETER_SESSION_TOOL_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk import CodeInterpreter',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    params = json.loads(sys.stdin.read())',
  '    client = CodeInterpreter(region=params["region"], data_endpoint=params["data_endpoint"], auth_type=params["auth_type"])',
  '    client.code_interpreter_name = params["code_interpreter_name"]',
  '    client.session_id = params["session_id"]',
  '    op = params["operation"]',
  '    if op == "get_session":',
  '        result = client.get_session(code_interpreter_name=params["code_interpreter_name"], session_id=params["session_id"])',
  '        if result is None:',
  '            result = {"session_state": "unknown (empty response)"}',
  '    elif op == "stop_session":',
  '        client.stop_session()',
  '        result = {"stopped": True, "session_id": params["session_id"]}',
  '    else:',
  '        print("AGENTARTS_INTERPRETER_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  'except SystemExit:',
  '    raise',
  'except BaseException as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Operation label for the session tool's rejection payloads (the
// CI2-R1 echo rule: a secret pasted into the caller-controlled operation
// must not ride a reject response verbatim).
function sessionOperationLabel(operation) {
  const raw = typeof operation === 'string' && operation ? operation : '(unknown)';
  return `interpreter session ${redactSecrets(raw)} (SDK data plane)`;
}

// Free-tier session tool (no approval token): get/stop over a recorded
// session lease. Both ops stay reachable past the local lease expiry
// (trap 85: the cloud session outlives the nominal timeout — stop is
// the only deterministic cleanup).
export async function runAgentartsInterpreterSession(params = {}, options = {}) {
  if (!['get_session', 'stop_session'].includes(params.operation)) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: sessionOperationLabel(params.operation),
      error: 'operation must be one of: get_session, stop_session.',
    };
  }
  for (const key of Object.keys(params)) {
    if (key !== 'operation' && key !== 'session_id') {
      return {
        ok: false,
        service: 'AgentArts',
        operation: sessionOperationLabel(params.operation),
        error: `Unknown parameter "${redactSecrets(key)}" — legal keys: operation, session_id. (Region/endpoint/auth type resolve from the session state file, never from tool args.)`,
      };
    }
  }
  if (typeof params.session_id !== 'string' || params.session_id.length === 0) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: sessionOperationLabel(params.operation),
      error: 'session_id is required — the id start_session returned.',
    };
  }
  if (!UUID_PATTERN.test(params.session_id)) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: sessionOperationLabel(params.operation),
      error: 'session_id must be a valid UUID (the id start_session returned).',
    };
  }
  if (hasInjectableCredentials() === false) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: sessionOperationLabel(params.operation),
      error:
        'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files or the metadata chain.',
    };
  }
  const load = loadInterpreterSession(params.session_id);
  if (!load.ok) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: sessionOperationLabel(params.operation),
      error: load.error,
    };
  }
  const session = load.session;
  const request = {
    operation: params.operation,
    region: session.region,
    data_endpoint: session.data_endpoint,
    auth_type: session.auth_type,
    code_interpreter_name: session.code_interpreter_name,
    session_id: session.session_id,
  };
  const childEnv = buildChildEnv({ injectCredentials: true });
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', INTERPRETER_SESSION_TOOL_SNIPPET];
  const outcome = await runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: JSON.stringify(request),
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      const payload = shapeInterpreterResult(result, candidate, params, timeoutMs, parsed);
      payload.operation = `interpreter session ${params.operation} (SDK data plane; no CLI subcommand in 0.1.10)`;
      return enrichInterpreterSession(payload, params, session, result);
    },
  });
  return outcome;
}

// Session-tool post-processing: lease staleness disclosure (never a hard
// gate — trap 85), stop's file cleanup, and the three measured error
// mappings (trap 86a/86b + the API_KEY-missing shape). A CONFIRMED death
// signature (either 86a shape or 86b) clears the lease record on the
// failure path too: the record describes nothing live, and keeping it
// guard-blocks the re-start with guidance that can never succeed (stop
// on the dead session errors; the D2 lockout class).
function enrichInterpreterSession(payload, params, session, rawResult) {
  const now = Date.now();
  const expired = typeof session.lease_expires_at === 'number' && session.lease_expires_at <= now;
  if (payload.ok) {
    const notes = [];
    if (params.operation === 'stop_session') {
      deleteInterpreterSession(params.session_id);
      notes.push(
        `The local session lease record was removed (${interpreterSessionFile(params.session_id).path}). Trap 87's no-op True needs an empty SDK client state — this tool always addresses the recorded session, so a dead session surfaces as an error with its own mapping instead (both paths clear the record).`,
      );
    }
    if (expired) {
      notes.push(
        params.operation === 'stop_session'
          ? `The local lease expired at ${new Date(session.lease_expires_at).toISOString()} — the cloud session dies independently and is measured NOT a wall clock (trap 85): it may still be live, and this stop was the deterministic cleanup.`
          : `The local lease expired at ${new Date(session.lease_expires_at).toISOString()} — the cloud session dies independently and is measured NOT a wall clock (trap 85): it may still be live (new work needs a new approved start_session; this record still addresses the session for stop).`,
      );
    }
    if (notes.length > 0) payload.notes = notes;
    return payload;
  }
  // Error mappings (the CI2-R1 double-prefix lesson applies: the real
  // stderr reads "ToolsAPIError: Tools API Error: Session not found").
  const text = `${payload.stderr || ''} ${payload.error || ''}`;
  if (/ToolsAPIError: (?:Tools API Error: )?(Session not found|No active session)/i.test(text)) {
    // The server CONFIRMED the session is dead: the record describes
    // nothing live — clear it so the re-start is not guard-blocked.
    deleteInterpreterSession(params.session_id);
    payload.error = `${payload.error} The cloud session is gone (died at its own leisure, stopped, or never existed — trap 86). The local lease record was removed (it described nothing live), so a re-start is no longer guard-blocked: run huaweicloud_agentarts_interpreter_plan (operation start_session) if you still need the interpreter.`;
  } else if (/ToolsAPIError: (?:Tools API Error: )?No matching policy found/i.test(text)) {
    deleteInterpreterSession(params.session_id);
    payload.error = `${payload.error} The INTERPRETER itself is gone (deleted — the delete cascades to its sessions, trap 86). The local lease record was removed; create a new interpreter via huaweicloud_agentarts_interpreter_plan (operation create_code_interpreter) if you still need code execution.`;
  } else if (/API Key is not provided/i.test(`${rawResult?.stderr || ''} ${payload.stderr || ''}`)) {
    payload.error = `${payload.error || 'Execution failed.'} The interpreter is API_KEY-typed: the data plane needs the console api_key exported as HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY in the agent launcher's environment.`;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// CI5: the lease-gated action tool. One invoke surface for the five
// action types of the minimal surface ruling; the lease recorded by
// start_session IS the approval boundary. Boundary validation
// reimplements or TIGHTENS the SDK wrappers' own rules so a deterministic
// client-side rejection cannot waste a spawn: the package whitelist
// (no whitespace, no shell metacharacters, `==` version specs only) is
// STRICTER than the SDK's five-character check because the SDK builds a
// shell command from the names and the sandbox runs it through a shell
// (trap 84: newline injection and silent `>` redirection both measured
// with exit_code 0); paths must be absolute under /home/user (the SDK's
// DEFAULT_PATH rule).

const INTERPRETER_INVOKE_PARAM_KEYS = [
  'action',
  'session_id',
  'code',
  'clear_context',
  'packages',
  'upgrade',
  'files',
  'path',
];

const INTERPRETER_INVOKE_ACTION_PARAMS = {
  execute_code: ['code', 'clear_context'],
  install_packages: ['packages', 'upgrade'],
  upload_files: ['files'],
  download_file: ['path'],
  clear_context: [],
};

// The package whitelist: name characters are alnum . _ - only, an
// optional `==` version spec of the same class. Every shell
// metacharacter and every whitespace form (including \n — the SDK's own
// check misses it, trap 84) fails this class.
const PACKAGE_SPEC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:==[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const DEFAULT_PATH_PREFIX = '/home/user';
const INVOKE_BATCH_RANGE = [1, 20];

function validateInterpreterInvoke(params) {
  // Array-includes gate (the browser invoke's rule, NOT an object lookup:
  // a plain-object lookup lets inherited names like "toString" or
  // "constructor" through the prototype chain — a wasted spawn at best
  // and a raw TypeError at worst — and a JSON array action coerces via
  // toString into a real key, skipping every action-specific check).
  if (typeof params.action !== 'string' || !INTERPRETER_INVOKE_ACTIONS.includes(params.action)) {
    return `action must be one of: ${INTERPRETER_INVOKE_ACTIONS.join(', ')}.`;
  }
  if (typeof params.session_id !== 'string' || params.session_id.length === 0) {
    return 'session_id is required — the id start_session returned.';
  }
  if (!UUID_PATTERN.test(params.session_id)) {
    return 'session_id must be a valid UUID (the id start_session returned).';
  }
  // Unknown top-level keys: the typo'd-field rule (a legal key in the
  // wrong action is the silent-no-op class).
  const applicable = INTERPRETER_INVOKE_ACTION_PARAMS[params.action];
  for (const key of Object.keys(params)) {
    if (!INTERPRETER_INVOKE_PARAM_KEYS.includes(key)) {
      return `Unknown parameter "${redactSecrets(key)}" — legal keys: ${INTERPRETER_INVOKE_PARAM_KEYS.join(', ')}.`;
    }
    if (!['action', 'session_id'].includes(key) && !applicable.includes(key)) {
      return `"${redactSecrets(key)}" is not a parameter of ${params.action} — it would be silently ignored. Applicable keys for ${params.action}: ${applicable.join(', ') || '(none beyond action/session_id)'}.`;
    }
  }
  if (params.action === 'execute_code') {
    if (typeof params.code !== 'string' || params.code.length === 0) {
      return 'code is required for execute_code (the sandbox is an IPython kernel — code runs as-is).';
    }
    if (
      params.clear_context !== undefined &&
      params.clear_context !== null &&
      typeof params.clear_context !== 'boolean'
    ) {
      return 'clear_context must be a boolean.';
    }
  }
  if (params.action === 'install_packages') {
    if (!Array.isArray(params.packages) || params.packages.length === 0) {
      return 'packages is required for install_packages (a non-empty array).';
    }
    if (params.packages.length > INVOKE_BATCH_RANGE[1]) {
      return `packages must contain at most ${INVOKE_BATCH_RANGE[1]} items (a conservative bridge window; the SDK applies no cap).`;
    }
    for (const [index, pkg] of params.packages.entries()) {
      if (typeof pkg !== 'string' || pkg.length === 0) {
        return `packages[${index}] must be a non-empty string.`;
      }
      if (!PACKAGE_SPEC_PATTERN.test(pkg)) {
        return `packages[${index}] ("${redactSecrets(pkg)}") must match name or name==version with characters [A-Za-z0-9._-] only — the SDK builds a pip shell command from these names and the sandbox runs it through a shell: whitespace (including newlines) injects a second command with exit_code 0, and > < >= forms silently become redirection (trap 84, both measured).`;
      }
    }
    if (params.upgrade !== undefined && params.upgrade !== null && typeof params.upgrade !== 'boolean') {
      return 'upgrade must be a boolean.';
    }
  }
  if (params.action === 'upload_files') {
    if (!Array.isArray(params.files) || params.files.length === 0) {
      return 'files is required for upload_files (a non-empty array — the batch is ATOMIC, all files or none).';
    }
    if (params.files.length > INVOKE_BATCH_RANGE[1]) {
      return `files must contain at most ${INVOKE_BATCH_RANGE[1]} items (a conservative bridge window).`;
    }
    for (const [index, file] of params.files.entries()) {
      if (!file || typeof file !== 'object' || Array.isArray(file)) {
        return `files[${index}] must be an object {path, content, description?}.`;
      }
      const keys = Object.keys(file);
      if (!keys.includes('path') || !keys.includes('content')) {
        return `files[${index}] must carry "path" and "content" — got {${keys.map((k) => redactSecrets(k)).join(', ')}}.`;
      }
      for (const extra of keys) {
        if (!['path', 'content'].includes(extra)) {
          return `files[${index}] has an unknown key "${redactSecrets(extra)}" — legal keys: path, content (the SDK's upload reads path and content ONLY; a description field is a silent no-op end-to-end, measured, so it is not accepted).`;
        }
      }
      if (typeof file.path !== 'string' || !file.path.startsWith(DEFAULT_PATH_PREFIX)) {
        return `files[${index}].path must be an absolute path under ${DEFAULT_PATH_PREFIX} (the SDK's own rule — relative paths are joined there anyway).`;
      }
      const content = file.content;
      const contentIsText = typeof content === 'string';
      // Python's b64decode with validate=False DISCARDS invalid characters
      // (measured: "AAEC!!!" decodes to b'\x00\x01\x02') — a charset gate
      // at the boundary makes corrupt input a deterministic reject instead
      // of silently-uploaded wrong bytes.
      const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
      const contentIsBlob =
        content &&
        typeof content === 'object' &&
        !Array.isArray(content) &&
        typeof content.base64 === 'string' &&
        BASE64_PATTERN.test(content.base64);
      if (!contentIsText && !contentIsBlob) {
        return `files[${index}].content must be a non-empty string (text) or {base64} with strict base64 charset [A-Za-z0-9+/=] — corrupt base64 is REJECTED, not silently decoded to wrong bytes (Python's b64decode discards invalid characters by default, measured).`;
      }
      if (contentIsText && content.length === 0) {
        return `files[${index}].content must be non-empty (use {base64: ""} semantics? No — an empty upload is a no-op; omit the file).`;
      }
    }
  }
  if (params.action === 'download_file') {
    if (typeof params.path !== 'string' || params.path.length === 0) {
      return 'path is required for download_file.';
    }
    if (!params.path.startsWith(DEFAULT_PATH_PREFIX)) {
      return `path must be an absolute path under ${DEFAULT_PATH_PREFIX} (the SDK's own rule).`;
    }
  }
  return null;
}

const INTERPRETER_INVOKE_SNIPPET = [
  'import base64, json, os, sys, time',
  'try:',
  '    from agentarts.sdk import CodeInterpreter',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    params = json.loads(sys.stdin.read())',
  '    client = CodeInterpreter(region=params["region"], data_endpoint=params["data_endpoint"], auth_type=params["auth_type"])',
  '    # The addressing PAIR is set before any call (the SDK get/stop/invoke',
  '    # need both — trap 87 cross-process continuity).',
  '    client.code_interpreter_name = params["code_interpreter_name"]',
  '    client.session_id = params["session_id"]',
  '    action = params["action"]',
  '    if action == "execute_code":',
  '        kwargs = {"code": params["code"]}',
  '        if params.get("clear_context") is not None: kwargs["clear_context"] = params["clear_context"]',
  '        result = client.execute_code(**kwargs)',
  '    elif action == "install_packages":',
  '        result = client.install_packages(params["packages"], upgrade=params.get("upgrade", False))',
  '    elif action == "upload_files":',
  '        files = []',
  '        for f in params["files"]:',
  '            content = f["content"]',
  '            if isinstance(content, dict) and "base64" in content:',
  '                content = base64.b64decode(content["base64"])',
  '            entry = {"path": f["path"], "content": content}',
  '            files.append(entry)',
  '        result = client.upload_files(files)',
  '    elif action == "download_file":',
  '        content = client.download_file(params["path"])',
  '        if isinstance(content, bytes):',
  '            # Binary content never crosses stdout as base64 (the browser',
  '            # screenshot precedent): decode to a 0600 file and return the',
  '            # path + size (trap 88).',
  '            out_dir = params["download_dir"]',
  '            os.makedirs(out_dir, exist_ok=True)',
  '            name = os.path.basename(params["path"]) or "download.bin"',
  '            path = os.path.join(out_dir, "agentarts-interpreter-download-{}-{}.{}".format(params["session_id"], int(time.time() * 1000), name))',
  '            with open(path, "wb") as fh:',
  '                fh.write(content)',
  '            os.chmod(path, 0o600)',
  '            result = {"action": "download_file", "path": params["path"], "saved_to": path, "bytes": len(content)}',
  '        else:',
  '            result = {"action": "download_file", "path": params["path"], "text": content}',
  '    elif action == "clear_context":',
  '        result = client.clear_context()',
  '    else:',
  '        print("AGENTARTS_INTERPRETER_BAD_ACTION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  'except SystemExit:',
  '    raise',
  'except BaseException as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Invoke-tool post-processing: the lease warning window, the
// execute_code remote-exception teaching, the install `==` teaching, and
// the three error mappings (death signatures clear the record — the
// CI4-R1 D2 lockout fix applies here too: a dead session's record must
// not block the re-start).
function enrichInterpreterInvoke(payload, params, session, rawResult) {
  const now = Date.now();
  const notes = [];
  if (payload.ok) {
    if (typeof session.lease_expires_at === 'number') {
      const remaining = session.lease_expires_at - now;
      if (remaining < 30_000) {
        notes.push(
          `The local lease expires in ${Math.max(0, Math.round(remaining / 1000))}s — finish the interaction or re-start the session (a new start needs a new approval); after expiry the invoke hard-rejects while stop in the session tool stays reachable (trap 85).`,
        );
      }
    }
    // execute_code: a remote exception sets is_error true and carries the
    // IPython traceback in the content block (trap 83) — teach the shape
    // at the surface so the agent does not misread it as a bridge
    // failure. The check reads the RAW stdout when the envelope dropped
    // the result to a >50KB side file (big output is execute_code's
    // NORMAL case, and a remote exception with large output is when the
    // teaching matters — the B5 R10d truncation-survival class).
    if (params.action === 'execute_code') {
      let isError = payload.result?.result?.is_error === true;
      if (!isError && !('result' in payload) && rawResult && !rawResult.timedOut && rawResult.exitCode === 0) {
        try {
          const raw = JSON.parse(rawResult.stdout);
          isError = raw?.result?.is_error === true;
        } catch {
          // Unparseable raw stdout — the envelope already says so.
        }
      }
      if (isError) {
        notes.push(
          'The REMOTE python raised (is_error true): the content block carries the IPython traceback — this is the sandbox execution result, not a bridge failure. sys.exit(N) surfaces the same way (the exit code does not propagate, trap 83).',
        );
      }
    }
    if (params.action === 'install_packages') {
      notes.push(
        "Version specs accepted here are `==` only — `>` `<` `>=` forms are rejected at the boundary because the sandbox shell turns them into silent redirection with exit_code 0 (trap 84). The result's structured_content carries pip's exit_code/stdout/stderr.",
      );
    }
    if (notes.length > 0) payload.notes = [...(payload.notes || []), ...notes];
    return payload;
  }
  const text = `${payload.stderr || ''} ${payload.error || ''}`;
  if (/ToolsAPIError: (?:Tools API Error: )?(Session not found|No active session)/i.test(text)) {
    deleteInterpreterSession(params.session_id);
    payload.error = `${payload.error} The cloud session is gone (died at its own leisure, stopped, or never existed — trap 86). The local lease record was removed, so a re-start is no longer guard-blocked: run huaweicloud_agentarts_interpreter_plan (operation start_session) if you still need the interpreter.`;
  } else if (/ToolsAPIError: (?:Tools API Error: )?No matching policy found/i.test(text)) {
    deleteInterpreterSession(params.session_id);
    payload.error = `${payload.error} The INTERPRETER itself is gone (deleted — the delete cascades to its sessions, trap 86). The local lease record was removed; create a new interpreter via huaweicloud_agentarts_interpreter_plan (operation create_code_interpreter) if you still need code execution.`;
  } else if (/API Key is not provided/i.test(`${rawResult?.stderr || ''} ${payload.stderr || ''}`)) {
    payload.error = `${payload.error || 'Execution failed.'} The interpreter is API_KEY-typed: the data plane needs the console api_key exported as HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY in the agent launcher's environment (trap 81).`;
  }
  return payload;
}

export async function runAgentartsInterpreterInvoke(params = {}, options = {}) {
  const invalid = validateInterpreterInvoke(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `interpreter invoke ${redactSecrets(typeof params.action === 'string' && params.action ? params.action : '(unknown)')} (SDK data plane)`,
      error: invalid,
    };
  }
  if (hasInjectableCredentials() === false) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `interpreter invoke ${params.action} (SDK data plane)`,
      error:
        'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files or the metadata chain.',
    };
  }
  const load = loadInterpreterSession(params.session_id);
  if (!load.ok) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `interpreter invoke ${params.action} (SDK data plane)`,
      error: load.error,
    };
  }
  const session = load.session;
  // The lease gate (CI5's core): an expired lease hard-rejects NEW work —
  // the consent boundary expired and a new start needs a new approval.
  // The cloud session may still be live (trap 85): stop stays reachable
  // in the session tool, and the death-signature mappings clear the
  // record when the cloud says the session is gone.
  if (typeof session.lease_expires_at === 'number' && session.lease_expires_at <= Date.now()) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `interpreter invoke ${params.action} (SDK data plane)`,
      code: 'SESSION_LEASE_EXPIRED',
      error: `The local lease for session ${params.session_id} expired at ${new Date(session.lease_expires_at).toISOString()} — the consent boundary for new work has passed, and a new start_session needs a new approval. The cloud session dies independently and is measured NOT a wall clock (trap 85): it may still be live (stop it via huaweicloud_agentarts_interpreter_session if you are done — stop stays reachable past the local lease).`,
    };
  }
  const request = {
    action: params.action,
    region: session.region,
    data_endpoint: session.data_endpoint,
    auth_type: session.auth_type,
    code_interpreter_name: session.code_interpreter_name,
    session_id: session.session_id,
    download_dir: OUTPUT_DIR,
  };
  if (params.action === 'execute_code') {
    request.code = params.code;
    if (params.clear_context !== undefined && params.clear_context !== null)
      request.clear_context = params.clear_context;
  }
  if (params.action === 'install_packages') {
    request.packages = params.packages;
    if (params.upgrade !== undefined && params.upgrade !== null) request.upgrade = params.upgrade;
  }
  if (params.action === 'upload_files') {
    request.files = params.files;
  }
  if (params.action === 'download_file') {
    request.path = params.path;
  }
  const childEnv = buildChildEnv({ injectCredentials: true });
  // Actions can be heavier than reads (measured: install up to 8.7s,
  // cold start 8.9s; arbitrary code execution is unbounded) — the
  // approved-write budget, not the readonly one.
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVED_TIMEOUT_MS;
  const args = ['-c', INTERPRETER_INVOKE_SNIPPET];
  return runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: JSON.stringify(request),
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      // The invoke params carry action, not operation — the shim keeps the
      // SHARED envelope's timeout error honest ("interpreter invoke <action>
      // timed out", never "interpreter undefined timed out" — the trap-77a
      // class).
      const payload = shapeInterpreterResult(
        result,
        candidate,
        { ...params, operation: `invoke ${params.action}` },
        timeoutMs,
        parsed,
      );
      payload.operation = `interpreter invoke ${params.action} (SDK data plane; no CLI subcommand in 0.1.10)`;
      return enrichInterpreterInvoke(payload, params, session, result);
    },
  });
}
