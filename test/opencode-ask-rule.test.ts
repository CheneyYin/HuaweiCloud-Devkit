import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASK_RULE_ACTION,
  ASK_RULE_RESOURCE,
  applyAskPermissionRule,
  applyAskPermissionRuleV1,
  askRuleShapeFor,
  inspectAskPermissionRule,
  inspectAskPermissionRuleV1,
  opencodeAskRuleVersionSupported,
  removeAskPermissionRule,
  removeAskPermissionRuleV1,
} from '../plugins/huaweicloud-core/src/lib/opencode-ask-rule.ts';

// Pure ask-rule logic (lib/opencode-ask-rule.ts), modeled on the seam
// test's Part A: the ownership contract is add-only-if-absent on write and
// value-exact on removal; these units pin every branch the CLI integration
// cannot reach deterministically (user entries, non-array shapes,
// last-match-wins inspection, the version floor's polarity).

const ourRule = { action: ASK_RULE_ACTION, resource: ASK_RULE_RESOURCE, effect: 'ask' };

test('applyAskPermissionRule creates the single-entry array on a fresh config', () => {
  const config: Record<string, unknown> = {};
  const result = applyAskPermissionRule(config);
  assert.deepEqual(result, { changed: true, skipped: false });
  assert.deepEqual(config.permissions, [ourRule]);
});

test('a user entry on the ask action survives the write, whatever its effect', () => {
  for (const effect of ['allow', 'deny', 'ask']) {
    const config = { permissions: [{ action: ASK_RULE_ACTION, resource: '*', effect }] };
    const result = applyAskPermissionRule(config);
    assert.deepEqual(result, { changed: false, skipped: true }, `effect ${effect} is user-owned`);
    assert.deepEqual(config.permissions, [{ action: ASK_RULE_ACTION, resource: '*', effect }]);
  }
});

test('the appended entry lands last, so last-matching-rule-wins makes it effective', () => {
  const userRule = { action: 'other-server_other_tool', resource: '*', effect: 'deny' };
  const config = { permissions: [userRule] };
  const result = applyAskPermissionRule(config);
  assert.deepEqual(result, { changed: true, skipped: false });
  assert.deepEqual(config.permissions, [userRule, ourRule], 'our entry is the last one');
});

test('a non-array permissions shape is skipped untouched', () => {
  const config = { permissions: 'ask' };
  const result = applyAskPermissionRule(config);
  assert.deepEqual(result, { changed: false, skipped: true });
  assert.equal(config.permissions, 'ask', 'the user’s shape is never converted');
});

test('removeAskPermissionRule deletes only value-exact matches and prunes the emptied array', () => {
  const userEffect = { action: ASK_RULE_ACTION, resource: '*', effect: 'allow' };
  const otherAction = { action: 'other-server_other_tool', resource: '*', effect: 'ask' };
  const config = { permissions: [{ ...ourRule }, userEffect, otherAction] };
  const changed = removeAskPermissionRule(config);
  assert.equal(changed, true);
  assert.deepEqual(config.permissions, [userEffect, otherAction], 'user-modified and other-action entries survive');
});

test('removal prunes the permissions key only when OUR removals emptied it', () => {
  const config = { permissions: [{ ...ourRule }] };
  assert.equal(removeAskPermissionRule(config), true);
  assert.equal('permissions' in config, false, 'the array the rule emptied is gone');
});

test('a pre-existing empty array is left alone (no phantom change)', () => {
  const config = { permissions: [] };
  assert.equal(removeAskPermissionRule(config), false);
  assert.deepEqual(config.permissions, []);
});

test('removal is a no-op without an array to read', () => {
  assert.equal(removeAskPermissionRule({}), false);
  assert.equal(removeAskPermissionRule({ permissions: 'ask' }), false, 'the scalar shape is the user’s');
});

test('the full write/remove cycle restores the pre-rule content', () => {
  const original = { permissions: [{ action: 'user_tool', resource: '*', effect: 'deny' }] };
  const config = structuredClone(original);
  applyAskPermissionRule(config);
  assert.equal(removeAskPermissionRule(config), true);
  assert.deepEqual(config, original);
});

test('the accepted edge: a user-authored same-shape rule predating the write is removed with it', () => {
  const config = { permissions: [{ ...ourRule }] };
  assert.equal(removeAskPermissionRule(config), true);
  assert.equal('permissions' in config, false);
});

test('inspectAskPermissionRule reads the LAST matching entry (last-match-wins)', () => {
  // apply does NOT append when an entry on the action exists, so the
  // multi-entry case is constructed by hand — exactly the shape a user's
  // own edits produce.
  const both = { permissions: [{ ...ourRule, effect: 'allow' }, { ...ourRule }] };
  assert.equal(inspectAskPermissionRule(both), 'ask', 'the last entry wins');
  const reversed = { permissions: [{ ...ourRule }, { ...ourRule, effect: 'deny' }] };
  assert.equal(inspectAskPermissionRule(reversed), 'deny', 'the last entry wins');
});

test('inspectAskPermissionRule reports each readable effect', () => {
  for (const effect of ['ask', 'allow', 'deny'] as const) {
    assert.equal(inspectAskPermissionRule({ permissions: [{ ...ourRule, effect }] }), effect);
  }
});

test('inspectAskPermissionRule reports absent for no matching entry', () => {
  assert.equal(inspectAskPermissionRule({}), 'absent', 'no permissions key');
  assert.equal(inspectAskPermissionRule({ permissions: [] }), 'absent', 'empty array');
  assert.equal(
    inspectAskPermissionRule({ permissions: [{ action: 'other_tool', resource: '*', effect: 'allow' }] }),
    'absent',
    'only other actions',
  );
});

test('inspectAskPermissionRule reports foreign for unreadable postures', () => {
  assert.equal(inspectAskPermissionRule({ permissions: 'allow' }), 'foreign', 'non-array permissions');
  assert.equal(
    inspectAskPermissionRule({ permissions: [{ ...ourRule, effect: 'maybe' }] }),
    'foreign',
    'an effect outside the allow/ask/deny vocabulary is unreadable',
  );
});

test('opencodeAskRuleVersionSupported pins the 2.0 floor and the unknown polarity', () => {
  assert.equal(opencodeAskRuleVersionSupported('2.0.0'), true, 'the V2 permissions array floor');
  assert.equal(opencodeAskRuleVersionSupported('v2.2.7'), true, 'the measured version');
  assert.equal(opencodeAskRuleVersionSupported('2.9.1'), true);
  assert.equal(opencodeAskRuleVersionSupported('1.19.0'), false, 'below the V2 shape');
  assert.equal(opencodeAskRuleVersionSupported('1.9'), false);
  assert.equal(opencodeAskRuleVersionSupported('garbage'), false, 'unparsable');
  assert.equal(opencodeAskRuleVersionSupported('opencode 2.2.7'), false, 'the probe must extract, not pass raw output');
  assert.equal(opencodeAskRuleVersionSupported('2'), false, 'unparsable per the anchored shape');
  assert.equal(opencodeAskRuleVersionSupported(null), false, 'absent/unparsable polarity is skip');
});

// ── The V1 shape: the `permission` object form (opencode 1.19.0 – 1.x) ──
// Source-verified on the v1.19.0 tag: the run tool's permission key is
// byte-identical to ASK_RULE_ACTION, fromConfig() maps a bare string value
// to pattern "*", and evaluate() is findLast — so an appended key wins.
// These units pin the same ownership contract the V2 tests pin above.

test('applyAskPermissionRuleV1 creates the single-key permission object on a fresh config', () => {
  const config: Record<string, unknown> = {};
  const result = applyAskPermissionRuleV1(config);
  assert.deepEqual(result, { changed: true, skipped: false });
  assert.deepEqual(config.permission, { [ASK_RULE_ACTION]: 'ask' });
});

test('a user value on the ask key survives the V1 write, whatever its value', () => {
  for (const value of ['allow', 'deny', 'ask', { '*': 'ask' }]) {
    const config = { permission: { [ASK_RULE_ACTION]: value } };
    const result = applyAskPermissionRuleV1(config);
    assert.deepEqual(result, { changed: false, skipped: true }, `value ${JSON.stringify(value)} is user-owned`);
    assert.deepEqual((config.permission as Record<string, unknown>)[ASK_RULE_ACTION], value);
  }
});

test('the V1 append lands last, so findLast makes it effective over an earlier wildcard', () => {
  const config = { permission: { '*': 'allow', bash: 'allow' } };
  const result = applyAskPermissionRuleV1(config);
  assert.deepEqual(result, { changed: true, skipped: false });
  assert.deepEqual(Object.keys(config.permission), ['*', 'bash', ASK_RULE_ACTION], 'our key is the last one');
});

test('a scalar-shaped permission is skipped untouched (the global posture is the user’s)', () => {
  const config = { permission: 'allow' };
  const result = applyAskPermissionRuleV1(config);
  assert.deepEqual(result, { changed: false, skipped: true });
  assert.equal(config.permission, 'allow', 'the user’s shape is never converted');
});

test('removeAskPermissionRuleV1 deletes only the value-exact ask and prunes the emptied object', () => {
  const config = { permission: { [ASK_RULE_ACTION]: 'ask' } };
  assert.equal(removeAskPermissionRuleV1(config), true);
  assert.equal('permission' in config, false, 'the object our removal emptied is gone');
});

test('V1 removal keeps user-modified values and unrelated keys', () => {
  const modified = { permission: { '*': 'allow', [ASK_RULE_ACTION]: 'deny' } };
  assert.equal(removeAskPermissionRuleV1(modified), false, 'a non-ask value is the user’s');
  assert.deepEqual(modified.permission, { '*': 'allow', [ASK_RULE_ACTION]: 'deny' });

  const mixed = { permission: { '*': 'allow', [ASK_RULE_ACTION]: 'ask' } };
  assert.equal(removeAskPermissionRuleV1(mixed), true);
  assert.deepEqual(mixed.permission, { '*': 'allow' }, 'the unrelated keys survive');
});

test('V1 removal is a no-op without an object to read', () => {
  assert.equal(removeAskPermissionRuleV1({}), false);
  assert.equal(removeAskPermissionRuleV1({ permission: 'ask' }), false, 'the scalar shape is the user’s');
});

test('the V1 write/remove cycle restores the pre-rule content', () => {
  const original = { permission: { '*': 'deny' } };
  const config = structuredClone(original);
  applyAskPermissionRuleV1(config);
  assert.equal(removeAskPermissionRuleV1(config), true);
  assert.deepEqual(config, original);
});

test('inspectAskPermissionRuleV1 reads each bare effect and reports the unreadable shapes', () => {
  for (const effect of ['ask', 'allow', 'deny'] as const) {
    assert.equal(inspectAskPermissionRuleV1({ permission: { [ASK_RULE_ACTION]: effect } }), effect);
  }
  assert.equal(inspectAskPermissionRuleV1({}), 'absent', 'no permission key');
  assert.equal(inspectAskPermissionRuleV1({ permission: {} }), 'absent', 'empty object');
  assert.equal(inspectAskPermissionRuleV1({ permission: { other_tool: 'ask' } }), 'absent', 'only other tools');
  assert.equal(inspectAskPermissionRuleV1({ permission: 'allow' }), 'foreign', 'the scalar global posture');
  assert.equal(
    inspectAskPermissionRuleV1({ permission: { [ASK_RULE_ACTION]: { '*': 'ask' } } }),
    'foreign',
    'a pattern map is not a single-effect posture',
  );
});

test('askRuleShapeFor pins both measured floors and the unknown polarity', () => {
  assert.equal(askRuleShapeFor('2.0.0'), 'v2-array', 'the V2 permissions array floor');
  assert.equal(askRuleShapeFor('v2.2.7'), 'v2-array', 'the measured V2');
  assert.equal(askRuleShapeFor('v9.9.9'), 'v2-array');
  assert.equal(askRuleShapeFor('1.19.0'), 'v1-object', 'the source-verified V1');
  assert.equal(askRuleShapeFor('v1.30.5'), 'v1-object');
  assert.equal(askRuleShapeFor('1.18.9'), 'unsupported', 'below the V1 floor');
  assert.equal(askRuleShapeFor('1.9'), 'unsupported', 'unparsable per the anchored shape');
  assert.equal(askRuleShapeFor('opencode 2.2.7'), 'unsupported', 'the probe must extract, not pass raw output');
  assert.equal(askRuleShapeFor(null), 'unsupported', 'absent/unparsable polarity is skip');
});
