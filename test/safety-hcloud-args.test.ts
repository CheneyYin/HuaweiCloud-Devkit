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

test('classifyHcloudArgs blocks secret value reads', () => {
  const result = classifyHcloudArgs(['CSMS', 'ShowSecretVersion', '--secret_name', 'prod/db']);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /secret value/i);
});

test('classifyHcloudArgs blocks ShowSecret as an operation (#770 D4-3)', () => {
  const result = classifyHcloudArgs(['CSMS', 'ShowSecret', '--secret_name', 'prod/db']);
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'secret');
});

test('classifyHcloudArgs blocks unapproved writes', () => {
  const result = classifyHcloudArgs(['ECS', 'NovaCreateServers', '--body', '{}']);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /write operation/i);
});

test('classifyHcloudArgs blocks Apply* operations as writes (#644)', () => {
  // EIP ApplyEip was classified as unknown_read and allowed through (issue #644 EXP-E04).
  const applyWrites = [
    ['EIP', 'ApplyEip'],
    ['WAF', 'ApplyCertificateToHost'],
    ['CDN', 'ApplyDomainTemplate'],
    ['RDS', 'ApplyConfigurationAsync'],
  ];
  for (const args of applyWrites) {
    const result = classifyHcloudArgs(args);
    assert.equal(result.decision, 'deny', args.join(' '));
    assert.equal(result.risk, 'write', args.join(' '));
  }
});

test('classifyHcloudArgs keeps read operations containing Apply substring as read-only', () => {
  const result = classifyHcloudArgs(['ECS', 'ListConfigurationApplyHistories']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'read_only');
});

test('classifyHcloudArgs allows local help for Apply operations', () => {
  const result = classifyHcloudArgs(['EIP', 'ApplyEip', '--help']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'local_metadata');
});

test('classifyHcloudArgs unwraps shell-wrapped hcloud write commands (#650 D4-16)', () => {
  const wrapped = [
    ['bash', '-c', 'hcloud ECS CreateServers --flavor=x'],
    ['sh', '-c', 'hcloud CCE DeleteCluster --cluster_id=x'],
    ['bash', '-c', 'sudo hcloud OBS rm obs://bucket/obj'],
    ['sudo', 'hcloud', 'ECS', 'CreateServers'],
    ['/bin/bash', '-c', 'bash -c "hcloud ECS DeleteServers --servers=[]"'],
  ];
  for (const args of wrapped) {
    const result = classifyHcloudArgs(args);
    assert.equal(result.decision, 'deny', args.join(' '));
    assert.equal(result.risk, 'write', args.join(' '));
  }
});

test('classifyHcloudArgs detects hcloud write commands mid-concatenation (#650 review)', () => {
  const concatenated = [
    ['bash', '-c', 'echo x; hcloud ECS CreateServers --flavor=x'],
    ['bash', '-c', 'echo done && hcloud CCE DeleteCluster --cluster_id=x'],
    ['sudo', 'sh', '-c', 'hcloud OBS rm obs://b/x && echo ok'],
  ];
  for (const args of concatenated) {
    const result = classifyHcloudArgs(args);
    assert.equal(result.decision, 'deny', args.join(' '));
    assert.equal(result.risk, 'write', args.join(' '));
  }
  const textResult = classifyTextCommand('echo x && hcloud ECS CreateServers --flavor=x');
  assert.equal(textResult.decision, 'deny');
  assert.equal(textResult.risk, 'write');
  // Read-only hcloud prefix keeps working.
  const readResult = classifyTextCommand('hcloud ECS ListServers; echo done');
  assert.equal(readResult.decision, 'allow');
  assert.equal(readResult.risk, 'read_only');
});

test('classifyHcloudArgs allows local help for write operations', () => {
  const result = classifyHcloudArgs(['ECS', 'CreateServers', '--help']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'local_metadata');
});

test('classifyHcloudArgs allows read-only list and show operations', () => {
  assert.equal(classifyHcloudArgs(['ECS', 'NovaListServers']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['ECS', 'ListServersDetails']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['VPC', 'ShowVpc']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['IMS', 'GlanceShowImage']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['IAM', 'KeystoneListUsers']).decision, 'allow');
});

test('classifyHcloudArgs blocks obsutil write commands', () => {
  const writes = ['mb', 'cp', 'mv', 'rm', 'delete', 'mkdir', 'sync', 'chattri', 'bucketpolicy'];
  for (const op of writes) {
    assert.equal(classifyHcloudArgs(['obs', op, 'obs://bucket']).decision, 'deny', `obs ${op} should be blocked`);
  }
  // Regression pin for the cors/website entries: upstream main's #1001 removed
  // them as "nonexistent subcommands", but that was measured on a 7.2.x binary —
  // the pinned 7.3.12 live-serves both (`OBS help cors` exit 0; `-method=get` on
  // a nonexistent bucket returns OBS-side NoSuchBucket, so the commands reach
  // the service). They are write-capable via -method=put and must stay denied.
  assert.equal(classifyHcloudArgs(['obs', 'cors', 'obs://bucket']).decision, 'deny', 'obs cors should be blocked');
  assert.equal(
    classifyTextCommand('hcloud OBS cors obs://bucket -method=put -localfile=c.xml').decision,
    'deny',
    'raw-text hcloud OBS cors -method=put should be blocked',
  );
  assert.equal(
    classifyHcloudArgs(['obs', 'website', 'obs://bucket']).decision,
    'deny',
    'obs website should be blocked',
  );
  assert.equal(
    classifyTextCommand('hcloud OBS website obs://bucket -method=put -localfile=w.xml').decision,
    'deny',
    'raw-text hcloud OBS website -method=put should be blocked',
  );
});

test('classifyHcloudArgs blocks the KooCLI 7.3.12 obsutil write subcommands (7.3.12 pin)', () => {
  // 7.3.12 added these set/put/delete-capable subcommands (writes ride on
  // -method=put/set/delete) — they must hit the same deny as their older
  // siblings, on every layer (TS classifier, py hook twin, plan/read faces).
  const methodWrites = ['bucket-tagging', 'object-tagging', 'encryption', 'mirror-back-to-source'];
  for (const op of methodWrites) {
    assert.equal(
      classifyHcloudArgs(['obs', op, 'obs://bucket', '-method=put']).decision,
      'deny',
      `obs ${op} -method=put should be blocked`,
    );
    assert.equal(
      classifyHcloudArgs(['OBS', op, 'obs://bucket', '-method=delete']).decision,
      'deny',
      `OBS ${op} -method=delete should be blocked (case-insensitive service)`,
    );
    assert.equal(
      classifyTextCommand(`hcloud OBS ${op} obs://bucket -method=set -localfile=c.xml`).decision,
      'deny',
      `raw-text hcloud OBS ${op} -method=set should be blocked`,
    );
  }
  // custom-domain writes ride on -cname/certificate options, not -method.
  assert.equal(classifyHcloudArgs(['obs', 'custom-domain', 'obs://bucket', '-cname=x.com']).decision, 'deny');
  assert.equal(classifyTextCommand('hcloud OBS custom-domain obs://b -cname=x.com').decision, 'deny');
  // The full-name public-access-block writes (no -method — the verb is the
  // command name; deleting re-opens public access) and the pre-existing
  // abort/archive writes the 7.3.12-pin sweep dispositioned.
  for (const op of ['put-public-access-block', 'delete-public-access-block', 'abort', 'archive']) {
    assert.equal(classifyHcloudArgs(['obs', op, 'obs://bucket']).decision, 'deny', `obs ${op} should be blocked`);
    assert.equal(
      classifyTextCommand(`hcloud OBS ${op} obs://bucket`).decision,
      'deny',
      `raw-text hcloud OBS ${op} should be blocked`,
    );
  }
  // Read controls of the same families stay allowed (regression pin: a
  // vocabulary over-reach flipping reads to deny fails here).
  for (const op of ['get-public-access-block', 'get-bucket-policy-status', 'get-bucket-public-status', 'check', 'ls']) {
    assert.equal(classifyHcloudArgs(['obs', op, 'obs://bucket']).decision, 'allow', `obs ${op} should stay a read`);
  }
});

test('classifyHcloudArgs allows obsutil read commands', () => {
  const reads = ['ls', 'stat', 'help', 'version'];
  for (const op of reads) {
    assert.equal(classifyHcloudArgs(['obs', op]).decision, 'allow', `obs ${op} should be allowed`);
  }
});

test('classifyHcloudArgs blocks execution operations (Invoke, Trigger, Deploy)', () => {
  const execs = ['InvokeFunction', 'SyncInvokeFunction', 'AsyncInvokeFunction', 'Send'];
  for (const op of execs) {
    assert.equal(classifyHcloudArgs(['FunctionGraph', op]).decision, 'deny', `${op} should be blocked as execution`);
  }
  assert.equal(classifyHcloudArgs(['ECS', 'StartServers']).decision, 'deny', 'ECS StartServers should be blocked');
  assert.equal(classifyHcloudArgs(['ECS', 'RebootServers']).decision, 'deny', 'ECS RebootServers should be blocked');
});

test('classifyHcloudArgs blocks hcloud configure show without allowCredentialRead', () => {
  const result = classifyHcloudArgs(['configure', 'show']);
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'credential');
});

test('classifyHcloudArgs rejects empty args', () => {
  assert.equal(classifyHcloudArgs([]).decision, 'deny');
  assert.equal(classifyHcloudArgs([]).risk, 'invalid');
});

test('classifyHcloudArgs allows version commands', () => {
  assert.equal(classifyHcloudArgs(['version']).risk, 'local_metadata');
  assert.equal(classifyHcloudArgs(['--version']).risk, 'local_metadata');
});
