// The OpenCode ask-mode permission rule — pure merge/cleanup logic.
//
// Purpose: in the ASK approval posture (DEVKIT_APPROVAL_MODE=ask), the
// user's confirmation for an hcloud write is the harness client's own
// permission prompt on the huaweicloud_run_approved_command call — which
// only happens when the client is made to ASK for that tool. Measured on
// opencode 2.2.7: the V2 config key is a top-level `permissions` ARRAY of
// { action, resource, effect } objects; the MCP tool action is
// `<server>_<tool>`, and our server key is `huaweicloud-devkit`, so the
// action is `huaweicloud-devkit_huaweicloud_run_approved_command`; the
// config hot-reloads without restarting opencode; and a `deny` on that
// exact action prunes the tool from the live catalog (restored when the
// deny is removed) — which is also why an allow on it silently removes
// the gate. 2.2.7 still parses the V1 `permission` object the skills-tree
// seam writes (the bundle migrates it), but the array is the documented
// V2 shape — the V2 rule rides ONLY the array form.
//
// opencode 1.19.0–1.x alignment (the V1 `permission` object form):
// source-verified on the v1.19.0 tag — the same version the skills-tree
// seam measures, and the same knowledge boundary. mcp/catalog.ts toolName()
// builds the permission key as sanitize(server) + "_" + sanitize(tool),
// byte-identical to ASK_RULE_ACTION, so the constant is shared across
// shapes; session/tools.ts wraps EVERY mcp tool execute in
// ctx.ask({ permission: <toolName>, patterns: ["*"], always: ["*"] }), so
// runtime asks exist on the V1 line; permission/index.ts fromConfig()
// turns a bare string value under a key into { permission, pattern: "*",
// action: value }, and evaluate() is findLast (last matching rule wins)
// with "ask" as the no-match default — appending our key last beats any
// earlier user wildcard, mirroring V2's last-matching-rule-wins. A V1
// "Always allow" is session memory (an in-process approved array), not a
// persisted grant, so it dies with the process; the persistent-gate risk
// doctor fails is a config-file value, on either shape.
//
// Ownership rules: an entry on the ask action is user-owned by
// construction — add-only-if-absent (a pre-existing entry with ANY effect
// is the user's and survives the write; `skipped` reports it) and
// value-exact deletion (only the devkit-written shape is removed at
// uninstall) are the whole contract. The accepted edge is the same one
// the seam records: a user-authored same-shape rule that predates the
// write is removed together with it.
//
// This module is pure: no fs, no spawn, no console — opencode-config.ts
// owns I/O, the version probe, and logging; tests import these functions
// directly.

import { asRecord } from './as-record.ts';

export const ASK_RULE_ACTION = 'huaweicloud-devkit_huaweicloud_run_approved_command';
export const ASK_RULE_RESOURCE = '*';

export interface AskRuleApplyResult {
  changed: boolean;
  // True when nothing was written because the user owns the territory: an
  // entry on the ask action already exists (any effect — including one
  // identical to ours, indistinguishable from a pre-existing user rule),
  // or `permissions` is present but not an array.
  skipped: boolean;
}

function isRuleRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Mutates config in place. Fresh configs get the single-entry array;
// arrays without an entry on the ask action get ours APPENDED — OpenCode
// evaluates last-matching-rule-wins, so the appended entry is the
// effective one. Arrays that already carry an entry on the action, and
// non-array `permissions` shapes, are the user's: nothing is written.
export function applyAskPermissionRule(config: Record<string, unknown>): AskRuleApplyResult {
  if (config.permissions === undefined) {
    config.permissions = [{ action: ASK_RULE_ACTION, resource: ASK_RULE_RESOURCE, effect: 'ask' }];
    return { changed: true, skipped: false };
  }
  if (!Array.isArray(config.permissions)) {
    return { changed: false, skipped: true };
  }
  const rules: unknown[] = config.permissions;
  if (rules.some((rule) => isRuleRecord(rule) && rule.action === ASK_RULE_ACTION)) {
    return { changed: false, skipped: true };
  }
  rules.push({ action: ASK_RULE_ACTION, resource: ASK_RULE_RESOURCE, effect: 'ask' });
  return { changed: true, skipped: false };
}

// Mutates config in place. Value-exact deletion only — an entry matching
// action + resource '*' + effect 'ask' exactly is ours; a user-modified
// entry (any other effect or resource) survives. The array key is pruned
// only when OUR removals emptied it; a pre-existing empty array is left
// untouched. Returns whether anything changed.
export function removeAskPermissionRule(config: Record<string, unknown>): boolean {
  if (!Array.isArray(config.permissions)) return false;
  const rules: unknown[] = config.permissions;
  const kept = rules.filter(
    (rule) =>
      !(
        isRuleRecord(rule) &&
        rule.action === ASK_RULE_ACTION &&
        rule.resource === ASK_RULE_RESOURCE &&
        rule.effect === 'ask'
      ),
  );
  if (kept.length === rules.length) return false;
  if (kept.length === 0) {
    delete config.permissions;
  } else {
    config.permissions = kept;
  }
  return true;
}

// The effective posture of the ask action. OpenCode evaluates
// last-matching-rule-wins, so the LAST entry on the action is the
// effective one — read that, never the first. Returns its effect
// ('ask' / 'allow' / 'deny'), 'absent' when no entry matches (or the
// array is empty / the key is missing), and 'foreign' for an unreadable
// posture: `permissions` present but not an array, or the last matching
// entry carrying an effect outside the allow/ask/deny vocabulary.
export function inspectAskPermissionRule(
  config: Record<string, unknown>,
): 'ask' | 'allow' | 'deny' | 'absent' | 'foreign' {
  if (config.permissions === undefined) return 'absent';
  if (!Array.isArray(config.permissions)) return 'foreign';
  const rules: unknown[] = config.permissions;
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = asRecord(rules[i]);
    if (rule.action !== ASK_RULE_ACTION) continue;
    if (rule.effect === 'ask' || rule.effect === 'allow' || rule.effect === 'deny') {
      return rule.effect;
    }
    return 'foreign';
  }
  return 'absent';
}

// Floor check for the probe result: the `permissions` array is the
// documented V2 shape, measured on 2.2.7 only. Opencode major >= 2 (the
// anchored `v<major>.` form, mirroring opencodeSeamVersionSupported's
// extract-not-pass-raw polarity); null and unparsable output are
// unsupported — the caller's polarity is skip, keeping BOTH the terminal
// token gate and its mcp env untouched rather than guessing.
export function opencodeAskRuleVersionSupported(version: string | null): boolean {
  return askRuleShapeFor(version) === 'v2-array';
}

// ── V1: the `permission` object form (opencode 1.19.0 – 1.x) ──

// Mutates config in place. Fresh configs get the single-key permission
// object; object configs without the ask key get it APPENDED — V1's
// evaluate() is findLast over the fromConfig() ruleset, and Object.entries
// preserves insertion order, so the appended key is the effective one. A
// scalar-shaped `permission` (the user's global posture, e.g. "allow") and
// an existing key with ANY value are the user's: nothing is written.
export function applyAskPermissionRuleV1(config: Record<string, unknown>): AskRuleApplyResult {
  if (config.permission === undefined) {
    config.permission = { [ASK_RULE_ACTION]: 'ask' };
    return { changed: true, skipped: false };
  }
  if (!isRuleRecord(config.permission)) return { changed: false, skipped: true };
  const permission: Record<string, unknown> = config.permission;
  if (permission[ASK_RULE_ACTION] !== undefined) return { changed: false, skipped: true };
  permission[ASK_RULE_ACTION] = 'ask';
  return { changed: true, skipped: false };
}

// Mutates config in place. Value-exact deletion only — a key whose value is
// anything but the devkit-written 'ask' string survives (user-modified). The
// `permission` key is pruned only when OUR deletion emptied it; a
// pre-existing object with other keys is left untouched. Returns whether
// anything changed.
export function removeAskPermissionRuleV1(config: Record<string, unknown>): boolean {
  if (!isRuleRecord(config.permission)) return false;
  const permission: Record<string, unknown> = config.permission;
  if (permission[ASK_RULE_ACTION] !== 'ask') return false;
  delete permission[ASK_RULE_ACTION];
  if (Object.keys(permission).length === 0) delete config.permission;
  return true;
}

// The effective posture of the ask key on the V1 form. V1 keys carry either
// a bare effect string (readable: ask/allow/deny) or a pattern map (fromConfig
// spreads it into per-pattern rules — not a single-effect posture, so it
// reads as 'foreign', same polarity as the V2 unreadable shapes). Returns
// 'absent' when the key or the whole section is missing, and 'foreign' for a
// scalar-shaped `permission` (the user's global posture — the same skip
// polarity the skills-tree seam gives that shape).
export function inspectAskPermissionRuleV1(
  config: Record<string, unknown>,
): 'ask' | 'allow' | 'deny' | 'absent' | 'foreign' {
  if (config.permission === undefined) return 'absent';
  if (!isRuleRecord(config.permission)) return 'foreign';
  const value: unknown = config.permission[ASK_RULE_ACTION];
  if (value === undefined) return 'absent';
  if (value === 'ask' || value === 'allow' || value === 'deny') return value;
  return 'foreign';
}

// The ask-rule shape an opencode version carries. The V2 `permissions`
// array is measured on 2.2.7; the V1 `permission` object is source-verified
// on the v1.19.0 tag (mcp/catalog.ts names the run tool's permission key
// byte-identically to ASK_RULE_ACTION; session/tools.ts wraps every mcp
// tool execute in a runtime Permission.ask) — the same 1.19.0 knowledge
// boundary as the skills-tree seam (lib/opencode-permission-seam.ts).
// Earlier or unparsable versions are unsupported: neither half of the
// posture is written (the pair must move together — see
// docs/plan-run-approval-contract.md).
export type AskRuleShape = 'v2-array' | 'v1-object' | 'unsupported';

export function askRuleShapeFor(version: string | null): AskRuleShape {
  if (version === null) return 'unsupported';
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return 'unsupported';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major >= 2) return 'v2-array';
  if (major === 1 && minor >= 19) return 'v1-object';
  return 'unsupported';
}
