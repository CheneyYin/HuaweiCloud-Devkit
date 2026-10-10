// The gateway's policy-line grammar, mirrored from safety/policy.py
// parse_policy + policy_store._rule_key (source-verified rounds 7-8).
// Extracted from packs/huaweicloud-open-mcp/approval.ts so the grammar
// core is lib-layer (zero dependencies, pack-importable) and the fixture
// mirror has ONE authoritative counterpart — structure.test drives both
// implementations against the same line corpus and asserts identical
// semantic keys, so the .mjs copy cannot drift silently.
//
// Semantics: strip, drop only WHOLE-LINE '#' comments and blanks (inline
// '#' is part of the action gateway-side — parse_policy raises on it),
// rpartition on '=', action must be allow/deny, target partitioned on
// the FIRST ':', each side stripped-or-'*', a colon-less non-'*' product
// target is a parse failure (the gateway raises), server: prefix is out
// of scope for this face. Parse failures are their own kind:
// matchingDenyRule treats them as fail-closed denials, ruleSemanticKey
// maps them per-line so mangled lines never collide with each other.

export type ParsedLine =
  | { kind: 'rule'; product: string; apiPattern: string; allow: boolean }
  | { kind: 'server' }
  | { kind: 'unparseable' }
  | null;

export function parseRuleLine(rawLine: string): ParsedLine {
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
// fnmatch.fnmatch case-insensitively): '*' → '.*', '?' → '.', classes are
// TRANSLATED per fnmatch.translate — '!' right after '[' negates, ']'
// right after '[' or '[!' is literal, '^' at class start is literal (only
// '!' negates), '\' is escaped, an unterminated '[' is literal. The whole
// construction is guarded: an untranslatable pattern falls back to literal
// matching.
export function fnmatchRegex(pattern: string): RegExp {
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
// api pattern goes through fnmatch).
export function productMatches(side: string, product: string): boolean {
  return side === '*' || side.toLowerCase() === product.toLowerCase();
}

export function sideMatches(side: string, value: string): boolean {
  return fnmatchRegex(side).test(value);
}

// The gateway's semantic rule key (policy_store._rule_key): rules equal
// under this key are interchangeable to the gateway's
// add/remove/evaluate, regardless of spacing or case in the source line.
// Unparseable and server lines map to per-line unique keys: they can
// never equal a product grant key, and two DIFFERENT mangled lines never
// collide with each other.
export function ruleSemanticKey(rawLine: string): string {
  const rule = parseRuleLine(rawLine);
  if (rule === null) return `empty:${rawLine.trim().toLowerCase()}`;
  if (rule.kind === 'server') return `server:${rawLine.trim().toLowerCase()}`;
  if (rule.kind === 'unparseable') return `unparseable:${rawLine.trim().toLowerCase()}`;
  return `${rule.product.toLowerCase()}::${rule.apiPattern.toLowerCase()}::${rule.allow ? 'allow' : 'deny'}`;
}
