import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  classifyHcloudArgs,
  classifyTextCommand,
  deriveSecretOperationAlternation,
  loadPolicy,
  redactSecrets,
} from '../plugins/huaweicloud-core/src/safety-policy.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('KMS plaintext-returning operations deny as secret reads; rotation/cancel are writes (S5)', () => {
  // The dew skill's Blocked Operations table taught "blocked" for KMS
  // DecryptData/CreateDatakey while the classifier allowed them (S5 review,
  // probed live). The policy vocabulary now carries the plaintext stems;
  // CreateDatakey stays an approval-gated write on purpose — it is a prefix
  // of the safe CreateDatakeyWithoutPlaintext, and unguarded substring
  // semantics would block the safe variant too.
  for (const cmd of [
    'hcloud KMS DecryptData --cli-region=cn-north-4 --key_id=k --cipher_text=abc',
    'hcloud KMS DecryptDatakey --cli-region=cn-north-4 --key_id=k --cipher_text=abc',
    'hcloud KMS DecryptDatakeyCapsule --cli-region=cn-north-4 --key_id=k',
    'hcloud KMS DownloadAccessPointPrivateKey --cli-region=cn-north-4',
    'hcloud KMS DeriveSharedSecret --cli-region=cn-north-4 --key_id=k',
    'hcloud KMS CreateRsaDatakeyPair --cli-region=cn-north-4',
    'hcloud KMS CreateEcDatakeyPair --cli-region=cn-north-4',
  ]) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.equal(result.risk, 'secret', cmd);
  }
  // The stem guard: DecryptData must not leak onto longer names.
  assert.equal(classifyTextCommand('hcloud CSMS ListSecrets --secret_name=decryptdata-demo').decision, 'allow');
  // CreateDatakey: write (approval path), and the safe variant is a write too.
  const datakey = classifyTextCommand('hcloud KMS CreateDatakey --cli-region=cn-north-4 --key_id=k');
  assert.equal(datakey.decision, 'deny');
  assert.equal(datakey.risk, 'write');
  const safe = classifyTextCommand('hcloud KMS CreateDatakeyWithoutPlaintext --cli-region=cn-north-4 --key_id=k');
  assert.equal(safe.decision, 'deny');
  assert.equal(safe.risk, 'write');
  // RotateSecret / CancelKeyDeletion are writes now (they were unknown reads).
  for (const cmd of [
    'hcloud CSMS RotateSecret --cli-region=cn-north-4 --secret_name=x',
    'hcloud KMS RotateOnDemand --cli-region=cn-north-4 --key_id=k',
    'hcloud KMS CancelKeyDeletion --cli-region=cn-north-4 --key_id=k',
  ]) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.equal(result.risk, 'write', cmd);
  }
});

test('the env-credential family covers SECRET_ACCESS_KEY spellings (#770)', () => {
  assert.equal(classifyTextCommand('echo $HUAWEICLOUD_SECRET_ACCESS_KEY').decision, 'deny');
  assert.equal(classifyTextCommand('echo ${HUAWEICLOUD_SECRET_ACCESS_KEY}').decision, 'deny');
  assert.equal(classifyTextCommand('printenv HWC_SECRET_ACCESS_KEY').decision, 'deny');
  assert.equal(classifyTextCommand('echo $OS_SECRET_ACCESS_KEY').decision, 'deny');
  assert.equal(classifyTextCommand('env | grep HW_SECRET_ACCESS_KEY').decision, 'deny');
  // Single-quoted and backslash-escaped names are shell literals — exempt.
  assert.equal(classifyTextCommand("echo '$HUAWEICLOUD_SECRET_ACCESS_KEY' is literal").decision, 'allow');
  assert.equal(classifyTextCommand('echo \\$HUAWEICLOUD_SECRET_ACCESS_KEY').decision, 'allow');
  // Non-credential spellings stay legitimate.
  assert.equal(classifyTextCommand('echo $HUAWEICLOUD_REGION').decision, 'allow');
});

// ---- #927/#928 audit pins (U17): in-word keyword splits, sudo+mangled,
// Delete/Reboot-class mangled ops, the argv secret form, newline-READ allow,
// CRLF+indent, unquoted prose allows — all live-verified before pinning; and
// the ANSI-C KEYWORD-mangling bypass the audit found (v2 AND main both
// allowed it — the write-vocab clause of the obfuscation gate closes it).

test('existing credential and secret blocks still win before risk-rule warnings', () => {
  const credentialResult = classifyTextCommand('Get-Content ~/.hcloud/config.json');
  assert.equal(credentialResult.decision, 'deny');
  assert.equal(credentialResult.risk, 'credential');
  assert.equal(Object.hasOwn(credentialResult, 'findings'), false);

  const secretResult = classifyTextCommand('hcloud CSMS ShowSecretVersion --secret_name prod/db');
  assert.equal(secretResult.decision, 'deny');
  assert.equal(secretResult.risk, 'secret');
});

test('the vault store directory and master keyfile are credential files', () => {
  assert.equal(classifyTextCommand('cat ~/.config/huaweicloud/secrets/user/hw-sk.json').decision, 'deny');
  assert.equal(classifyTextCommand('cat ~/.config/huaweicloud/secrets/.master-key').decision, 'deny');
});

test('quote-blind credential gates: env dumps and printenv through quoted command names', () => {
  assert.equal(classifyTextCommand('bash -c "env | grep HUAWEICLOUD"').decision, 'deny');
  assert.equal(classifyTextCommand("bash -c 'printenv HW_SECRET_KEY'").decision, 'deny');
  // Mid-token quotes must not hide a write operation from the write gate.
  assert.equal(classifyTextCommand("hcloud ECS Cre'ateServers --cli-region=x").decision, 'deny');
  // Single-quoted $HW_* stays exempt (the shell never expands it) — raw-text
  // lookbehind is deliberate.
  assert.equal(classifyTextCommand("echo '$HW_SECRET_KEY is a literal'").decision, 'allow');
});

test('credential-file reads stay denied through quoted path spellings', () => {
  assert.equal(classifyTextCommand("cat ~/.config/huawei'cloud/secrets'/.master-key").decision, 'deny');
  assert.equal(classifyTextCommand('strings ~/.config/huawei"cloud"/secrets/x.json').decision, 'deny');
});
