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

import {
  buildChildEnv,
  DEFAULT_APPROVED_TIMEOUT_MS,
  hasInjectableCredentials,
  READONLY_TIMEOUT_MS,
  runOverPythonCandidates,
  saveLargeOutput,
} from './agentarts-cli.mjs';
import { BROWSER_READ_OPERATIONS, BROWSER_WRITE_OPERATIONS } from './agentarts-browser-tools.mjs';
import { createApprovalTokenStore, hashNamespacedArgs } from './approval-tokens.mjs';
import { CREDENTIAL_KEY_TOKENS, redactCredentialShapes } from './redact-core.mjs';
import { redactSecrets } from './safety-policy.mjs';

// Bare-token prefixes for the plan-time loud-storage warning (R2): Huawei
// AKs (AKLT...), GitHub (ghp_/gho_), OpenAI-style (sk-), Slack (xox),
// Anthropic (sk-ant-), and URL-with-credentials shapes. Detection only —
// nothing here redacts; the warning text carries the decision to the user.
const BARE_TOKEN_PREFIX =
  /(?:AKLT[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9-]{16,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@)/;

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
  // SystemExit must propagate (R1 review round): the bad-operation
  // sys.exit(2) inside the try raises SystemExit, which extends
  // BaseException — an unqualified BaseException handler converts our
  // own exit-2 contract into "SystemExit: 2" on stderr with exit 1.
  // Re-raising SystemExit first preserves BOTH the ToolsAPIError catch
  // and the exit-code contract.
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
// The SDK's own client-side validators, enforced at THIS boundary so a
// deterministic child failure cannot waste a spawn (or burn a write
// token — the R1 review round's boundary-burn class): sort_key is
// created_at|updated_at (browser_client.py:370-372), the list name
// filter is 2-40 chars (:378-380), and ids are UUIDs (:460-463).
const BROWSER_SORT_KEYS = ['created_at', 'updated_at'];
const BROWSER_NAME_FILTER_RANGE = [2, 40];
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
    if (!UUID_PATTERN.test(params.browser_id)) {
      return 'browser_id must be a valid UUID (the SDK validates the format client-side and rejects anything else — pass the id exactly as list_browsers returned it).';
    }
  }
  if (params.operation === 'get_browser_profile') {
    const err = need('profile_id', 'profile_id is required for get_browser_profile.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.profile_id)) {
      return 'profile_id must be a valid UUID (the SDK validates the format client-side — pass the id exactly as list_browser_profiles returned it).';
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
    if (params.name.length < BROWSER_NAME_FILTER_RANGE[0] || params.name.length > BROWSER_NAME_FILTER_RANGE[1]) {
      return `name must be ${BROWSER_NAME_FILTER_RANGE[0]}-${BROWSER_NAME_FILTER_RANGE[1]} characters (the SDK's own client-side filter rule).`;
    }
  }
  if (params.sort_key !== undefined && params.sort_key !== null && !BROWSER_SORT_KEYS.includes(params.sort_key)) {
    return `sort_key must be one of: ${BROWSER_SORT_KEYS.join(', ')} (the SDK's own client-side rule).`;
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
  // Credential pre-gate (R1 review round, unanimous three-reviewer
  // finding): without injectable AK/SK the child falls through the
  // profile/metadata chain — the SDK's metadata provider
  // (http://169.254.169.254) is a live third link on runtime hosts, so
  // an unmanaged ambient identity can silently authenticate the read.
  // list_agents and the CLI readonly runner gate the same way; the
  // write twin gates before token consumption.
  if (hasInjectableCredentials() === false) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error:
        'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files or the metadata chain.',
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
  if (name === 'huaweicloud_agentarts_browser_plan') return planAgentartsBrowserWrite(rawArgs);
  if (name === 'huaweicloud_agentarts_browser_write') return runAgentartsBrowserWrite(rawArgs);
  return { ok: false, error: `Unknown agentarts browser tool: ${name}` };
}

// ---------------------------------------------------------------------------
// WRITE bridge (B3): browser + profile resource lifecycle, token-gated
// like every approved cloud write in this repo. The canonical request
// carries ONLY non-secret parameters (names, ids, tags, region); AK/SK
// ride the child env exactly as the read bridge does.
//
// Plan-time credential-shape warning over description and tag values
// (the memory bridge's loud-storage pattern, browser-worded — R1 review
// round): browser descriptions/tags are display metadata, not a
// retrieval store like memory content, BUT the tag {key, value} JSON
// shape defeats the at-rest redactor's key[:=] adjacency, so a
// secret-shaped value riding tags lands UNMASKED in approvals.json
// (0600, 5-minute TTL). The warning is the only surface that flags it.

// Per-operation WRITE metadata (the memory bridge's registry pattern):
// labels on the plan/approval surface, replay guidance per op. A new
// write operation without an entry fails LOUDLY here — key parity with
// BROWSER_WRITE_OPERATIONS is pinned in structure.test.mjs.
const WRITE_OPERATION_META = {
  create_browser: { labels: [] },
  update_browser: { labels: [] },
  delete_browser: { labels: ['irreversible'] },
  create_browser_profile: { labels: [] },
  delete_browser_profile: { labels: ['irreversible'] },
};

const BROWSER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const API_KEY_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const BROWSER_WRITE_PARAM_KEYS = [
  'operation',
  'name',
  'auth_type',
  'api_key_name',
  'description',
  'browser_id',
  'profile_id',
  'tags',
  'region',
];

const BROWSER_WRITE_OP_APPLICABILITY = {
  create_browser: ['name', 'auth_type', 'api_key_name', 'description', 'tags'],
  update_browser: ['browser_id', 'tags'],
  delete_browser: ['browser_id'],
  create_browser_profile: ['name', 'description', 'tags'],
  delete_browser_profile: ['profile_id'],
};

function rejectUnknownWriteParams(params, operation) {
  const applicable = BROWSER_WRITE_OP_APPLICABILITY[operation] ?? [];
  for (const key of Object.keys(params)) {
    if (!BROWSER_WRITE_PARAM_KEYS.includes(key)) {
      return `Unknown parameter "${key}" — legal keys: ${BROWSER_WRITE_PARAM_KEYS.join(', ')}.`;
    }
    if (!['operation', 'region'].includes(key) && !applicable.includes(key)) {
      return `"${key}" is not a parameter of ${operation} — it would be silently ignored. Applicable keys for ${operation}: ${applicable.join(', ') || '(none beyond operation/region)'}.`;
    }
  }
  return null;
}

// Tags: max 20, unique keys, {key, value} string pairs (the SDK's own
// rules, BC:282-292). A malformed tag must fail at THIS boundary, not as
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

function validateBrowserWrite(params) {
  if (!BROWSER_WRITE_OPERATIONS.includes(params.operation)) {
    return `operation must be one of: ${BROWSER_WRITE_OPERATIONS.join(', ')}.`;
  }
  const unknown = rejectUnknownWriteParams(params, params.operation);
  if (unknown) return unknown;
  const need = (field, message) => {
    if (typeof params[field] !== 'string' || params[field].length === 0) return message;
    return null;
  };
  if (params.operation === 'create_browser' || params.operation === 'create_browser_profile') {
    const err = need(
      'name',
      `name is required for ${params.operation} (pattern ^[a-z][a-z0-9-]{0,38}[a-z0-9]$, 2-40 chars).`,
    );
    if (err) return err;
    if (!BROWSER_NAME_PATTERN.test(params.name)) {
      return `name must match ^[a-z][a-z0-9-]{0,38}[a-z0-9]$ — 2-40 chars, lowercase letters/digits/hyphens, start lowercase letter, end lowercase letter or digit.`;
    }
    if (
      params.description !== undefined &&
      params.description !== null &&
      (typeof params.description !== 'string' || params.description.length === 0)
    ) {
      return 'description must be a non-empty string when provided.';
    }
    // 4096 on BOTH create ops (R1 review round): the SDK docstring
    // documents the limit for browsers (browser_client.py:198-199) and
    // enforces it client-side for profiles (:614-617). The browser-side
    // server behavior is unmeasured, but the cost asymmetry favors the
    // boundary: a false rejection is a clear retry-with-shorter-text,
    // while a real server 400 burns a minted approval token.
    if (params.operation === 'create_browser' && params.description && params.description.length > 4096) {
      return 'description must be at most 4096 characters (the SDK documents this limit for browsers and enforces it client-side for profiles).';
    }
    if (params.operation === 'create_browser_profile' && params.description && params.description.length > 4096) {
      return 'description must be at most 4096 characters (SDK limit for profiles).';
    }
  }
  if (params.operation === 'create_browser') {
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
  if (params.operation === 'update_browser') {
    const err = need('browser_id', 'browser_id is required for update_browser.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.browser_id)) {
      return 'browser_id must be a valid UUID (the SDK validates the format client-side BEFORE any network call — a malformed id would consume the approval token on a guaranteed no-op).';
    }
    if (!Array.isArray(params.tags) || params.tags.length === 0) {
      return 'update_browser requires a non-empty tags array — tags are the only updatable field this bridge exposes (the SDK also updates observability, an opaque dict not exposed here). An update with nothing to update is rejected.';
    }
  }
  if (params.operation === 'delete_browser') {
    const err = need('browser_id', 'browser_id is required for delete_browser.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.browser_id)) {
      return 'browser_id must be a valid UUID (the SDK validates the format client-side BEFORE any network call — a malformed id would consume the approval token on a guaranteed no-op).';
    }
  }
  if (params.operation === 'delete_browser_profile') {
    const err = need('profile_id', 'profile_id is required for delete_browser_profile.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.profile_id)) {
      return 'profile_id must be a valid UUID (the SDK validates the format client-side BEFORE any network call — a malformed id would consume the approval token on a guaranteed no-op).';
    }
  }
  if (params.tags !== undefined && params.tags !== null) {
    if (!Array.isArray(params.tags)) return 'tags must be an array of {key, value} objects.';
    const tagError = validateTags(params.tags);
    if (tagError) return tagError;
  }
  if (params.region !== undefined && params.region !== null) {
    if (typeof params.region !== 'string' || params.region.length === 0) {
      return 'region must be a non-empty string when provided.';
    }
  }
  return null;
}

// The canonical request: plan and write build it from params the SAME
// way, so the approval token binds byte-identical JSON. create_browser
// canonicalizes auth_type=IAM when absent (the B1 verdict — the approval
// shows the EFFECTIVE request). Tags SORT by key (code-unit, not
// localeCompare — the token binds bytes and plan/write may run in
// different processes or locales); tag ORDER is semantically irrelevant,
// unlike memory's message order. An empty tags array is dropped (the
// SDK's `if tags:` treats [] as unset — the approval must show what
// executes).
function buildBrowserWriteRequest(params) {
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
  if (params.operation === 'create_browser') {
    request.name = params.name;
    request.auth_type = params.auth_type === 'API_KEY' ? 'API_KEY' : 'IAM';
    if (request.auth_type === 'API_KEY') request.api_key_name = params.api_key_name;
    if (typeof params.description === 'string' && params.description) request.description = params.description;
    const tags = canonicalTags(params.tags);
    if (tags) request.tags = tags;
  }
  if (params.operation === 'update_browser') {
    request.browser_id = params.browser_id;
    const tags = canonicalTags(params.tags);
    if (tags) request.tags = tags;
  }
  if (params.operation === 'delete_browser') request.browser_id = params.browser_id;
  if (params.operation === 'create_browser_profile') {
    request.name = params.name;
    if (typeof params.description === 'string' && params.description) request.description = params.description;
    const tags = canonicalTags(params.tags);
    if (tags) request.tags = tags;
  }
  if (params.operation === 'delete_browser_profile') request.profile_id = params.profile_id;
  return request;
}

// Token namespace — distinct from the agentarts CLI and memory namespaces
// so a CLI or memory token can never authorize a browser write (and vice
// versa). The request JSON carries no secrets; hash-exact binding is the
// whole check.
const BROWSER_WRITE_TOKEN_CLI = 'agentarts-browser-sdk';

export function planAgentartsBrowserWrite(params = {}) {
  const invalid = validateBrowserWrite(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation || '(unknown)'} (SDK control plane)`,
      error: invalid,
    };
  }
  const request = buildBrowserWriteRequest(params);
  const approvalToken = createApprovalTokenStore(BROWSER_WRITE_TOKEN_CLI).create([JSON.stringify(request)]);
  // Loud-storage warning (R1 review round, restored from the memory
  // bridge's pattern with browser wording): the tag {key, value} shape
  // puts a credential-shaped NAME and its VALUE in separate JSON keys,
  // so neither redactSecrets' key[:=]-adjacency nor the approvals-store
  // scrub can mask them at rest — the warning is the only surface that
  // flags a secret riding tags or description into approvals.json.
  // Detection covers BOTH halves: a secret-shaped tag KEY (password/
  // token/api_key/… — the shape the at-rest redactor cannot see) and
  // credential-shaped free text in tag values or description.
  const warnings = [];
  // Bare-token prefixes (R2): a pasted AK or token as a bare tag VALUE under
  // an innocuous key rides at rest unflagged — redactCredentialShapes only
  // matches key[:=]-adjacent shapes, and the at-rest redactor has no
  // bare-token pattern at all. Scoped to this warning deliberately: the
  // global redactor over-redacting general text is a tradeoff this module
  // does not make for the whole repo.
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
  // No ?? fallback (the memory bridge's round-3 rule): a write operation
  // added to the enum without a meta entry must FAIL LOUDLY here. Key
  // parity with BROWSER_WRITE_OPERATIONS is pinned in structure.test.mjs.
  const meta = WRITE_OPERATION_META[params.operation];
  const labels = meta.labels;
  const labelSuffix = labels.length > 0 ? ` Labels: ${labels.join(', ')}.` : '';
  const authTypeNote =
    params.operation === 'create_browser'
      ? request.auth_type === 'IAM'
        ? ' auth_type defaults to IAM (canonicalized): the data plane signs with the same AK/SK this toolkit injects — no further setup needed for sessions and actions.'
        : ' auth_type=API_KEY: the data plane will need the console api_key (HUAWEICLOUD_SDK_BROWSER_API_KEY) — the create response never returns the key value (trap 61).'
      : '';
  return {
    ok: true,
    service: 'AgentArts',
    tier: 'approved',
    operation: `browser ${params.operation} (SDK control plane; no CLI subcommand in 0.1.7)`,
    labels,
    warnings,
    request,
    approvalToken,
    approvalNote: `Present the request above to the user.${labelSuffix} On explicit approval, run huaweicloud_agentarts_browser_write with THIS approvalToken, the SAME parameters, and approvedByUser: true (the token binds them exactly); otherwise discard it.${authTypeNote}`,
  };
}

const BROWSER_WRITE_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk import Browser',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    # The request rides STDIN (the repo-wide rule): argv is process-list',
  '    # visible and a long description would hit the kernel argv limit.',
  '    params = json.loads(sys.stdin.read())',
  '    client = Browser(region=params["region"])',
  '    op = params["operation"]',
  '    if op == "create_browser":',
  '        kwargs = {"name": params["name"], "auth_type": params["auth_type"]}',
  '        if params.get("api_key_name"): kwargs["api_key_name"] = params["api_key_name"]',
  '        if params.get("description"): kwargs["description"] = params["description"]',
  '        if params.get("tags"): kwargs["tags"] = params["tags"]',
  '        result = client.create_browser(**kwargs)',
  '    elif op == "update_browser":',
  '        result = client.update_browser(params["browser_id"], tags=params["tags"])',
  '        if result is None:',
  '            # Empty-body 200 (R2): the SDK transport returns None when the',
  '            # response has no content — a SUCCESS misread as pollution by',
  '            # the envelope without this synthesis (the delete branches',
  '            # already synthesize for the same reason).',
  '            result = {"updated": True, "browser_id": params["browser_id"]}',
  '    elif op == "delete_browser":',
  '        client.delete_browser(params["browser_id"])',
  '        result = {"deleted": True, "browser_id": params["browser_id"]}',
  '    elif op == "create_browser_profile":',
  '        kwargs = {"name": params["name"]}',
  '        if params.get("description"): kwargs["description"] = params["description"]',
  '        if params.get("tags"): kwargs["tags"] = params["tags"]',
  '        result = client.create_browser_profile(**kwargs)',
  '    elif op == "delete_browser_profile":',
  '        client.delete_browser_profile(params["profile_id"])',
  '        result = {"deleted": True, "profile_id": params["profile_id"]}',
  '    else:',
  '        print("AGENTARTS_BROWSER_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  // SystemExit re-raise + BaseException catch: same as the read snippet
  // (SystemExit must not become "SystemExit: 2" with exit 1; the
  // bad-operation exit-2 path lives inside this try).
  'except SystemExit:',
  '    raise',
  // ToolsAPIError extends BaseException (tools_http.py:10) — same
  // deviation as the read snippet, same reason.
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
    operation === 'create_browser'
      ? 'huaweicloud_agentarts_browser_read (list_browsers by name)'
      : operation === 'update_browser' || operation === 'delete_browser'
        ? 'huaweicloud_agentarts_browser_read (get_browser per id — not-found on a delete means deleted; the update-family rule is success ≠ applied)'
        : 'huaweicloud_agentarts_browser_read (list_browser_profiles)';
  return `${prefix} Verify with ${verify} BEFORE re-planning anything.`;
}

// Write-side post-processing, composed around the envelope at the write
// call site (the memory bridge's symmetric extension point). Success
// notes teach the measured traps at the result surface; failure carries
// the burn disclosure. Notes describe the REQUEST semantics, not the
// response's field presence (R1 review round: an unconditional "in the
// result" claim breaks on SDK shape drift — the memory family gates its
// equivalents on parsed shape).
function enrichBrowserWrite(payload, params) {
  if (!payload.ok) {
    payload.error = `${payload.error || 'Execution failed.'} The single-use token was consumed by this attempt — re-plan for a retry.`;
    return payload;
  }
  const notes = [];
  if (params.operation === 'create_browser') {
    const authType = params.auth_type === 'API_KEY' ? 'API_KEY' : 'IAM';
    if (authType === 'API_KEY') {
      notes.push(
        'API_KEY-typed browser created: the data plane needs the console api_key (HUAWEICLOUD_SDK_BROWSER_API_KEY) — the create response never returns the key value (trap 61). Sessions and actions on this browser require that env var.',
      );
    }
    notes.push(
      'The create attaches the tenant-shared default gateway (persists across deletes — trap 63 family) and the response access_endpoint IS the data-plane base URL once https:// is prepended (trap 62).',
    );
  }
  if (params.operation === 'update_browser') {
    notes.push(
      'Verify with huaweicloud_agentarts_browser_read (get_browser): the update-family rule is success ≠ applied (measured on the sibling gateway family, trap 45) — the server may accept and silently drop fields.',
    );
  }
  if (params.operation === 'delete_browser' || params.operation === 'delete_browser_profile') {
    notes.push(
      'The delete returned before the list converged — a seconds-scale staleness window may still show the resource (trap 63). Poll list_browsers/list_browser_profiles to confirm deletion.',
    );
  }
  if (notes.length > 0) payload.notes = notes;
  return payload;
}

export async function runAgentartsBrowserWrite({ approvalToken, approvedByUser, ...params } = {}, options = {}) {
  const invalid = validateBrowserWrite(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation || '(unknown)'} (SDK control plane)`,
      error: invalid,
    };
  }
  // The repo's three-element approval contract: token + exact parameters +
  // the explicit attestation. Param validation runs FIRST (a pure data
  // error needs no attestation), the attestation throw second — the
  // memory bridge's deliberate ordering.
  if (approvedByUser !== true) {
    throw new Error(
      'approvedByUser must be true after explicit user approval of the plan request — run huaweicloud_agentarts_browser_plan, present the request to the user, and only then execute with the token.',
    );
  }
  if (typeof approvalToken !== 'string' || !approvalToken) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error:
        'approvalToken is required — run huaweicloud_agentarts_browser_plan first, present the request to the user, and pass the token plus the SAME parameters here on explicit approval.',
    };
  }
  const store = createApprovalTokenStore(BROWSER_WRITE_TOKEN_CLI);
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
      operation: `browser ${params.operation} (SDK control plane)`,
      error: 'approvalToken expired — re-plan with huaweicloud_agentarts_browser_plan and get a fresh approval.',
    };
  }
  if (inspection.state === 'not_found') {
    return {
      ok: false,
      status: 'rejected',
      code: 'CONFIRM_TOKEN_NOT_FOUND',
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error:
        'approvalToken not found (never created, pruned after the TTL, or minted in a different namespace) — a token consumed long ago may have had its tombstone pruned, in which case the write may already have executed: verify with huaweicloud_agentarts_browser_read BEFORE re-planning anything.',
    };
  }
  const request = buildBrowserWriteRequest(params);
  const requestHash = hashNamespacedArgs(BROWSER_WRITE_TOKEN_CLI, [JSON.stringify(request)]);
  if (requestHash !== inspection.entry.argsHash) {
    return {
      ok: false,
      status: 'rejected',
      code: 'CONFIRM_TOKEN_MISMATCH',
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error:
        'approvalToken was minted for DIFFERENT parameters — the write binds the exact planned request. Re-plan with the changed parameters (the token stays valid for the original ones).',
    };
  }
  // Credentials BEFORE consumption (the CLI runner's order; the memory
  // bridge checks its key file here): the browser control plane needs
  // injectable AK/SK, and a missing-credential rejection must not burn
  // the approval on a guaranteed no-op spawn.
  if (hasInjectableCredentials() === false) {
    return {
      ok: false,
      status: 'rejected',
      code: 'NO_DEVKIT_CREDENTIALS',
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error:
        'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files or the metadata chain. The token was NOT consumed.',
    };
  }
  // Binding + credentials verified — consume (single-use tombstone) before
  // executing. The store write FAILS CLOSED (R2): a store that cannot
  // persist the tombstone must not let the write execute (a swallowed
  // failure used to report consume-success without the tombstone, and a
  // replay re-executed an approved write).
  let stored;
  try {
    stored = store.consume(approvalToken);
  } catch (error) {
    return {
      ok: false,
      status: 'rejected',
      code: 'TOKEN_STORE_UNWRITABLE',
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
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
      operation: `browser ${params.operation} (SDK control plane)`,
      error: 'approvalToken could not be consumed (raced and pruned?) — re-plan.',
    };
  }
  const childEnv = buildChildEnv({ injectCredentials: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVED_TIMEOUT_MS;
  const args = ['-c', BROWSER_WRITE_SNIPPET];
  const outcome = await runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: JSON.stringify(request),
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      return enrichBrowserWrite(shapeBrowserResult(result, candidate, params, timeoutMs, parsed), params);
    },
  });
  // Fallthrough honesty (the memory bridge's round-1/2 rule): when NO
  // python candidate could run the SDK, the generic install remediation
  // comes back marked unshaped: true — shapeResult never ran, so the
  // consumed-token disclosure must come from here.
  if (!outcome.ok && outcome.unshaped === true) {
    outcome.error = `${outcome.error} The single-use approval token was already CONSUMED by this attempt and stays burned — after fixing the SDK install, re-plan (replaying this token returns already_processed without executing anything).`;
  }
  return outcome;
}
