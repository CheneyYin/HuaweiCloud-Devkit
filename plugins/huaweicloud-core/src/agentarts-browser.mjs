// AgentArts browser CONTROL-PLANE read bridge (B2). The 0.1.7 CLI has
// zero browser subcommands (toolkit tree grep — findings trap 61 context),
// so the SDK Browser class is the only path. This module mirrors the
// memory read bridge (agentarts-memory.mjs): inline python snippet over
// the CLI-owned interpreter, our own exit codes, allowlist child env,
// redaction on every surface, boundary validation with no coercion.
//
// Credential model (WIDER than the memory data-plane bridge, NARROWER
// than nothing): the browser control plane authenticates with the
// injected AK/SK (SDK-HMAC-SHA256, the list_agents posture) —
// injectCredentials stays ON. The data plane is not touched by these
// four reads: list/get browsers and profiles ride the control-plane
// client only, so no data endpoint and no browser api_key are needed.
//
// Request transport: STDIN, not argv (the repo-wide rule since
// interrogate round 2 — argv is process-list visible and a long name
// filter would hit the kernel per-argument limit).
//
// Failure contract: the snippet's exit codes are OURS (0 = JSON
// printed, 1 = failure, 3 = module missing) and the exception handler
// catches BaseException, NOT Exception — the SDK's ToolsAPIError
// extends BaseException (tools_http.py:10, findings trap A5/TH:10),
// so an `except Exception` bridge leaks the error past the handler and
// kills the child with an uncaught traceback. This is the single
// browser-specific deviation from the memory snippet.

import { buildChildEnv, READONLY_TIMEOUT_MS, runOverPythonCandidates, saveLargeOutput } from './agentarts-cli.mjs';
import { BROWSER_READ_OPERATIONS } from './agentarts-browser-tools.mjs';
import { redactSecrets } from './safety-policy.mjs';

// Browser list bounds: the SDK client applies NO limit/offset cap
// (browser_client.py list methods pass them straight through), so the
// bridge holds the conservative 1-100 window (the memory list posture).
const BROWSER_LIMIT_RANGE = [1, 100];

const BROWSER_READ_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk import Browser',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    params = json.loads(sys.stdin.read())',
  '    client = Browser(region=params["region"])',
  '    op = params["operation"]',
  '    if op == "list_browsers" or op == "list_browser_profiles":',
  '        kwargs = {}',
  '        if params.get("name"): kwargs["name"] = params["name"]',
  '        if params.get("limit") is not None: kwargs["limit"] = params["limit"]',
  '        if params.get("offset") is not None: kwargs["offset"] = params["offset"]',
  '        if params.get("sort_key"): kwargs["sort_key"] = params["sort_key"]',
  '        if params.get("sort_dir"): kwargs["sort_dir"] = params["sort_dir"]',
  '        if op == "list_browsers":',
  '            result = client.list_browsers(**kwargs)',
  '        else:',
  '            result = client.list_browser_profiles(**kwargs)',
  '    elif op == "get_browser":',
  '        result = client.get_browser(params["browser_id"])',
  '    elif op == "get_browser_profile":',
  '        result = client.get_browser_profile(params["profile_id"])',
  '    else:',
  '        print("AGENTARTS_BROWSER_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  // ToolsAPIError extends BaseException (tools_http.py:10) — an
  // `except Exception` handler cannot catch it and the child dies with
  // an uncaught traceback instead of our exit-1 contract.
  'except BaseException as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Legal top-level parameter keys — a typo'd field must not vanish
// silently (the silent-no-op class; the memory bridge's rule). Tag
// filters exist on the SDK list methods but are deliberately NOT
// exposed: they stay unknown-param-rejected until a measured need.
const BROWSER_READ_PARAM_KEYS = [
  'operation',
  'browser_id',
  'profile_id',
  'name',
  'limit',
  'offset',
  'sort_key',
  'sort_dir',
  'region',
];

// Per-operation applicability: a legal key in the wrong operation is a
// silent no-op otherwise. Every operation takes operation/region; the
// map lists the rest.
const OP_PARAM_APPLICABILITY = {
  list_browsers: ['name', 'limit', 'offset', 'sort_key', 'sort_dir'],
  list_browser_profiles: ['name', 'limit', 'offset', 'sort_key', 'sort_dir'],
  get_browser: ['browser_id'],
  get_browser_profile: ['profile_id'],
};

function rejectUnknownParams(params, legalKeys, operation) {
  const applicable = OP_PARAM_APPLICABILITY[operation] ?? [];
  for (const key of Object.keys(params)) {
    if (!legalKeys.includes(key)) {
      return `Unknown parameter "${key}" — legal keys: ${legalKeys.join(', ')}.`;
    }
    if (!['operation', 'region'].includes(key) && !applicable.includes(key)) {
      return `"${key}" is not a parameter of ${operation} — it would be silently ignored. Applicable keys for ${operation}: ${applicable.join(', ') || '(none beyond operation/region)'}.`;
    }
  }
  return null;
}

// Boundary validation (the tool's front door — the snippet trusts what
// arrives). Returns an error string or null. Strict typing throughout:
// mistyped values are rejected, never coerced (the memory bridge's
// interrogate-round-1/2/3 policy).
function validateBrowserRead(params) {
  if (!BROWSER_READ_OPERATIONS.includes(params.operation)) {
    return `operation must be one of: ${BROWSER_READ_OPERATIONS.join(', ')}.`;
  }
  const unknown = rejectUnknownParams(params, BROWSER_READ_PARAM_KEYS, params.operation);
  if (unknown) return unknown;
  const need = (field, message) => {
    if (typeof params[field] !== 'string' || params[field].length === 0) return message;
    return null;
  };
  if (params.operation === 'get_browser') {
    const err = need('browser_id', 'browser_id is required for get_browser.');
    if (err) return err;
  }
  if (params.operation === 'get_browser_profile') {
    const err = need('profile_id', 'profile_id is required for get_browser_profile.');
    if (err) return err;
  }
  for (const field of ['name', 'sort_key']) {
    if (params[field] !== undefined && params[field] !== null) {
      if (typeof params[field] !== 'string' || params[field].length === 0) {
        return `${field} must be a non-empty string when provided — mistyped values are rejected, not coerced.`;
      }
    }
  }
  if (params.sort_dir !== undefined && params.sort_dir !== null && !['asc', 'desc'].includes(params.sort_dir)) {
    return 'sort_dir must be "asc" or "desc".';
  }
  for (const field of ['limit', 'offset']) {
    if (params[field] !== undefined && params[field] !== null) {
      const value = params[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return `${field} must be an integer (got ${typeof value}) — mistyped values are rejected, not coerced.`;
      }
      if (field === 'limit' && (value < BROWSER_LIMIT_RANGE[0] || value > BROWSER_LIMIT_RANGE[1])) {
        return `limit must be ${BROWSER_LIMIT_RANGE[0]}-${BROWSER_LIMIT_RANGE[1]} (conservative bridge window; SDK applies no cap).`;
      }
      if (field === 'offset' && value < 0) return 'offset must be >= 0 (0-based).';
    }
  }
  // region: a mistyped region silently became the cn-southwest-2 default
  // in the memory bridge once — rejected at the boundary here too.
  if (params.region !== undefined && params.region !== null) {
    if (typeof params.region !== 'string' || params.region.length === 0) {
      return 'region must be a non-empty string when provided.';
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

// Shared payload ENVELOPE, the memory bridge's shape verbatim (parse,
// redact, fail, truncate, assemble — no operation-specific enrichment).
function shapeBrowserResult(result, candidate, params, timeoutMs, parsed = parseSnippetStdout(result)) {
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
    operation: `browser ${params.operation} (SDK control plane; no CLI subcommand in 0.1.7)`,
    executable: candidate,
    exitCode: result.exitCode,
    failureDetected: failed,
    ...(largeOutputFile || failed ? {} : { result: parsed }),
    stdout: payloadStdout,
    stderr: redactSecrets(result.stderr || ''),
    ...(result.timedOut
      ? { timedOut: true, error: `agentarts browser ${params.operation} timed out after ${timeoutMs} ms.` }
      : {}),
    ...(parsePolluted
      ? {
          error:
            'exit 0 but stdout was not parseable JSON — output pollution suspected (the snippet prints clean JSON on success).',
        }
      : {}),
  };
}

// Read-bridge post-processing (the enrichMemoryRead pattern). The one
// browser load-bearing advisory: an API_KEY-typed browser cannot be
// driven by this toolkit's default posture (the console key is the only
// route — trap 61), so the read surface teaches it exactly where the
// agent discovers the resource it was about to pick.
function enrichBrowserRead(payload, params, parsed) {
  if (!payload.ok) return payload; // advisories describe RESULTS — a failed call has none
  const notes = [];
  const collectAuthTypes = (entry) =>
    entry && typeof entry === 'object' && typeof entry.auth_type === 'string' ? [entry.auth_type] : [];
  const entries = Array.isArray(parsed?.items)
    ? parsed.items.flatMap((entry) => collectAuthTypes(entry))
    : collectAuthTypes(parsed);
  if (entries.includes('API_KEY')) {
    notes.push(
      'API_KEY-typed browser in results: the data plane needs the console api_key (HUAWEICLOUD_SDK_BROWSER_API_KEY env) — create/get responses never return the key value (trap 61). Prefer an IAM-typed browser (or create one through the browser create tool), which signs the data plane with the same AK/SK this toolkit injects.',
    );
  }
  if (notes.length > 0) payload.notes = notes;
  return payload;
}

export async function readAgentartsBrowser(params = {}, options = {}) {
  const invalid = validateBrowserRead(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation || '(unknown)'} (SDK control plane)`,
      error: invalid,
    };
  }

  // The request carries ONLY non-secret parameters; AK/SK ride the child
  // env (injectCredentials on — the control plane is AK/SK-signed, the
  // list_agents posture; the memory data plane's narrower key-file model
  // does not apply here).
  const request = {
    operation: params.operation,
    region: typeof params.region === 'string' && params.region ? params.region : 'cn-southwest-2',
  };
  for (const field of ['browser_id', 'profile_id', 'name', 'sort_key', 'sort_dir']) {
    if (typeof params[field] === 'string' && params[field]) request[field] = params[field];
  }
  for (const field of ['limit', 'offset']) {
    if (params[field] !== undefined && params[field] !== null) request[field] = params[field];
  }
  const jsonArg = JSON.stringify(request);

  const childEnv = buildChildEnv({ injectCredentials: true });
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', BROWSER_READ_SNIPPET];

  return runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: jsonArg,
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      return enrichBrowserRead(shapeBrowserResult(result, candidate, params, timeoutMs, parsed), params, parsed);
    },
  });
}

// Tool dispatch (definitions live in agentarts-browser-tools.mjs).
export async function callAgentartsBrowserTool(name, rawArgs = {}) {
  if (name === 'huaweicloud_agentarts_browser_read') return readAgentartsBrowser(rawArgs);
  return { ok: false, error: `Unknown agentarts browser tool: ${name}` };
}
