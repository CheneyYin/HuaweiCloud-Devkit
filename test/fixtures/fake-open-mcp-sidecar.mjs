#!/usr/bin/env node
// Minimal newline-JSON-RPC MCP server standing in for the real
// huaweicloud-open-mcp gateway in the open-mcp-pack tests. Known tools echo
// their arguments as structuredContent (the branch the REAL gateway's
// successful calls always take — its SDK derives structuredContent from the
// return annotations) plus a content-text mirror. Three synthetic tools pin
// the remaining normalization branches, and FAKE_FAIL_HANDSHAKE=1 makes
// initialize answer with a JSON-RPC error to exercise the spawn-failure
// path. Exits on stdin EOF, which is exactly the parent-death semantics the
// real gateway's stdio transport has and the sidecar lifetime contract
// depends on.
//
// Drift/policy knobs (read from the inherited env, so set them before the
// spawn that must see them):
//   FAKE_POLICY=1              adds execute_api, manage_policy, query_data
//                              and transform_data to both tools/list and the
//                              callable set, with policy-lite semantics:
//                              manage_policy keeps an in-memory {line, scope}
//                              rules array (no TTL/burn logic here — once
//                              burns happen on execute), execute_api finds a
//                              rule whose both sides wildcard-match and burns
//                              it when its scope is 'once', refusing with the
//                              gateway's envelope-failure shape otherwise.
//   FAKE_HIDE_TOOLS=a,b        removes those names from both tools/list and
//                              the callable set (drift-degrade tests).
//   FAKE_HIDE_CALLABLE=a,b     removes those names from the callable set
//                              ONLY (the surface cache still lists them —
//                              drives listing-failure paths past the drift
//                              gate).
//   FAKE_REFUSE_EXECUTE=1      execute_api always answers with the
//                              safety-policy refusal, even when a matching
//                              rule exists (bridge double-refusal tests).
//   FAKE_BROKEN_EXECUTE=1      execute_api answers a non-refusal failure
//                              (bridge must not re-send unknown-state
//                              failures).
//   FAKE_FAIL_LIST_ONCE=1      the first tools/list answers a JSON-RPC
//                              error, later ones succeed (write-through
//                              tests: the spawn cache stays null).
//   json_error_tool            echoes its arguments as JSON inside an
//                              isError envelope (redaction shape).
const CORE_TOOLS = [
  'search_apis',
  'list_products',
  'get_product',
  'list_apis',
  'get_api',
  'get_api_examples',
  'failing_tool',
  'envelope_fail_tool',
  'raw_text_tool',
  'json_error_tool',
];
const POLICY_TOOLS = ['execute_api', 'manage_policy', 'query_data', 'transform_data'];
const rules = [];
let executeAttempts = 0;
let listFailedOnce = false;
let buffer = '';

function gatewayToolNames() {
  const names = [...CORE_TOOLS];
  if (process.env.FAKE_POLICY === '1') names.push(...POLICY_TOOLS);
  const hidden = new Set(
    (process.env.FAKE_HIDE_TOOLS ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  return names.filter((name) => !hidden.has(name));
}

function callableToolNames() {
  const hidden = new Set(
    (process.env.FAKE_HIDE_CALLABLE ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  return gatewayToolNames().filter((name) => !hidden.has(name));
}

// fnmatch translation, a verbatim mirror of fnmatchRegex in
// src/lib/policy-grammar.ts (the .mjs fixture cannot import the .ts lib).
// structure.test's lockstep check drives both implementations over a
// shared corpus and asserts identical equivalence classes — edit both
// together or the lockstep test goes red. Class translation per
// fnmatch.translate: '!' after '[' negates, ']' right after '[' or '[!'
// is literal, '\' escaped, unterminated '[' literal, guarded construction
// with literal fallback.
function fnmatchRegex(pattern) {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') out += '.*';
    else if (char === '?') out += '.';
    else if (char === '[') {
      let cursor = index + 1;
      let negated = false;
      if (pattern[cursor] === '!') {
        negated = true;
        cursor += 1;
      }
      const close = pattern.indexOf(']', cursor);
      if (close < 0) {
        out += '\\[';
      } else {
        let body = pattern.slice(cursor, close).replace(/\\/g, '\\\\');
        if (body.startsWith(']')) body = `\\]${body.slice(1)}`;
        if (body.startsWith('^')) body = `\\^${body.slice(1)}`;
        out += `[${negated ? '^' : ''}${body}]`;
        index = close;
      }
    } else out += char.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${out}$`, 'i');
  } catch {
    return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  }
}

// The gateway's evaluate is exact-or-'*' on the PRODUCT side; only the api
// pattern goes through fnmatch (mirror of productMatches in approval.ts).
function productMatches(side, product) {
  return side === '*' || side.toLowerCase() === product.toLowerCase();
}

function sideMatches(side, value) {
  return fnmatchRegex(side).test(value);
}

// File-layer mirror (FAKE_POLICY_FILE): the real gateway resolves its
// policy file from --policy; this fixture reuses that argv entry when the
// env points a test at a specific file, so file-layer conflicts and
// removes run against real bytes instead of the in-memory overlay alone.
const fs = await import('node:fs');
function policyFilePath() {
  if (process.env.FAKE_POLICY_FILE) return process.env.FAKE_POLICY_FILE;
  const index = process.argv.indexOf('--policy');
  return index >= 0 ? process.argv[index + 1] : null;
}
function readFileText() {
  const path = policyFilePath();
  if (!path) return '';
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
function fileLines() {
  return readFileText()
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && !entry.startsWith('#'));
}
function writeFileLines(lines) {
  const path = policyFilePath();
  if (!path) return;
  fs.writeFileSync(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
}

// The fixture's execute-path matching, routed through the SHARED
// semantic surface (round-11: the previous inline lastIndexOf/split copy
// was effect-blind — a deny line could authorize an execute — and
// skipped the per-side trim the gateway's parse_policy applies). The
// gateway's evaluate is FIRST-MATCH-WINS over side-matching lines: the
// first line whose sides match decides, and a deny there refuses (the
// probe must not skip past a matching deny to a later allow).
function sideMatchOf(line, product, api) {
  const key = semanticKeyOf(line);
  if (key.startsWith('empty:') || key.startsWith('unparseable:') || key.startsWith('server:')) return null;
  const eq = key.lastIndexOf('::');
  const effect = key.slice(eq + 2);
  const [productSide, apiPattern] = key.slice(0, eq).split('::');
  if (!productMatches(productSide, product) || !sideMatches(apiPattern, api)) return null;
  return effect === 'allow';
}

function matchingRule(product, api) {
  const hit = rules.find((rule) => sideMatchOf(rule.line, product, api) !== null);
  return hit === undefined ? undefined : { ...hit, grants: sideMatchOf(hit.line, product, api) === true };
}

// File-layer rule match for execute (the real gateway evaluates the
// overlay ++ file rules as one ordered set; the file layer grants with
// scope 'permanent' semantics and never burns). First-match-wins with
// the same effect discipline.
function matchingFileRule(product, api) {
  const file = fileLines().find((fileLine) => sideMatchOf(fileLine, product, api) !== null);
  if (file === undefined) return null;
  return { line: file, scope: 'permanent', grants: sideMatchOf(file, product, api) === true };
}

// The grammar surface this fixture mirrors from lib/policy-grammar.ts —
// exported for the structure.test lockstep check (FAKE_GRAMMAR_ONLY=1
// imports this module without starting the stdio server below).
export const grammar = { fnmatchRegex, productMatches, sideMatches, semanticKey: (text) => semanticKeyOf(text) };

// The fixture's mirror of ruleSemanticKey (lib/policy-grammar.ts): the
// SAME prefixed per-line keys — empty:/unparseable:/server: for the
// non-rule kinds, product::pattern::effect for rules — so the lockstep
// test asserts per-line key EQUALITY (round-11: the equivalence-class
// comparison was blind to parse-kind divergence for singleton classes).
function semanticKeyOf(text) {
  const stripped = String(text).trim();
  if (stripped === '' || stripped.startsWith('#')) return `empty:${stripped.toLowerCase()}`;
  const eq = stripped.lastIndexOf('=');
  const effect =
    eq < 0
      ? ''
      : stripped
          .slice(eq + 1)
          .trim()
          .toLowerCase();
  if (effect !== 'allow' && effect !== 'deny') return `unparseable:${stripped.toLowerCase()}`;
  const target = stripped.slice(0, eq).trim();
  if (target.startsWith('server:')) return `server:${stripped.toLowerCase()}`;
  const colon = target.indexOf(':');
  if (colon < 0 && target !== '*') return `unparseable:${stripped.toLowerCase()}`;
  const product = (colon < 0 ? '*' : target.slice(0, colon)).trim() || '*';
  const apiPattern = (colon < 0 ? '*' : target.slice(colon + 1)).trim() || '*';
  return `${product.toLowerCase()}::${apiPattern.toLowerCase()}::${effect}`;
}

if (process.env.FAKE_GRAMMAR_ONLY !== '1') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleLine(line);
      newline = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function respond(id, payload) {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    },
  });
}

function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === 'initialize') {
    if (process.env.FAKE_FAIL_HANDSHAKE === '1') {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fake handshake failure' } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
        capabilities: {},
        serverInfo: { name: 'fake-open-mcp-sidecar', version: '0.0.0' },
      },
    });
  } else if (request.method === 'tools/list') {
    // FAKE_FAIL_LIST_ONCE: the first tools/list answers a JSON-RPC error.
    // The spawn path swallows it (advisory cache stays null); a later
    // gateway_list_tools succeeds and its write-through is then the only
    // thing that can populate the classifier's cache.
    if (process.env.FAKE_FAIL_LIST_ONCE === '1' && !listFailedOnce) {
      listFailedOnce = true;
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fake tools/list failure' } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: gatewayToolNames().map((name) => ({
          name,
          description: `fake gateway tool: ${name}`,
          inputSchema: { type: 'object' },
        })),
      },
    });
  } else if (request.method === 'tools/call') {
    const name = request.params?.name;
    if (typeof name !== 'string' || !callableToolNames().includes(name)) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      return;
    }
    if (name === 'failing_tool') {
      // With arguments present, echo them as key=value text: validation
      // failures echo the offending input, and the error-path redaction
      // tests pin that shape. Empty arguments keep the fixed string so the
      // long-standing normalization assertions stay byte-identical.
      const args = request.params?.arguments ?? {};
      const entries = Object.entries(args);
      const text =
        entries.length === 0
          ? 'fake gateway tool failure'
          : `fake gateway tool failure ${entries.map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' ')}`;
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text }], isError: true },
      });
      return;
    }
    if (name === 'envelope_fail_tool') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'fake envelope failure' }) }],
          structuredContent: { ok: false, reason: 'fake envelope failure', tool: name },
          isError: false,
        },
      });
      return;
    }
    if (name === 'raw_text_tool') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: 'not json at all' }], isError: false },
      });
      return;
    }
    if (name === 'json_error_tool') {
      // Validation failures echo the offending input as JSON inside an
      // isError envelope: the strongest redaction shape (the object walk
      // applies only when the text parses).
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'validation failed', ...request.params?.arguments }) },
          ],
          isError: true,
        },
      });
      return;
    }
    if (name === 'manage_policy') {
      const args = request.params?.arguments ?? {};
      const line = String(args.line ?? '');
      // Action normalization, mirroring the devkit face: the fixture accepts
      // what classify accepts (case/whitespace variants) and routes them to
      // the canonical branch.
      const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : String(args.action ?? '');
      if (action === 'list') {
        // The real gateway's list shape (source-verified): the rules array
        // carries the overlay AND the file's semantic lines (scope
        // 'permanent'), the 'policy' text field carries the raw file
        // including comments. FAKE_POLICY_TEXT_ONLY=1 deliberately omits
        // the file lines from the array so tests prove the consumer reads
        // the text layer too — the real gateway reports both, this knob
        // is branch-coverage instrumentation only.
        const fileText = readFileText();
        const fileRows = fileLines().map((fileLine) => ({ line: fileLine, scope: 'permanent', expires_in: null }));
        respond(request.id, {
          ok: true,
          tool: name,
          action: 'list',
          policy: fileText,
          rules: [
            ...(process.env.FAKE_POLICY_TEXT_ONLY === '1' ? [] : fileRows),
            ...rules.map((rule) => ({ line: rule.line, scope: rule.scope, expires_in: null })),
          ],
        });
      } else if (action === 'add') {
        // The real gateway's add validates the line through parse_policy
        // and rejects unparseable ones outright (round-8 mirror); the
        // inline parser matches semanticKey below / parseRuleLine in
        // approval.ts. The scope is normalized on entry: the devkit face
        // binds and forwards the canonical spelling, and the burn check
        // compares normalized values only. The response echoes BOTH the
        // normalized form and the raw received value — tests assert the
        // devkit's forwarding against 'received', not against this
        // fixture's own normalization (which would be circular).
        // A line is addable iff its semantic key is a product RULE (the
        // gateway's parse_policy acceptance, mirrored via semanticKeyOf —
        // round-11: the separate parseKey copy is deleted; the shared
        // semantic surface is the single acceptance authority).
        const key = semanticKeyOf(line);
        if (key.startsWith('empty:') || key.startsWith('unparseable:') || key.startsWith('server:')) {
          respond(request.id, { ok: false, reason: `规则格式非法：${line}` });
          return;
        }
        const scope = typeof args.scope === 'string' ? args.scope.trim().toLowerCase() : null;
        rules.push({ line, scope });
        respond(request.id, {
          ok: true,
          tool: name,
          action: 'add',
          line,
          scope,
          received: { action: args.action, scope: args.scope ?? null },
        });
      } else if (action === 'remove') {
        // The real gateway's remove envelope (source-verified rounds 7-8):
        // a scoped remove is rejected outright ("remove 不接受
        // scope/ttl_seconds 参数"); an unparseable line is rejected
        // ("规则格式非法"); a valid line that matches nothing is rejected
        // ("未找到匹配的规则"); a hit removes by SEMANTIC key, overlay
        // first then file, so spacing/case variants do not protect a rule.
        // The inline key mirrors parseRuleLine in approval.ts (whole-line
        // comments only — inline '#' is part of the action; colon-less
        // non-'*' targets are parse failures).
        if (args.scope !== undefined && args.scope !== null) {
          respond(request.id, {
            ok: false,
            reason: 'remove 不接受 scope/ttl_seconds 参数（跨层匹配：先会话/临时后文件，首个语义命中移除）',
          });
          return;
        }
        const wanted = semanticKeyOf(line);
        if (wanted.startsWith('empty:') || wanted.startsWith('unparseable:') || wanted.startsWith('server:')) {
          respond(request.id, { ok: false, reason: `规则格式非法：${line}` });
          return;
        }
        let removed = false;
        // Overlay first, then the file layer — the real gateway's
        // cross-layer remove order.
        const index = rules.findIndex((rule) => semanticKeyOf(rule.line) === wanted);
        if (index >= 0) {
          rules.splice(index, 1);
          removed = true;
        } else {
          const file = fileLines();
          const fileIndex = file.findIndex((fileLine) => semanticKeyOf(fileLine) === wanted);
          if (fileIndex >= 0) {
            file.splice(fileIndex, 1);
            writeFileLines(file);
            removed = true;
          }
        }
        if (!removed) {
          respond(request.id, { ok: false, reason: `未找到匹配的规则：${line}` });
          return;
        }
        respond(request.id, { ok: true, tool: name, action: 'remove', line, removed: true });
      } else {
        respond(request.id, { ok: false, reason: `unsupported manage_policy action: ${args.action}` });
      }
      return;
    }
    if (name === 'execute_api') {
      const args = request.params?.arguments ?? {};
      const product = String(args.product ?? '');
      const api = String(args.api ?? '');
      // Per-child execute counter, echoed in every response: bridge tests
      // distinguish one forward from two by the attempt number.
      executeAttempts += 1;
      const attempt = executeAttempts;
      // FAKE_BROKEN_EXECUTE: a non-refusal failure (transport-level). The
      // bridge must NOT re-send these — the execution state is unknown —
      // so the test pins attempt === 1 on this path.
      if (process.env.FAKE_BROKEN_EXECUTE === '1') {
        respond(request.id, { ok: false, reason: `gateway exploded mid-call (attempt ${attempt})` });
        return;
      }
      // FAKE_REFUSE_EXECUTE forces the safety-policy refusal even when a
      // matching rule exists: the bridge-retry tests need a grant that
      // never executes, including after the re-add.
      if (process.env.FAKE_REFUSE_EXECUTE === '1') {
        respond(request.id, { ok: false, reason: `safety policy 拒绝执行 ${product}:${api} (attempt ${attempt})` });
        return;
      }
      const rule = matchingRule(product, api) ?? matchingFileRule(product, api);
      if (!rule || rule.grants !== true) {
        respond(request.id, { ok: false, reason: `safety policy 拒绝执行 ${product}:${api} (attempt ${attempt})` });
        return;
      }
      if (rule.scope === 'once') rules.splice(rules.indexOf(rule), 1);
      respond(request.id, { ok: true, tool: name, executed: { product, api }, attempt, pid: process.pid });
      return;
    }
    // query_data / transform_data fall through to the echo below, which
    // carries their arguments (transform_data's out.path included).
    const payload = {
      ok: true,
      tool: name,
      arguments: request.params?.arguments ?? {},
      pid: process.pid,
      // Spawn-introspection echo: tests assert the sidecar's pin-unless-env
      // arg policy (was --mode passed? was --policy passed?) and the scratch
      // cwd through the round trip, without any extra protocol surface.
      argv: process.argv,
      cwd: process.cwd(),
      env: {
        HUAWEICLOUD_MCP_MODE: process.env.HUAWEICLOUD_MCP_MODE ?? null,
        HUAWEICLOUD_MCP_POLICY_FILE: process.env.HUAWEICLOUD_MCP_POLICY_FILE ?? null,
        HUAWEICLOUD_MCP_AUDIT_FILE: process.env.HUAWEICLOUD_MCP_AUDIT_FILE ?? null,
      },
    };
    respond(request.id, payload);
  } else if (request.id !== undefined) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  }
}
