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

test('loadPolicy fails closed on a malformed policy file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-policy-'));
  try {
    const write = (content: string) => writeFileSync(join(dir, 'policy.json'), content);
    const expectThrow = (content: string, fragment: string) => {
      write(content);
      assert.throws(() => loadPolicy(join(dir, 'policy.json')), /TypeError/, fragment);
    };
    expectThrow('[]', 'array root');
    expectThrow('null', 'null root');
    expectThrow('{"writeOperationPrefixes": "list-vpcs"}', 'non-array field');
    expectThrow('{"secretKeyNamePatterns": null}', 'null field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPolicy accepts absent fields and the shipped policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-policy-'));
  try {
    writeFileSync(join(dir, 'policy.json'), '{"writeOperationPrefixes": ["List"]}');
    const partial = loadPolicy(join(dir, 'policy.json'));
    assert.deepEqual(partial.writeOperationPrefixes, ['List']);
    assert.deepEqual(partial.secretKeyNamePatterns, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const shipped = loadPolicy();
  assert.ok(shipped.writeOperationPrefixes.length > 0, 'shipped policy keeps write prefixes');
});

test('redactSecrets removes credential-shaped values recursively', () => {
  const redacted = redactSecrets({
    profile: 'dev',
    access_key: 'example-access-key',
    nested: {
      secretAccessKey: 'example-secret-key',
      normal: 'visible',
    },
  }) as {
    profile: string;
    access_key: string;
    nested: { secretAccessKey: string; normal: string };
  };
  assert.equal(redacted.profile, 'dev');
  assert.equal(redacted.access_key, '<redacted>');
  assert.equal(redacted.nested.secretAccessKey, '<redacted>');
  assert.equal(redacted.nested.normal, 'visible');
});

test('redactSecrets redacts adminPass and password fields', () => {
  const redacted = redactSecrets({
    '--server.adminPass': 'MySecret123!',
    password: 'hunter2',
    normal_field: 'keep',
  }) as { '--server.adminPass': string; password: string; normal_field: string };
  assert.equal(redacted['--server.adminPass'], '<redacted>');
  assert.equal(redacted.password, '<redacted>');
  assert.equal(redacted.normal_field, 'keep');
});

test('redactSecrets handles array values', () => {
  const redacted = redactSecrets([
    { name: 'prod', secret_key: 'sk-xxx' },
    { name: 'dev', normal: 'value' },
  ]) as { name: string; secret_key: string; normal: string }[];
  assert.equal(redacted[0].secret_key, '<redacted>');
  assert.equal(redacted[1].normal, 'value');
});

test('redactSecrets handles string values with key=value patterns', () => {
  const out = redactSecrets('AK=HPUAI12345\nSK=abcdef\nnormal output');
  assert.match(out, /<redacted>/);
  assert.match(out, /normal output/);
  assert.doesNotMatch(out, /HPUAI12345/);
});

test('redactSecrets redacts bare token= values (#726 D4-27)', () => {
  const out = redactSecrets('token=TokenValueABCDEF123456');
  assert.equal(out, 'token=<redacted>');
  assert.doesNotMatch(out, /TokenValueABCDEF123456/);
  // Long secret-token keys still redact (no regression, longest-match first).
  assert.equal(redactSecrets('security_token=stABC123'), 'security_token=<redacted>');
  assert.equal(redactSecrets('x_auth_token=xatABC123'), 'x_auth_token=<redacted>');
  // Other secret keywords keep working alongside bare token.
  assert.equal(
    redactSecrets('token=t1\npassword=pw1\nadminPass=ap1\naccess_key=ak1'),
    'token=<redacted>\npassword=<redacted>\nadminPass=<redacted>\naccess_key=<redacted>',
  );
  // Non-secret tokens (e.g. tokenize=) must NOT be redacted — the '=' boundary
  // ensures 'token' is followed by '=' directly, not by 'ize'.
  assert.equal(redactSecrets('tokenize=abc\ntokenizer=xyz'), 'tokenize=abc\ntokenizer=xyz');
});

test('redactSecrets redacts admin-pass / admin_pass / adminPass variants (#726 D4-27 v2)', () => {
  // String path: redactString regex now uses admin[_-]?pass to cover all three
  // shapes (camelCase / hyphen / underscore) under the /i flag.
  assert.equal(redactSecrets('adminPass=Secret123!'), 'adminPass=<redacted>');
  assert.equal(redactSecrets('admin-pass=Secret123!'), 'admin-pass=<redacted>');
  assert.equal(redactSecrets('admin_pass=Secret123!'), 'admin_pass=<redacted>');
  assert.equal(redactSecrets('ADMIN-PASS=Secret123!'), 'ADMIN-PASS=<redacted>');
  assert.equal(redactSecrets('Admin_Pass=Secret123!'), 'Admin_Pass=<redacted>');
  // admin-password also redacts (password keyword catches it) — regression guard.
  assert.equal(redactSecrets('admin-password=Secret123!'), 'admin-password=<redacted>');
  // Object key path: isSecretKeyName normalizes separators, so all variants
  // are already secret-classified — regression guard.
  const obj = redactSecrets({
    adminPass: 'v1',
    'admin-pass': 'v2',
    admin_pass: 'v3',
  }) as { adminPass: string; 'admin-pass': string; admin_pass: string };
  assert.equal(obj.adminPass, '<redacted>');
  assert.equal(obj['admin-pass'], '<redacted>');
  assert.equal(obj.admin_pass, '<redacted>');
});

test('redactSecrets masks opaque blob keys (user_data / metadata / private_key) entirely', () => {
  const redacted = redactSecrets([
    'ECS',
    'CreateServers',
    '--server.user_data=ZXhwb3J0IEFQUF9TRUNSRVQ9czNjcjN0',
    '--server.user_data=echo TOKEN=abc123 >> /etc/x',
    '--server.metadata.db_password=secret123',
    '--keypair.private_key=-----BEGIN RSA PRIVATE KEY-----',
  ]) as string[];
  for (const arg of redacted) {
    assert.doesNotMatch(arg, /SECRET|TOKEN|abc123|secret123|RSA|PRIVATE/);
  }
  assert.match(redacted[2], /user_data=<redacted>/);
  assert.match(redacted[3], /user_data=<redacted>/);
  assert.match(redacted[4], /metadata.db_password=<redacted>/);
  assert.match(redacted[5], /private_key=<redacted>/);
});

test('classifyTextCommand blocks direct credential file reads', () => {
  const result = classifyTextCommand('Get-Content ~/.hcloud/config.json');
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /credential|profile|secret/i);
});

test('classifyTextCommand blocks env var dumps with HUAWEICLOUD prefix', () => {
  assert.equal(classifyTextCommand('env | grep HUAWEICLOUD').decision, 'deny');
  assert.equal(classifyTextCommand('printenv | grep HWC_').decision, 'deny');
  assert.equal(classifyTextCommand('Get-ChildItem Env: | where HCLOUD_PROFILE').decision, 'deny');
});

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

test('classifyTextCommand blocks credential env-var references incl. HW_ prefix (#650 D4-2)', () => {
  // HW_ is the plugin's own documented credential prefix (auth/credentials.ts).
  const bypasses = [
    'echo $HW_SECRET_KEY',
    'printenv HW_ACCESS_KEY',
    'echo ${HW_SECURITY_TOKEN}',
    'cat <<EOF $HW_ACCESS_KEY EOF',
  ];
  for (const cmd of bypasses) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.equal(result.risk, 'credential', cmd);
  }
  // Non-credential HW_ variables must not be blocked.
  const benign = classifyTextCommand('echo $HW_CONFIG_PATH');
  assert.equal(benign.decision, 'allow');
  // Existing coverage keeps working.
  assert.equal(classifyTextCommand('env | grep HUAWEICLOUD').decision, 'deny');
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

test('Windows script wrappers (cmd / powershell / pwsh) keep wrapped writes denied (#731/#760)', () => {
  const denied = [
    // Quoted one-argument payloads, every spelling family.
    'cmd /c "hcloud ECS DeleteServers --server.id=1"',
    'cmd.exe /c "hcloud ECS DeleteServers --server.id=1"',
    'C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers --server.id=1"',
    'powershell -Command "hcloud ECS DeleteServers --server.id=1"',
    'powershell -command "hcloud ECS DeleteServers --server.id=1"',
    'powershell.exe -Command "hcloud OBS rm obs://bucket/obj"',
    'pwsh -Command "hcloud ECS CreateServers --flavor=x"',
    // Unquoted payloads: both shells take the ENTIRE remainder, so the
    // joined line classifies (not a truncation artifact).
    'cmd /k hcloud ECS DeleteServers --server.id=1',
    'powershell -c hcloud ECS DeleteServers --server.id=1',
    'pwsh.exe -c hcloud CCE DeleteCluster --cluster_id=x',
    // Option regions before the script flag — the canonical PowerShell
    // spelling and cmd's robust-quoting idioms; unbounded and order-free
    // (any option count, unlisted value-taking options); `//c` Git-Bash,
    // glued `/c"…"`, colon-attached payloads; the positional command
    // binding; drive-qualified bins and path-qualified prefixes.
    'powershell -NoProfile -Command "hcloud ECS DeleteServers --server.id=1"',
    'powershell -ExecutionPolicy Bypass -Command "hcloud ECS DeleteServers"',
    'powershell -WindowStyle Hidden -Command "hcloud ECS DeleteServers"',
    'powershell -com "hcloud ECS DeleteServers"',
    'powershell -Command:hcloud ECS DeleteServers',
    'powershell -Command:"hcloud ECS DeleteServers --server.id=1"',
    'powershell -c"hcloud ECS DeleteServers"',
    'cmd /c"hcloud ECS DeleteServers" --x=1',
    'cmd /d /c hcloud ECS DeleteServers --server.id=1',
    'cmd /s /c "hcloud ECS DeleteServers --server.id=1"',
    'cmd //c "hcloud ECS DeleteServers --server.id=1"',
    'cmd /c"hcloud ECS DeleteServers --server.id=1"',
    'cmd /q /d /e:on /f:on /v:on /a /u /s /x /c hcloud ECS DeleteServers --server.id=1',
    'powershell hcloud ECS DeleteServers --server.id=1',
    'powershell -NoProfile hcloud ECS DeleteServers --server.id=1',
    'C:\\hcloud.exe ECS DeleteServers --server.id=1',
    'd:hcloud.exe ECS DeleteServers --server.id=1',
    'cmd /c "C:\\Tools\\hcloud.exe ECS DeleteServers --server.id=1"',
    '/usr/bin/sudo -u root hcloud ECS DeleteServers --server.id=1',
    '/usr/bin/SUDO hcloud ECS DeleteServers --server.id=1',
    'timeout 1.5 hcloud ECS DeleteServers --server.id=1',
    'cmd /c start "t" hcloud ECS DeleteServers --server.id=1',
    'cmd /c start "t" C:\\hcloud.exe ECS DeleteServers',
    'bash -c "cmd /c \\"hcloud ECS DeleteServers\\""',
    'bash -c "powershell -Command \\"hcloud ECS DeleteServers\\""',
    // Compound inner scripts and wrapper nesting.
    'cmd /c "hcloud ECS ListServers; hcloud ECS DeleteServers --server.id=1"',
    'powershell -Command "echo hi; hcloud ECS DeleteServers --server.id=1"',
    'cmd /c "bash -c \'hcloud ECS DeleteServers\'"',
    // cmd.exe launch builtins re-base onto the child; PowerShell's
    // call-operator scriptblock, glued and spaced.
    'cmd /c start hcloud ECS DeleteServers --server.id=1',
    'cmd /c start /b hcloud ECS DeleteServers',
    'cmd /c call hcloud ECS DeleteServers',
    'powershell -Command "& {hcloud ECS DeleteServers}"',
    'powershell -Command "& { hcloud ECS DeleteServers }"',
    // Quote-mangled wrapper heads classify like quote-mangled bins.
    'cm\'d\' /c "hcloud ECS DeleteServers"',
    'powers\'hell\' -Command "hcloud ECS DeleteServers"',
    // Path-qualified wrappers after separators and with compound payloads.
    'echo x; C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"',
    'echo hi && C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"',
    'C:\\Windows\\System32\\cmd.exe /c "echo hi; hcloud ECS DeleteServers"',
    // Composed with a command-position prefix.
    'sudo cmd /c "hcloud ECS DeleteServers"',
    'sudo powershell -NoProfile -Command "hcloud ECS DeleteServers"',
  ];
  for (const cmd of denied) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.equal(result.risk, 'write', cmd);
  }
  // Wrapped reads stay allowed — over-broad unwrapping must not regress.
  const allowed = [
    'cmd /c "hcloud ECS ListServers"',
    'cmd /k hcloud ECS ListServers',
    'powershell -Command "hcloud ECS ListServers"',
    'pwsh -c hcloud ECS ListServers',
    'powershell -NoProfile -Command "hcloud ECS ListServers"',
    'powershell -WindowStyle Hidden -Command "hcloud ECS ListServers"',
    'powershell hcloud ECS ListServers',
    'cmd /c start /wait hcloud ECS ListServers',
  ];
  for (const cmd of allowed) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'allow', cmd);
    assert.equal(result.risk, 'read_only', cmd);
  }
  // Degenerate and non-script forms take no inline command; the
  // positional binding only runs commands, and non-hcloud positional
  // payloads stay allowed. The encoded payload is a documented residual
  // (opaque to a text gate).
  for (const cmd of [
    'cmd',
    'cmd /c',
    'cmd /c "echo hi"',
    'powershell -File deploy.ps1',
    'powershell Get-Process',
    'powershell',
    'powershell -EncodedCommand aGNsb3VkIEVDUyBEZWxldGVTZXJ2ZXJz',
    'start notepad file.txt',
    'see the hcloud docs here',
    'echo "hcloud ECS DeleteServers"',
  ]) {
    assert.equal(classifyTextCommand(cmd).decision, 'allow', cmd);
  }
  // The argv face unwraps the same way.
  const argvResult = classifyHcloudArgs(['cmd', '/c', 'hcloud ECS DeleteServers --server.id=1']);
  assert.equal(argvResult.decision, 'deny');
  assert.equal(argvResult.risk, 'write');
  // POSIX escapes still eat backslashes outside drive paths (the
  // preservation is scoped to `X:` words).
  assert.equal(classifyTextCommand('hcloud ECS DeleteServers --filter=g\\et').decision, 'deny');
});

test('unquoted bash -c payloads truncate to bare hcloud and deny fail-closed', () => {
  // Real bash passes only the next argument to -c (`ECS Delete…` become
  // $0/$1) — but the flattened form is indistinguishable from the quoted
  // original (`bash -c "hcloud ECS Delete…"`), so the script word being
  // a bin re-joins the tail and classifies the whole command
  // (fail-closed: deny either way, now as the write it flattens).
  const result = classifyTextCommand('bash -c hcloud ECS DeleteServers --server.id=1');
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'write');
  // The nested bare-hcloud shape (a script whose continuation line is
  // just the bin) denies the same way.
  const nested = classifyTextCommand("bash -c 'echo; hcloud' && echo done");
  assert.equal(nested.decision, 'deny');
  assert.equal(nested.risk, 'invalid');
  // A bare trailing `hcloud` mention never routes into classification.
  for (const cmd of ['hcloud', 'sudo hcloud', 'hcloud --', 'echo hcloud']) {
    assert.equal(classifyTextCommand(cmd).decision, 'allow', cmd);
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

test('classifyTextCommand allows escaped credential-name searches, blocks unescaped dumps (#650)', () => {
  // Literal-NAME references (backslash-escaped or single-quoted) denote
  // searching for where the variable appears, not shell expansion.
  const escapedSearches = [
    "git grep '\\$HW_SECRET_KEY' -- src/",
    "rg '$HW_SECRET_KEY' ./",
    'grep -r HW_SECRET_KEY ./src',
  ];
  for (const cmd of escapedSearches) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'allow', cmd);
  }
  // Unescaped $HW_* is a potential expansion/dump no matter the leading
  // command — a whitelist by command name must not create a false negative.
  const unescapedDumps = [
    'echo $HW_SECRET_KEY',
    'grep $HW_SECRET_KEY ./file',
    'git commit -m "$HW_SECRET_KEY"',
    'grep x && echo $HW_SECRET_KEY',
    'rg $HW_ACCESS_KEY ./src',
  ];
  for (const cmd of unescapedDumps) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.equal(result.risk, 'credential', cmd);
  }
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

test('classifyTextCommand returns not_huaweicloud for non-cloud commands', () => {
  assert.equal(classifyTextCommand('ls -la').risk, 'not_huaweicloud');
  assert.equal(classifyTextCommand('npm test').risk, 'not_huaweicloud');
});

test('classifyTextCommand detects hcloud write commands in text', () => {
  const result = classifyTextCommand('hcloud ECS NovaCreateServers --server.name=test');
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'write');
});

test('classifyTextCommand blocks secret value patterns in shell commands', () => {
  assert.equal(classifyTextCommand('hcloud CSMS ShowSecretVersion --secret_name x').decision, 'deny');
  assert.equal(classifyTextCommand('GetSecretValue xxx').decision, 'deny');
  assert.equal(classifyTextCommand('secret_string xxx').decision, 'deny');
});

test('deriveSecretOperationAlternation survives degenerate policy shapes', () => {
  // Empty or absent list → never-matching pattern (mirrors the py layer's
  // `if blocked_secrets:` skip; an empty alternation branch would match
  // EVERYTHING and brick the TS Bash face).
  for (const empty of [[], [''], ['', '']]) {
    const alternation = deriveSecretOperationAlternation(empty);
    assert.equal(alternation, '(?!)');
    assert.equal(new RegExp(alternation, 'i').test('git status'), false);
  }
  // Empty-string entries are dropped, not treated as stems of everything.
  assert.equal(deriveSecretOperationAlternation(['', 'ShowSecret']), 'showsecret');
  // Identity compares originals (py parity): case-variant duplicates count
  // as distinct entries, so each becomes a guarded stem of the other.
  const caseDup = deriveSecretOperationAlternation(['ShowSecret', 'showsecret']);
  assert.match(caseDup, /\(\?<!\[A-Za-z0-9._\/-\]\)showsecret/);
  assert.match(caseDup, /showsecret\(\?!\[A-Za-z0-9._\/-\]\)/);
});

test('the secret vocabulary is derived from policy.json and mirrored in the risk-rule catalog', () => {
  // The TS text faces and the py SECRET_READ_RE both derive from
  // policy.blockedSecretOperations; the cloud-risk-rules.json
  // secret-value-read regex is the one remaining hand-maintained copy.
  // Assert it SEMANTICALLY: every policy entry matches the rule regex, and
  // stem entries keep their boundary guards there (longer names exempt).
  const policy = JSON.parse(
    readFileSync(join(repoRoot, 'plugins', 'huaweicloud-core', 'safety', 'policy.json'), 'utf8'),
  );
  const rules = JSON.parse(
    readFileSync(join(repoRoot, 'plugins', 'huaweicloud-core', 'safety', 'rules', 'cloud-risk-rules.json'), 'utf8'),
  );
  const rule = rules.rules.find((r: { id: string }) => r.id === 'hwc-command-secret-value-read');
  const condition = rule.match.any.find((c: { regex: string }) => /ShowSecret/i.test(c.regex));
  const regex = new RegExp(condition.regex, 'i');
  for (const op of policy.blockedSecretOperations) {
    assert.ok(regex.test(` ${op} `), `${op} must be matched by the rule regex`);
  }
  const loweredOps = new Set(policy.blockedSecretOperations.map((op: string) => op.toLowerCase()));
  const stems = policy.blockedSecretOperations.filter((op: string) =>
    policy.blockedSecretOperations.some(
      (other: string) => other !== op && other.toLowerCase().startsWith(op.toLowerCase()),
    ),
  );
  // Guard drift in the hand-maintained JSON copy must not false-pass: pin
  // both boundary directions AND the separator members of the guard class
  // against the same corpus the TS face is pinned to.
  for (const stem of stems) {
    const s = stem.toLowerCase();
    assert.ok(!regex.test(` ${stem}List `), `${stem}List must stay exempt (lookahead guard present)`);
    assert.ok(!regex.test(`my${s}`), `my${s} must stay exempt (lookbehind guard present)`);
    for (const shape of [`${s}-demo`, `${s}_v`, `${s}.x`, `${s}/x`, `x/${s}`]) {
      assert.ok(!regex.test(shape), `${shape} must stay exempt (full guard class present)`);
    }
    assert.ok(regex.test(`--secret_name=${s}`), `--secret_name=${s} must still deny (exact stem)`);
  }
  // Self-specific entries stay UNGUARDED substrings in the JSON copy:
  // embedded shapes must still match (the hook faces' documented contract).
  for (const op of policy.blockedSecretOperations) {
    if (stems.includes(op)) continue;
    assert.ok(regex.test(`${op.toLowerCase()}-demo`), `${op}-demo must still match (unguarded substring)`);
  }
  // Reverse containment: no stale JSON-only vocabulary that policy dropped.
  // Strip lookaround guards FIRST (they carry their own parens), then drop
  // the wrapping group and split alternatives.
  const guardStripped = condition.regex
    .replace(/\(\?<!\[[^\]]*\]\)|\(\?!\[[^\]]*\]\)/g, '')
    .replace(/^[()]+|[()]+$/g, '')
    .split('|')
    .map((part: string) => part.trim().toLowerCase())
    .filter((part: string) => part !== '');
  for (const part of guardStripped) {
    assert.ok(
      loweredOps.has(part),
      `JSON rule carries "${part}" which policy.blockedSecretOperations lacks — stale vocabulary`,
    );
  }
});

test('classifyTextCommand blocks KMS/CSMS ShowSecret retrieval (#770 D4-3)', () => {
  const blocked = [
    'hcloud KMS ShowSecret',
    'hcloud KMS ShowSecret --key_id x',
    'hcloud DEW ShowSecret --secret_name prod/db',
    'ShowSecret --secret_name prod/db',
  ];
  for (const cmd of blocked) {
    const result = classifyTextCommand(cmd);
    assert.equal(result.decision, 'deny', cmd);
    assert.equal(result.risk, 'secret', cmd);
  }
  // Plain Show* reads that are not secret retrieval keep working.
  assert.equal(classifyTextCommand('hcloud KMS ShowKey').decision, 'allow');
  // The ShowSecret stem is boundary-guarded: longer operation names and
  // resource-name values containing the stem do not become secret denies.
  assert.equal(classifyTextCommand('hcloud CSMS ShowSecretList').decision, 'allow');
  for (const name of [
    'showsecret-demo',
    'showsecret_version',
    'showsecret.prod',
    'showsecret/prod',
    'prod/showsecret',
    'myshowsecret',
  ]) {
    const result = classifyTextCommand(`hcloud CSMS ListSecrets --secret_name=${name}`);
    assert.equal(result.decision, 'allow', name);
    assert.equal(result.risk, 'read_only', name);
  }
  const approved = classifyTextCommand('hcloud IAM CreatePolicy --policy.name=showsecret-demo', {
    allowWrites: true,
  });
  assert.equal(approved.decision, 'allow');
  assert.equal(approved.risk, 'write');
  // Quote-mangled tokens outside hcloud routing still deny (shadow parity
  // with the py hook).
  assert.equal(classifyTextCommand("echo Show'Secret'").decision, 'deny');
  assert.equal(classifyTextCommand("echo Show'Secret'Version").decision, 'deny');
});

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

test('the skill-quality-cli wrapper does not launder hcloud classification', () => {
  // The adopted huawei-cloud-* service skills teach the wrapper; the
  // command-position seam unwraps it so embedded hcloud keeps its verdict.
  const deny = [
    'skill-quality-cli run --skill-name ecs -- hcloud ECS CreateServers --server.name=x',
    'skill-quality-cli run -- hcloud ECS DeleteServers --server.id=1',
    '~/.local/bin/skill-quality-cli run --skill-name x -- hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli run --skill-name x hcloud ECS DeleteServers --server.id=1',
    '/usr/local/bin/skill-quality-cli run -- hcloud OBS rm obs://bucket/obj -f',
    'sudo skill-quality-cli run -- hcloud ECS CreateServers --server.name=x',
    'npx huaweicloud-devkit secret exec --env K=x -- bash -c "skill-quality-cli run -- hcloud ECS DeleteServers"',
    // The separator decision lives inside the flag walk: a `--` owned by
    // the CHILD argv never launders the wrapper.
    'skill-quality-cli run --skill-name x hcloud ECS DeleteServers --server.id=1 --',
    'skill-quality-cli run hcloud ECS DeleteServers -- --server.id=1',
    // Global no-value flags sit between the bin and the subcommand.
    'skill-quality-cli --no-auto-upgrade run -- hcloud ECS DeleteServers --server.id=1',
    // Windows shims and the ELF tier are the same tool.
    'skill-quality-cli.exe run -- hcloud ECS DeleteServers --server.id=1',
    '~/.local/bin/skill-quality-cli.bin run -- hcloud ECS DeleteServers --server.id=1',
    // Quote-mangled bin/subcommand: the shell executes the canonical name.
    "skill'-'quality'-'cli run -- hcloud ECS DeleteServers --server.id=1",
    "skill-quality-cli ru'n' -- hcloud ECS DeleteServers",
    // Every value flag is pinned, including the hcloud-value ambiguity
    // (the child starts AT the hcloud token — the deny composes).
    'skill-quality-cli run --session-id s hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli run --json hcloud ECS DeleteServers --server.id=1',
    // Same-wrapper nesting with a compound inner script reaches the
    // innermost script through the fixpoint candidates.
    'skill-quality-cli run --skill-name a -- skill-quality-cli run --skill-name b -- bash -c "echo hi; hcloud ECS DeleteServers --server.id=1"',
    // The every-position scan is inherited doctrine: prose that mentions a
    // wrapped write, and heredoc data quoting one, also deny.
    'echo skill-quality-cli run -- hcloud ECS DeleteServers --server.id=1',
    // Unknown flag grammar fails CLOSED: the REMAINDER walk falls back to
    // the first hcloud bin in the tail (abbreviations, underscores,
    // unknown value flags, pre-run flags all compose the deny).
    'skill-quality-cli run --config /etc/x hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli run --skill-n x hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli run --skill_name x hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli --json run -- hcloud ECS DeleteServers --server.id=1',
    // Pre-run value flags occupy the `run` position — the same laundering
    // shape, closed by the pre-run fallback.
    'skill-quality-cli --config x run -- hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli --skill-name x run -- hcloud ECS DeleteServers --server.id=1',
    // Script-wrapped children classify identically with and without the
    // separator (the verbatim child reaches the nested-script candidates).
    'skill-quality-cli run bash -c "hcloud ECS DeleteServers --server.id=1"',
    'skill-quality-cli run --config x bash -c "hcloud ECS DeleteServers"',
    // eval-class script children and case-variant shells re-base the same
    // way; the value-flag slot fails closed for script heads too.
    'skill-quality-cli run --config x eval "hcloud ECS DeleteServers"',
    'skill-quality-cli run --config x BASH -c "hcloud ECS DeleteServers"',
    'skill-quality-cli run --json bash -c "hcloud ECS DeleteServers"',
    // The wrapper's own `--` separator is AUTHORITATIVE when it follows a
    // wrapper-ambiguous value slot: the separator's child classifies, not
    // the slot re-base (which would swallow the separator and misread the
    // operation from nonFlags[1]).
    'skill-quality-cli run --skill-name hcloud -- hcloud ECS DeleteServers --server.id=1',
    'skill-quality-cli run --skill-name eval -- hcloud ECS DeleteServers --server.id=1',
    // A lone-shell-token child must not crash the py layer (the write in
    // the NEXT segment still denies independently).
    'skill-quality-cli run bash && hcloud ECS DeleteServers --server.id=1',
    // Quote-mangled pre-run tokens canonicalize through the normalization.
    "skill-quality-cli --no-auto-'upgrade' run -- hcloud ECS DeleteServers --server.id=1",
    "skill-quality-cli -'-' run -- hcloud ECS DeleteServers --server.id=1",
    // Windows path-qualified bins match through the raw-form candidate
    // (TS fail-closed: the TS tokenizer keeps backslashes; the py segment
    // splitter unescapes them, so the layers differ on this shape — the
    // POSIX shell never executes it either way).
    'C:\\tools\\skill-quality-cli.exe run -- hcloud ECS DeleteServers --server.id=1',
    'C:\\tools\\huaweicloud-devkit secret exec --env K=x -- hcloud ECS DeleteServers --server.id=1',
    // POSIX escape mangling matches through the normalized candidate.
    'skill\\-quality\\-cli run -- hcloud ECS DeleteServers --server.id=1',
  ];
  for (const cmd of deny) {
    assert.equal(classifyTextCommand(cmd).decision, 'deny', cmd);
  }
  const allow = [
    'skill-quality-cli run --skill-name ecs -- hcloud ECS ListServers',
    'skill-quality-cli run -- hcloud CSMS ListSecrets',
    'skill-quality-cli run --skill-name x hcloud ECS ListServers --cli-region=cn-north-4',
    'skill-quality-cli report --input x',
    'skill-quality-cli install',
    'skill-quality-cli run -- -- hcloud ECS ListServers',
    // The `--` separator is authoritative: a non-hcloud child stays
    // non-hcloud even when a path token later in the tail looks like one.
    'skill-quality-cli run -- ls /opt/hcloud',
    'skill-quality-cli report run --input run.log',
    // A lone trailing hcloud token is a subcommand argument, not a child —
    // the fallbacks require a following token before re-basing. This also
    // covers the value-flag slot: a trailing flag VALUE named hcloud.
    'skill-quality-cli report --input hcloud && echo ok',
    'skill-quality-cli install hcloud && echo ok',
    'skill-quality-cli run ls hcloud && echo ok',
    'skill-quality-cli run --skill-name hcloud && echo ok',
    'skill-quality-cli run --json hcloud && echo ok',
    // A bare `bash deploy.sh` (no -c) is not a script head — no re-base,
    // no operation read off the script filename.
    'skill-quality-cli run --config x bash deploy.sh',
    'skill-quality-cli run --config x bash install.sh',
    // `bash -c x -- hcloud …` executes only the script `x`; the `--`
    // token makes everything after it bash POSITIONAL parameters ($0…),
    // so the hcloud tokens never execute — allow is the true semantics.
    'skill-quality-cli run --skill-name bash -c x -- hcloud ECS DeleteServers --server.id=1',
    // A lone shell token as the child is not a script (no -c, no script
    // argument) — allow, no crash in either layer.
    'skill-quality-cli run bash',
    'skill-quality-cli run -- bash',
  ];
  for (const cmd of allow) {
    assert.equal(classifyTextCommand(cmd).decision, 'allow', cmd);
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

test('classifyTextCommand blocks approved public admin port exposure', () => {
  const result = classifyTextCommand(
    'hcloud VPC CreateSecurityGroupRule --security_group_rule.protocol=tcp --security_group_rule.port_range_min=22 --security_group_rule.port_range_max=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
    { allowWrites: true },
  );
  assert.equal(result.decision, 'deny');
  assert.equal(result.blockedByRiskRule, true);
  assert.equal(result.findings?.[0].ruleId, 'hwc-network-public-admin-port');
  // The remediation rides the reason on every deny face (Node hook
  // permissionDecisionReason, MCP assertLimited errors) — the same
  // message + " Remediation: " + remediation format the py hook emits.
  assert.match(result.reason ?? '', /Remediation: /);
  assert.match(result.reason ?? '', /\/32 rule for your real direct egress IP/);
});

test('classifyTextCommand applies shared risk rules to non-hcloud commands', () => {
  const result = classifyTextCommand('echo ZWNobyBoaQ== | base64 -d | bash');
  assert.equal(result.decision, 'deny');
  assert.equal(result.blockedByRiskRule, true);
  assert.equal(result.findings?.[0].ruleId, 'hwc-command-encoded-shell-exec');
});

test('classifyTextCommand carries warnings for high-cost shapes', () => {
  const result = classifyTextCommand(
    'hcloud CCE CreateCluster --node_pool.max_node_count=80 --node_pool.name=preview',
    { allowWrites: true },
  );
  assert.equal(result.decision, 'allow');
  assert.ok(result.warnings?.some((finding) => finding.ruleId === 'hwc-cost-unbounded-scale'));
});

test('existing credential and secret blocks still win before risk-rule warnings', () => {
  const credentialResult = classifyTextCommand('Get-Content ~/.hcloud/config.json');
  assert.equal(credentialResult.decision, 'deny');
  assert.equal(credentialResult.risk, 'credential');
  assert.equal(Object.hasOwn(credentialResult, 'findings'), false);

  const secretResult = classifyTextCommand('hcloud CSMS ShowSecretVersion --secret_name prod/db');
  assert.equal(secretResult.decision, 'deny');
  assert.equal(secretResult.risk, 'secret');
});

test('classifyTextCommand blocks the vault CLI reveal face (secret get)', () => {
  assert.equal(classifyTextCommand('npx huaweicloud-devkit secret get secret://user/hw-sk').decision, 'deny');
  assert.equal(classifyTextCommand('huaweicloud-devkit secret get secret://user/hw-sk --stdout').decision, 'deny');
  assert.equal(
    classifyTextCommand('node ./plugins/huaweicloud-core/dist/setup-cli.js secret get secret://user/hw-sk').decision,
    'deny',
  );
  assert.equal(classifyTextCommand('bin/setup.cjs secret get secret://user/hw-sk').decision, 'deny');
});

test('classifyTextCommand allows the vault non-reveal subcommands', () => {
  assert.equal(
    classifyTextCommand('npx huaweicloud-devkit secret exec --env K=secret://user/ak -- node script.js').decision,
    'allow',
  );
  assert.equal(classifyTextCommand('npx huaweicloud-devkit secret list').decision, 'allow');
  assert.equal(
    classifyTextCommand('npx huaweicloud-devkit secret set secret://user/ak --file /tmp/key.txt').decision,
    'allow',
  );
  assert.equal(classifyTextCommand('npx huaweicloud-devkit secret rm secret://user/ak').decision, 'allow');
});

test('secret exec does not launder hcloud write classification', () => {
  const write = classifyTextCommand(
    'npx huaweicloud-devkit secret exec --env K=secret://user/ak -- hcloud ECS CreateServers --cli-region=cn-north-4',
  );
  assert.equal(write.decision, 'deny');
  assert.match(write.reason ?? '', /write/i);
  const read = classifyTextCommand(
    'npx huaweicloud-devkit secret exec --env K=secret://user/ak -- hcloud ECS ListServers --cli-region=cn-north-4',
  );
  assert.equal(read.decision, 'allow');
});

test('the vault store directory and master keyfile are credential files', () => {
  assert.equal(classifyTextCommand('cat ~/.config/huaweicloud/secrets/user/hw-sk.json').decision, 'deny');
  assert.equal(classifyTextCommand('cat ~/.config/huaweicloud/secrets/.master-key').decision, 'deny');
});

test('the vault reveal deny survives adversarial spellings (quotes, versions, source form)', () => {
  const revealCommands = [
    "npx huaweicloud-devkit secret 'get' secret://user/hw-sk --stdout",
    'npx huaweicloud-devkit secret "get" secret://user/hw-sk',
    'npx huaweicloud-devkit@latest secret get secret://user/hw-sk --stdout',
    'npx huaweicloud-devkit@2.3.0 secret get secret://user/hw-sk',
    'node ./plugins/huaweicloud-core/src/setup-cli.ts secret get secret://user/hw-sk --stdout',
    'node dist/setup-cli.mjs secret get secret://user/hw-sk',
    './node_modules/.bin/huaweicloud-devkit.exe secret get secret://user/hw-sk',
  ];
  for (const command of revealCommands) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
});

test('secret exec laundering survives adversarial spellings (version specs, shells, segments)', () => {
  const launderedWrites = [
    'npx huaweicloud-devkit@2.3.0 secret exec --env K=x -- bash -c "hcloud ECS CreateServers --cli-region=cn-north-4"',
    "npx huaweicloud-devkit secret exec --env K=x -- bash -c 'hcloud ECS DeleteServers --cli-region=cn-north-4'",
    'echo hello && npx huaweicloud-devkit secret exec -- hcloud ECS CreateServers --cli-region=cn-north-4',
    'node ./plugins/huaweicloud-core/src/setup-cli.ts secret exec -- hcloud ECS NovaCreateServers',
  ];
  for (const command of launderedWrites) {
    const result = classifyTextCommand(command);
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason ?? '', /write/i, command);
  }
  // Reads through the wrapper stay allowed — the gate is the write, not the wrapper.
  assert.equal(
    classifyTextCommand(
      'npx huaweicloud-devkit@latest secret exec --env K=secret://user/ak -- hcloud ECS ListServers --cli-region=cn-north-4',
    ).decision,
    'allow',
  );
});

test('quote-adjacent hcloud keeps its classification in plain shell too', () => {
  // Pre-existing gap closed alongside the exec unwrap: the presence gate ran
  // on raw text, so `bash -c "hcloud ..."` never routed into the classifier.
  const result = classifyTextCommand('bash -c "hcloud ECS CreateServers --cli-region=cn-north-4"');
  assert.equal(result.decision, 'deny');
  // A quoted hcloud mention that is not a command stays allowed.
  assert.equal(classifyTextCommand('echo "hcloud rocks"').decision, 'allow');
});

test('the reveal deny survives ANSI-C quoting, expansion quotes, and multi-invocation lines', () => {
  const revealCommands = [
    "npx huaweicloud-devkit secret $'get' secret://user/hw-sk --stdout",
    'npx huaweicloud-devkit secret $"get" secret://user/hw-sk --stdout',
    "npx huaweicloud-devkit sec$'r'et get secret://user/hw-sk --stdout",
    'npx huaweicloud-devkit secret g"e"t secret://user/hw-sk --stdout',
  ];
  for (const command of revealCommands) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
});

test('secret exec laundering survives earlier devkit invocations and npm separators', () => {
  const launderedWrites = [
    'npx huaweicloud-devkit secret list && npx huaweicloud-devkit secret exec -- bash -c "hcloud ECS CreateServers --cli-region=x"',
    'npx huaweicloud-devkit --version && npx huaweicloud-devkit secret exec -- bash -c "hcloud ECS DeleteServers"',
    'npx -- huaweicloud-devkit secret exec --env K=x -- bash -c "hcloud ECS CreateServers"',
    'npm exec huaweicloud-devkit -- secret exec --env K=x -- bash -c "hcloud ECS DeleteServers"',
    'node dist/setup-cli.mjs secret exec -- bash -c "hcloud ECS DeleteServers"',
    'secret list | npx huaweicloud-devkit secret exec -- hcloud ECS CreateServers',
    // No devkit involvement: a non-leading shell-wrapped segment must classify too.
    'echo hi && bash -c "hcloud ECS CreateServers --cli-region=x"',
  ];
  for (const command of launderedWrites) {
    const result = classifyTextCommand(command);
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason ?? '', /write/i, command);
  }
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

test('the write gate classifies every line and command position of a payload', () => {
  const denyCases = [
    'hcloud ECS ListServers\nhcloud ECS CreateServers --server.name=x',
    'echo hello\nhcloud ECS CreateServers --server.name=x',
    'hcloud ECS ListServers & hcloud ECS DeleteServers',
    'for i in 1 2 3; do hcloud ECS DeleteServers --server.id=$i; done',
    'echo i-123 | xargs hcloud ECS DeleteServers --server.id=x',
    'env HW_REGION=cn-north-4 hcloud ECS DeleteServers --server.id=x',
    'nohup hcloud ECS DeleteServers --server.id=x',
    '/usr/bin/hcloud ECS DeleteServers',
    './hcloud ECS DeleteServers',
    'echo $(hcloud ECS DeleteServers)',
    'echo `hcloud ECS DeleteServers`',
    "hclou'd' ECS DeleteServers",
    'h\\cloud ECS DeleteServers',
  ];
  for (const command of denyCases) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
  // Command-position env prefix stays legitimate; prose and filenames do
  // not fire the env-dump family.
  const allowCases = [
    'env -i hcloud ECS ListServers',
    'cat environment.md | grep nothing',
    'python3 env_setup.py --region cn-north-4 HUAWEICLOUD',
    'npx huaweicloud-devkit secret set secret://user/ak --file /tmp/key.txt',
  ];
  for (const command of allowCases) {
    assert.equal(classifyTextCommand(command).decision, 'allow', command);
  }
});

test('credential-file reads stay denied through quoted path spellings', () => {
  assert.equal(classifyTextCommand("cat ~/.config/huawei'cloud/secrets'/.master-key").decision, 'deny');
  assert.equal(classifyTextCommand('strings ~/.config/huawei"cloud"/secrets/x.json').decision, 'deny');
});

test('the reveal deny survives npm separators; ANSI-C escape obfuscation is denied outright', () => {
  assert.equal(
    classifyTextCommand('npm exec huaweicloud-devkit -- secret get secret://user/hw-sk --stdout').decision,
    'deny',
  );
  assert.equal(
    classifyTextCommand('npx huaweicloud-devkit -- secret get secret://user/hw-sk --stdout').decision,
    'deny',
  );
  // Escape-sequence ANSI-C builds argv the shadow cannot reconstruct — deny
  // the obfuscated invocation instead of parsing it.
  const obfuscated = 'npx huaweicloud-devkit secret $' + "'\\x67et' secret://user/hw-sk --stdout";
  const result = classifyTextCommand(obfuscated);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /obfuscated/i);
});

test('the env-dump family closes the full-dump and pipe-grep forms', () => {
  const denyCases = [
    'env',
    'printenv',
    'env -0',
    'export -p | grep HW_',
    'env | grep HW_ACCESS_KEY',
    'printenv PATH HW_SECRET_KEY',
  ];
  for (const command of denyCases) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
  assert.equal(classifyTextCommand('printenv PATH').decision, 'allow');
});
