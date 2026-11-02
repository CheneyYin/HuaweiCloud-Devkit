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
  hasInjectableCredentials,
  READONLY_TIMEOUT_MS,
  runOverPythonCandidates,
  saveLargeOutput,
} from './agentarts-cli.mjs';
import { INTERPRETER_READ_OPERATIONS } from './agentarts-interpreter-tools.mjs';
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
  return { ok: false, error: `Unknown agentarts interpreter tool: ${redactSecrets(String(name))}` };
}
