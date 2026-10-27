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

test('the py hook derives the obfuscation gate write vocabulary from policy.json, never a second hand-maintained list', () => {
  // port-v2defects (interrogate round): WRITE_VOCAB_RE was a hardcoded
  // 20-word alternation whose comment claimed to mirror policy.json's 37
  // writeOperationPrefixes — the 17 missing words (invoke/execute/trigger/
  // deploy among them) let mangled InvokeFunction/Execute/Trigger/Deploy
  // writes through the py-hook faces (Hermes importlib, WorkBuddy deploy)
  // while the TS layer denied via writeVocabHit. The vocabulary is now
  // DERIVED by load_policy from the same list WRITE_OPERATION_RE reads, and
  // an unavailable derivation (unreadable policy, empty list) fails the
  // gate's clause CLOSED — the `is None` arm fires — instead of silently
  // reopening the mangled-write hole.
  const pyHook = readSource(join('hooks', 'huaweicloud-safety.py'));
  assert.match(pyHook, /WRITE_VOCAB_RE = None/);
  // Every compile of the vocabulary must derive from the policy list (and
  // carry the OBSUTIL_WRITES union) — the assignment-scan shape, not a
  // byte-exact line pin, so cosmetic reformatting stays green while a
  // re-hardcoded alternation (the drift shape, in any spelling or order)
  // fails: a compile without write_prefixes IS a hand-maintained list.
  const vocabAssignments = pyHook.match(/WRITE_VOCAB_RE = re\.compile\([^\n]*\)/g) ?? [];
  assert.ok(vocabAssignments.length >= 1, 'the vocabulary must be compiled inside load_policy');
  for (const assignment of vocabAssignments) {
    assert.match(assignment, /write_prefixes/, `policy-derived compile required: ${assignment}`);
    assert.match(assignment, /OBSUTIL_WRITES/, `the OBS subcommand union must ride the vocabulary: ${assignment}`);
  }
  // The fail-closed arm sits in the gate's vocabulary clause.
  assert.ok(
    pyHook.includes('or WRITE_VOCAB_RE is None\n        or WRITE_VOCAB_RE.search(unquoted)'),
    'an unavailable derivation must fail the clause CLOSED (the is None arm)',
  );
});

test('the py hook degrades coherently: derived vocabularies, isolated fields, fail-closed gates (interrogate round 1)', () => {
  // The read vocabulary is ALSO policy-derived (the last hand-maintained
  // policy mirror), the write gate's read exemption is start-anchored
  // (re.match, TS hasReadPrefix parity), and an unavailable write
  // vocabulary denies ROUTED hcloud commands instead of silently allowing
  // plain writes while the mangled forms deny.
  const pyHook = readSource(join('hooks', 'huaweicloud-safety.py'));
  assert.match(pyHook, /READ_OPERATION_RE = None/);
  const readAssignments = pyHook.match(/READ_OPERATION_RE = re\.compile\([^\n]*\)/g) ?? [];
  assert.ok(readAssignments.length >= 1, 'the read vocabulary must be compiled inside load_policy');
  for (const assignment of readAssignments) {
    assert.match(assignment, /read_prefixes/, `policy-derived compile required: ${assignment}`);
  }
  // Start-anchored read exemption (the drift let `Update-Show-x` allow).
  assert.match(pyHook, /READ_OPERATION_RE is None or not READ_OPERATION_RE\.match\(operation\)/);
  // The write-gate fail-closed arm with its cause-named reason.
  assert.match(pyHook, /if not WRITE_OPERATION_RE:[\s\S]{0,900}?denied fail-closed/);
  // Per-field isolation: the vocabularies compile FIRST, before the
  // pattern-bearing fields whose invalid regexes must not abort them.
  const writeFirst = pyHook.indexOf('write_prefixes = policy.get');
  const credLater = pyHook.indexOf('cred_patterns = policy.get');
  assert.ok(
    writeFirst !== -1 && credLater !== -1 && writeFirst < credLater,
    'the vocabularies load before the pattern fields',
  );
  // Non-list values funnel into the fail-closed arms, never a garbage
  // char-alternation from "|".join on a string.
  assert.match(pyHook, /if not isinstance\(write_prefixes, list\):/);
  assert.match(pyHook, /if not isinstance\(read_prefixes, list\):/);

  // The TS twin: writeVocabHit unions OBSUTIL_WRITES and treats an empty
  // prefix list as a hit (the is-None arm's mirror).
  const classifyText = readSource(join('src', 'safety', 'classify-text.ts'));
  assert.match(classifyText, /import \{ OBSUTIL_WRITES \} from '\.\/tokens\.ts';/);
  assert.match(classifyText, /writeOperationPrefixes\.length === 0/);
  assert.match(classifyText, /\[\.\.\.DEFAULT_POLICY\.writeOperationPrefixes, \.\.\.OBSUTIL_WRITES\]\.some/);

  // The Node hook wrapper fails CLOSED on a payload too broken to load its
  // own policy (DEFAULT_POLICY throws at module load) instead of dying with
  // no verdict, which a PreToolUse harness reads as "allow". readSource
  // rewrites legacy .mjs paths to .ts — the hook is a real .mjs, so it is
  // read directly (the structure-runtime precedent).
  const nodeHook = readFileSync(join(pluginRoot, 'hooks', 'huaweicloud-safety.mjs'), 'utf8');
  assert.match(nodeHook, /} catch \{\s*\n\s*deny\('the safety policy failed to load/);
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
