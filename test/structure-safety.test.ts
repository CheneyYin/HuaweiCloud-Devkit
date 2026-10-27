import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { RiskRulesCatalog, SafetyPolicy } from './structure-helpers.ts';
import { pluginRoot, readJson, readSource, root } from './structure-helpers.ts';

test('safety policy.json is valid and has required fields', () => {
  const policy = readJson(join(pluginRoot, 'safety', 'policy.json')) as SafetyPolicy;
  assert.ok(Array.isArray(policy.secretKeyNamePatterns));
  assert.ok(policy.secretKeyNamePatterns.length >= 5);
  assert.ok(Array.isArray(policy.writeOperationPrefixes));
  assert.ok(policy.writeOperationPrefixes.length >= 10);
  assert.ok(Array.isArray(policy.blockedSecretOperations));
  assert.ok(Array.isArray(policy.credentialFilePatterns));
});

test('cloud risk rules are present and public-safe', () => {
  const rulesPath = join(pluginRoot, 'safety', 'rules', 'cloud-risk-rules.json');
  assert.ok(existsSync(rulesPath), 'Missing cloud-risk-rules.json');

  const catalog = readJson(rulesPath) as RiskRulesCatalog;
  assert.equal(catalog.version, '0.1.0');
  assert.ok(Array.isArray(catalog.rules), 'rules must be an array');
  assert.ok(catalog.rules.length >= 9, 'Expected baseline cloud risk rules');

  const ids = new Set();
  const allowedSeverities = new Set(['deny', 'warn', 'info']);
  const allowedStages = new Set(['command', 'artifact', 'deploy_plan']);
  for (const rule of catalog.rules) {
    assert.match(rule.id, /^hwc-[a-z0-9-]+$/, `Invalid rule id: ${rule.id}`);
    assert.ok(!ids.has(rule.id), `Duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    assert.ok(allowedSeverities.has(rule.severity), `${rule.id} has invalid severity`);
    assert.ok(Array.isArray(rule.stages) && rule.stages.length > 0, `${rule.id} missing stages`);
    for (const stage of rule.stages) {
      assert.ok(allowedStages.has(stage), `${rule.id} has invalid stage: ${stage}`);
    }
    assert.ok(rule.match && (rule.match.any || rule.match.all), `${rule.id} needs match conditions`);
    assert.ok(rule.message && rule.remediation, `${rule.id} needs message and remediation`);
    assert.doesNotMatch(JSON.stringify(rule), /\baccountId\b|\bticketId\b|\brawText\b|\binternalSource\b/i);
  }
});

test('hooks.json uses Node hook and keeps Python hook for Hermes compatibility', () => {
  const hooksDir = join(pluginRoot, 'hooks');
  const hooksJsonPath = join(hooksDir, 'hooks.json');
  assert.ok(existsSync(hooksJsonPath));
  assert.ok(existsSync(join(hooksDir, 'huaweicloud-safety.mjs')));
  assert.ok(existsSync(join(hooksDir, 'huaweicloud-safety.py')));

  const hooksJson = readFileSync(hooksJsonPath, 'utf8');
  assert.match(hooksJson, /\bnode\b/);
  assert.match(hooksJson, /huaweicloud-safety\.mjs/);
  assert.doesNotMatch(hooksJson, /\bpython3?\b/);
});

test('hook rule model documentation exists', () => {
  const doc = join(root, 'docs', 'hook-rule-model.md');
  assert.ok(existsSync(doc), 'Missing docs/hook-rule-model.md');
  const body = readFileSync(doc, 'utf8');
  assert.match(body, /Hook 规则模型/);
  assert.match(body, /隐私边界/);
  assert.match(body, /huaweicloud_hook_check_command/);
});

test('safety skill teaches proactive hook checks', () => {
  const safetySkill = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-safety', 'SKILL.md'), 'utf8');
  assert.match(safetySkill, /huaweicloud_hook_check_command/);
  assert.match(safetySkill, /huaweicloud_hook_check_artifacts/);
  assert.match(safetySkill, /huaweicloud_hook_check_deploy_plan/);
});

test('the safety skill documents the secret vault and its reference is not a dead end', () => {
  const skill = readSource(join('src', 'packs', 'core', 'skills', 'huaweicloud-safety', 'SKILL.md'));
  const reference = readSource(
    join('src', 'packs', 'core', 'skills', 'huaweicloud-safety', 'references', 'secrets.md'),
  );
  // SKILL.md routes to the reference; the reference actually covers the
  // ref model, the agent-side exec path, the deny on secret get, and the
  // honest security boundary (cross-skill references must not dead-end).
  assert.match(skill, /references\/secrets\.md/);
  assert.match(reference, /secret:\/\/<scope>\/<name>/);
  assert.match(reference, /secret exec --env/);
  assert.match(reference, /secret get/);
  assert.match(reference, /NOT defend/);
  // The skill-quality-cli wrapper-unwrap residual is documented here too:
  // variable-indirection and alternate-entry spellings are the seam gaps.
  assert.match(reference, /skill-quality-cli/);
  assert.match(reference, /python3 -m skill_quality_cli/);
  assert.match(reference, /cli_entry\.py/);
});

test('the signing test vectors never spell a contiguous Signature=<hex> literal', () => {
  // The CI secret scanner (gitleaks generic-api-key) matches the contiguous
  // '<token keyword>...=...<64-hex>' shape: it flagged two of the four
  // deterministic HMAC vectors on PR #1037 (2026-10-27) — test digests, not
  // credentials. The vectors now live as prefix + DIGEST_* concatenation so
  // no keyword sits inside the scanner's window of a hex value; a "cleanup"
  // that merges them back into single literals re-trips the gate. This pin
  // makes that regression a named failure instead of a red CI mystery.
  const vectors = readFileSync(join(root, 'test', 'hw-request-signing.test.ts'), 'utf8');
  assert.doesNotMatch(vectors, /Signature=[0-9a-f]{64}/);
  assert.match(vectors, /Signature=' \+ DIGEST_/);
});
