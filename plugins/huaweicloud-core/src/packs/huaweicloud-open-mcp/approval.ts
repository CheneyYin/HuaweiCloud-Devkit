import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isInsideProtectedTree, packStateDir } from '../../lib/pack-state.ts';
import { classifyTextCommand } from '../../safety-policy.ts';
import { POLICY_FILE } from './sidecar.ts';

// The gateway_call approval boundary: a pure decision table over (tool,
// toolArgs, mode, live surface) plus the operator-policy reader behind the
// devkit-mode execute_api pre-check. The table is the whole agent-facing
// classification vocabulary for this pack — every state-changing gateway
// tool routes through it, so the deny semantics live in one place instead
// of scattered conditionals in the handler.
//
// Modes: 'devkit' routes every state-changing call through the plan-run
// approval token (this pack's share of the consent authority the CLI face
// established); 'native' delegates execute_api to the gateway's own policy
// engine, chosen by an operator who manages consent in the policy file
// directly. Mode resolution is call-time validation, deliberately NOT
// wired into createDevkitMcpServer: the protocol layer stays
// pack-agnostic, and a bad value surfaces as an actionable tool error
// instead of a failed boot.

export type ApprovalMode = 'devkit' | 'native';
export type Verdict = 'passthrough' | 'token' | 'deny';

export interface Ruling {
  verdict: Verdict;
  /** Populated for deny: actionable, names the violated boundary. */
  reason?: string;
}

export function resolveApprovalMode(env: NodeJS.ProcessEnv = process.env): ApprovalMode {
  const value = (env.HUAWEICLOUD_OPENMCP_APPROVAL ?? '').trim();
  if (value === '' || value === 'devkit') return 'devkit';
  if (value === 'native') return 'native';
  throw new Error(
    `HUAWEICLOUD_OPENMCP_APPROVAL "${value}" is not a valid gateway approval mode. Supported: devkit, native.`,
  );
}

const READONLY_TOOLS = new Set([
  'search_apis',
  'list_products',
  'get_product',
  'list_apis',
  'get_api',
  'get_api_examples',
]);

// The only scopes an agent may buy with a token: every one of them dies
// with the process or the clock. An allow-list, not a deny-list of known
// persistent spellings — round-4 probed 'PERMANENT', 'permanent ', and
// unknown scopes all falling through to token, buying an eternal grant.
const EPHEMERAL_SCOPES = new Set(['once', 'session', 'temporary']);

// Permanent grants are the one policy mutation the token can never buy: a
// permanent allow outlives every consent boundary this devkit enforces, so
// it stays an operator gesture against the file itself.
function permanentGrantReason(): string {
  const operatorPath = (process.env.HUAWEICLOUD_MCP_POLICY_FILE ?? '').trim();
  const path = operatorPath !== '' ? operatorPath : join(packStateDir('huaweicloud-open-mcp'), POLICY_FILE);
  return `permanent-scope grants are an operator gesture, not an agent action: edit the policy file directly (${path}); it hot-reloads, so the change takes effect without a restart`;
}

export function classify(
  tool: string,
  toolArgs: Record<string, unknown>,
  mode: ApprovalMode,
  surface: ReadonlySet<string> | null,
): Ruling {
  if (READONLY_TOOLS.has(tool)) return { verdict: 'passthrough' };

  // Drift gate for every non-read-only tool, before any branch routing:
  // a tool the live child no longer exposes is denied without spending
  // consent, whichever branch would have handled it. Read-only names skip
  // the gate — a missing discovery tool fails harmlessly at the gateway
  // and never costs a token.
  if (surface !== null && !surface.has(tool)) {
    return {
      verdict: 'deny',
      reason: `the gateway child's live tool surface no longer exposes ${tool} (drift); do not spend user consent on a call that cannot succeed`,
    };
  }

  if (tool === 'manage_policy') {
    // Action allow-list, the same construction as the scope allow-list
    // below: 'ADD'/' add '/['add'] previously fell through to token,
    // leaving scope admission dependent on the gateway being
    // spelling-stricter than the classifier (round-6).
    const action = typeof toolArgs.action === 'string' ? toolArgs.action.trim().toLowerCase() : '';
    if (action === 'list') return { verdict: 'passthrough' };
    if (action !== 'add' && action !== 'remove') {
      return {
        verdict: 'deny',
        reason: `manage_policy accepts only list, add, and remove through this face (got ${JSON.stringify(toolArgs.action)}).`,
      };
    }
    if (action === 'add') {
      // Normalized allow-list: unknown, missing, or persistent spellings
      // all deny. Non-string scopes deny too — String(['once']) stringifies
      // to 'once' and would slip a gate that only lowercases. The gateway's
      // own documented default for an omitted scope is session, but this
      // face demands the scope explicitly so the failure direction never
      // depends on gateway defaults.
      const rawScope = toolArgs.scope;
      const scope = typeof rawScope === 'string' ? rawScope.trim().toLowerCase() : '';
      if (EPHEMERAL_SCOPES.has(scope)) return { verdict: 'token' };
      return {
        verdict: 'deny',
        reason: `manage_policy add accepts only the ephemeral scopes (${[...EPHEMERAL_SCOPES].join(', ')}) through this face; pass one explicitly. ${permanentGrantReason()}`,
      };
    }
    // remove: the gateway REJECTS remove with a scope (manage_policy_ops:
    // "remove 不接受 scope/ttl_seconds 参数") — a token-gated remove+scope
    // would burn the approval on a guaranteed gateway rejection (round-8,
    // the same class as the 'ADD' forwarding gap). The token binds the
    // exact rule text the user sees.
    if (toolArgs.scope !== undefined && toolArgs.scope !== null) {
      return {
        verdict: 'deny',
        reason:
          'manage_policy remove takes no scope: removal is cross-layer by line, and the gateway rejects a scoped remove outright.',
      };
    }
    return { verdict: 'token' };
  }

  if (tool === 'execute_api') {
    // Hard, both modes: the hcloud secret rules encode which operations
    // must never surface plaintext in the agent context, and no gateway
    // policy setting can widen that.
    const secretCheck = classifyTextCommand(`hcloud ${toolArgs.product} ${toolArgs.api}`);
    if (secretCheck.risk === 'secret') return { verdict: 'deny', reason: secretCheck.reason };
    if (mode === 'native') return { verdict: 'passthrough' };
    return { verdict: 'token' };
  }

  if (tool === 'query_data' || tool === 'transform_data') {
    const violation = localFileTargetViolation(toolArgs);
    if (violation) return { verdict: 'deny', reason: violation };
    return { verdict: 'token' };
  }

  // Unknown tools: fail closed — no free pass on ignorance.
  return { verdict: 'token' };
}

// The local-file boundary for the data tools: every structured path field
// the gateway resolves (out.path, tables.*.path) crosses the protected
// tree check, and every path-like string value anywhere in the arguments
// crosses the CLI face's own credential patterns. Raw values are walked,
// never JSON.stringify: serialization doubles backslashes, defeating
// single-separator patterns on Windows paths (round-5 probe). A seen-set
// bounds the walk instead. Path-like means the value contains a separator
// — the whole value is the candidate and is a superset of any literal
// inside it (the patterns are unanchored substrings, so classifying the
// whole subsumes classifying any fragment; a separate literal-extraction
// pass changed no verdict and was deleted, round-6). Each candidate is
// also matched in a backslash-collapsed variant: a value that is itself a
// JSON string (read_json('{"path":"C:\\\\hcloud\\\\config"}')) carries
// the doubling in memory, and collapsing it restores the single separator
// the patterns require. Residual: non-credential protected paths written
// as SQL literals are not caught by the scan (the structured fields are,
// via the tree check).
function localFileTargetViolation(toolArgs: Record<string, unknown>): string | null {
  const targets: string[] = [];
  const out = toolArgs.out;
  if (out !== null && typeof out === 'object' && !Array.isArray(out)) {
    const outPath = (out as Record<string, unknown>).path;
    if (typeof outPath === 'string') targets.push(outPath);
  }
  const tables = toolArgs.tables;
  if (tables !== null && typeof tables === 'object' && !Array.isArray(tables)) {
    for (const entry of Object.values(tables as Record<string, unknown>)) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const entryPath = (entry as Record<string, unknown>).path;
        if (typeof entryPath === 'string') targets.push(entryPath);
      }
    }
  }
  for (const target of targets) {
    if (isInsideProtectedTree(target)) {
      return `file targets inside devkit consent infrastructure are blocked (${target} resolves inside the protected state tree)`;
    }
  }
  const candidates = new Set<string>();
  collectPathLikeStrings(toolArgs, candidates);
  for (const candidate of candidates) {
    for (const variant of [candidate, candidate.replace(/\\\\/g, '\\')]) {
      const ruling = classifyTextCommand(variant);
      if (ruling.risk === 'credential') {
        return `${ruling.reason || 'Reading Huawei Cloud credential or profile files is blocked.'} Matched the path-like token "${variant}" in the tool arguments; the scan deliberately over-denies, so a benign mention of the same name is refused too.`;
      }
    }
  }
  return null;
}

// Whole string values that contain a path separator. The seen-set makes
// pathological (circular) inputs terminate instead of throwing — classify
// must never reject, only rule.
function collectPathLikeStrings(value: unknown, out: Set<string>, seen = new Set<unknown>()): void {
  if (typeof value === 'string') {
    if (/[\\/]/.test(value)) out.add(value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectPathLikeStrings(child, out, seen);
  }
}

// Operator policy reader for the devkit-mode execute_api pre-check: the
// LIVE file, not a spawn-time snapshot, so an operator edit between mint
// and replay is honored. Resolution mirrors the sidecar's pin-unless-env
// spawn policy: the operator's HUAWEICLOUD_MCP_POLICY_FILE when set, else
// the devkit-provisioned pack state file.
function operatorPolicyPath(env: NodeJS.ProcessEnv): string {
  const operatorPath = (env.HUAWEICLOUD_MCP_POLICY_FILE ?? '').trim();
  return operatorPath !== '' ? operatorPath : join(packStateDir('huaweicloud-open-mcp', env), POLICY_FILE);
}

// The gateway's rule-line semantics, mirrored from safety/policy.py
// parse_policy + policy_store._rule_key (source-verified rounds 7-8):
// strip, drop only WHOLE-LINE '#' comments and blanks (inline '#' is part
// of the action gateway-side — parse_policy raises on it, verified by
// running the installed module), rpartition on '=', action must be
// allow/deny, target partitioned on the FIRST ':', each side
// stripped-or-'*', a colon-less non-'*' product target is a parse
// failure (the gateway raises), server: prefix is out of scope for this
// face. Parse failures are their own kind here: matchingDenyRule treats
// them as fail-closed denials, ruleSemanticKey maps them per-line so
// mangled lines never collide with each other (round-8: the shared
// wildcard sentinel made every redaction-mangled rule one key, so
// unrelated token-suffixed rules cross-conflicted).
type ParsedLine =
  | { kind: 'rule'; product: string; apiPattern: string; allow: boolean }
  | { kind: 'server' }
  | { kind: 'unparseable' }
  | null;

function parseRuleLine(rawLine: string): ParsedLine {
  const text = rawLine.trim();
  if (text === '' || text.startsWith('#')) return null;
  const effectIndex = text.lastIndexOf('=');
  if (effectIndex < 0) return { kind: 'unparseable' };
  const effect = text
    .slice(effectIndex + 1)
    .trim()
    .toLowerCase();
  if (effect !== 'allow' && effect !== 'deny') return { kind: 'unparseable' };
  const target = text.slice(0, effectIndex).trim();
  if (target.startsWith('server:')) return { kind: 'server' };
  const separator = target.indexOf(':');
  if (separator < 0 && target !== '*') return { kind: 'unparseable' };
  const product = (separator < 0 ? '*' : target.slice(0, separator)).trim() || '*';
  const apiPattern = (separator < 0 ? '*' : target.slice(separator + 1)).trim() || '*';
  return { kind: 'rule', product, apiPattern, allow: effect === 'allow' };
}

// fnmatch translation, the gateway's matcher (safety/policy.py uses
// fnmatch.fnmatch case-insensitively): '*' → '.*', '?' → '.', classes
// are TRANSLATED per fnmatch.translate — '!' right after '[' negates,
// ']' right after '[' or '[!' is literal, '^' at class start is literal
// (only '!' negates), '\' is escaped, an unterminated '[' is literal.
// Round-8: the passthrough version made '[!A]' a positive JS class of
// '!'|'A' — operator denies with negation were invisible to the pre-check
// while the gateway enforced them (probe: both directions wrong), and a
// backslash inside a class produced an unterminated JS class that threw
// out of the pre-check entirely. The whole construction is guarded: an
// untranslatable pattern falls back to literal matching.
function fnmatchRegex(pattern: string): RegExp {
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

// The gateway's evaluate is exact-or-'*' on the PRODUCT side (only the
// api pattern goes through fnmatch — safety/policy.py: rule.product !=
// '*' and rule.product.lower() != product.lower()). Mirroring that
// exactly: a product pattern like 'EC?' never matches ECS here, same as
// gateway-side.
function productMatches(side: string, product: string): boolean {
  return side === '*' || side.toLowerCase() === product.toLowerCase();
}

function sideMatches(side: string, value: string): boolean {
  return fnmatchRegex(side).test(value);
}

export interface DenialMatch {
  line: string;
  /** The line is one the gateway itself cannot load (parse failure) — the message must say so, not blame an operator deny. */
  unparseable: boolean;
}

export function matchingDenyRule(
  product: string,
  api: string,
  env: NodeJS.ProcessEnv = process.env,
): DenialMatch | null {
  let lines: string[];
  try {
    const text = readFileSync(operatorPolicyPath(env), 'utf8');
    const trimmed = text.trim();
    if (trimmed === '') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      // Plain-text lines, the gateway's tolerance for hand-edited files.
      lines = trimmed
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    } else if (Array.isArray(parsed)) {
      lines = parsed.filter((line): line is string => typeof line === 'string');
    } else {
      // JSON, but not a rule list (an object, a bare number): nothing to read.
      return null;
    }
  } catch {
    // Missing or unreadable: no operator denial to enforce.
    return null;
  }
  // Deliberately stricter than the gateway's first-match resolution: an
  // allow line earlier in the file wins gateway-side, but a matching deny
  // wins here regardless of position. Operator intent to deny must not be
  // neutralized by line ordering. Unparseable lines deny everything
  // (fail-closed): gateway-side the store keeps its last valid version
  // when a line fails to parse, so the operator's file is inert until
  // fixed — refusing here surfaces the broken file instead of silently
  // trusting the stale rules.
  for (const rawLine of lines) {
    const rule = parseRuleLine(rawLine);
    if (rule?.kind === 'server') continue; // out of scope for this face
    if (rule === null) continue; // blank or whole-line comment
    if (rule.kind === 'unparseable') return { line: rawLine.trim(), unparseable: true };
    if (rule.allow) continue;
    if (productMatches(rule.product, product) && sideMatches(rule.apiPattern, api)) {
      return { line: rawLine.trim(), unparseable: false };
    }
  }
  return null;
}

// The gateway's semantic rule key (policy_store._rule_key): rules equal
// under this key are interchangeable to the gateway's add/remove/evaluate,
// regardless of spacing or case in the source line. Exported for the
// bridge's conflict check, which must see conflicts the gateway's remove
// would act on. Unparseable and server lines map to per-line unique keys:
// they can never equal a product grant key, and two DIFFERENT mangled
// lines never collide with each other (round-8: the shared sentinel key
// made every redaction-mangled rule equivalent, so an unrelated
// token-suffixed rule falsely conflicted with the bridge).
export function ruleSemanticKey(rawLine: string): string {
  const rule = parseRuleLine(rawLine);
  if (rule === null) return `empty:${rawLine.trim().toLowerCase()}`;
  if (rule.kind === 'server') return `server:${rawLine.trim().toLowerCase()}`;
  if (rule.kind === 'unparseable') return `unparseable:${rawLine.trim().toLowerCase()}`;
  return `${rule.product.toLowerCase()}::${rule.apiPattern.toLowerCase()}::${rule.allow ? 'allow' : 'deny'}`;
}
