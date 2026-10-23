import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import {
  consumeApprovalToken,
  createApprovalToken,
  hashArgs,
  inspectApprovalToken,
  planHcloudCommand,
  redactArgsWithObs,
  resolveStsInjectArgs,
  runHcloud,
  extractApiError,
  redactOutput,
  stripKooCliUpdateBanner,
  type HcloudPlan,
  type HcloudRunResult,
} from '../plugins/huaweicloud-core/src/hcloud-cli.ts';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { callTool, type ToolArgs } from '../plugins/huaweicloud-core/src/tools.ts';
import { fixtureDir } from './fixture-dir.ts';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern) so cold-attested calls in this file dispatch without the
// challenge bounce. The challenge itself is pinned where it is the subject
// (tools.test.ts's gate test drives the dance; the selfcheck drives it on
// the wire); the real-model e2e tier never sets this seam.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

const isWin = process.platform === 'win32';

interface FakeHcloudOutput {
  ok: boolean;
  args: string[];
}

interface ApprovedRunResult extends HcloudRunResult {
  approved: boolean;
  injectedLang?: unknown;
  autoRetried?: unknown;
}

async function withTempAuthHome(fn: (home: string) => Promise<void> | void) {
  const home = fixtureDir('huaweicloud-toolkit-auth-');
  const previous = {
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HCLOUD_CONFIG_PATH: process.env.HCLOUD_CONFIG_PATH,
    HCLOUD_OBS_CONFIG_PATH: process.env.HCLOUD_OBS_CONFIG_PATH,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
    HW_STS_EXPIRES_AT: process.env.HW_STS_EXPIRES_AT,
  };
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HCLOUD_CONFIG_PATH = join(home, '.hcloud', 'config.json');
  process.env.HCLOUD_OBS_CONFIG_PATH = join(home, '.obsutilconfig');
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  // parseStsExpiry prioritizes this env over the token itself — a stray value
  // would flip the CREDENTIAL_EXPIRED gate tests.
  delete process.env.HW_STS_EXPIRES_AT;
  try {
    return await fn(home);
  } finally {
    clearRuntimeCredentials();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function fakeHcloudScript(source: string) {
  const dir = fixtureDir('huaweicloud-toolkit-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, source, 'utf8');
  return script;
}

function fakeHcloudExecutable(source: string) {
  const dir = fixtureDir('huaweicloud-toolkit-bin-');
  const script = join(dir, 'fake-hcloud');
  writeFileSync(script, `#!/usr/bin/env node\n${source}`, 'utf8');
  chmodSync(script, 0o755);
  return script;
}

function withMetaRepo(files: Record<string, unknown[]>) {
  const dir = fixtureDir('huaweicloud-toolkit-meta-');
  for (const [name, items] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify({ items }));
  }
  return dir;
}

test('planHcloudCommand includes copyable command text and password history warning', () => {
  const plan = planHcloudCommand(['ECS', 'CreateServers', '--server.adminPass=Secret123!'], {
    allowWrites: true,
  });
  assert.match(plan.executableBlock, /hcloud ECS CreateServers/);
  assert.ok(plan.warnings.some((warning) => typeof warning === 'string' && /shell history/i.test(warning)));
});

test('planHcloudCommand correctly classifies read-only command', () => {
  const plan = planHcloudCommand(['ECS', 'ListServersDetails']);
  assert.equal(plan.classification.decision, 'allow');
  assert.equal(plan.safeToRun, true);
});

test('planHcloudCommand marks write command as unsafe without approval', () => {
  const plan = planHcloudCommand(['ECS', 'CreateServers']);
  assert.equal(plan.safeToRun, false);
  assert.equal(plan.classification.decision, 'deny');
});

test('planHcloudCommand adds resource-manifest hint for OBS write operations', () => {
  const plan = planHcloudCommand(['OBS', 'mb', 'obs://test-bucket', '-location=cn-north-4']);
  assert.ok(plan.warnings.some((warning) => typeof warning === 'string' && /resource manifest/i.test(warning)));
  assert.equal(plan.classification.decision, 'deny');
});

test('planHcloudCommand adds no manifest hint for OBS read operations', () => {
  const plan = planHcloudCommand(['OBS', 'ls']);
  assert.ok(!plan.warnings.some((warning) => typeof warning === 'string' && /resource manifest/i.test(warning)));
});

test('createApprovalToken persists hashed/redacted args and never raw secrets', async () => {
  await withTempAuthHome((home) => {
    const token = createApprovalToken(['ECS', 'CreateServers', '--server.adminPass=Secret123!']);
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    assert.ok(existsSync(file), 'approval file must be persisted to disk');
    const raw = readFileSync(file, 'utf8');
    assert.ok(raw.includes(token), 'token must be present in the persisted file');
    assert.ok(!raw.includes('Secret123'), 'plaintext secret must never be written to disk');

    const stored = consumeApprovalToken(token);
    assert.ok(stored);
    assert.equal(stored.argsHash, hashArgs(['ECS', 'CreateServers', '--server.adminPass=Secret123!']));
    assert.ok(Array.isArray(stored.argsRedacted));
    assert.ok(!JSON.stringify(stored).includes('Secret123'));

    // single-use
    assert.equal(consumeApprovalToken(token), null);
  });
});

test('approval token survives a fresh file read (cross-process) and expires by TTL', async () => {
  await withTempAuthHome((home) => {
    const token = createApprovalToken(['OBS', 'mb', 'obs://bucket']);
    // consume reads from the file (single source of truth), not from a memory map
    const stored = consumeApprovalToken(token);
    assert.equal(stored!.argsHash, hashArgs(['OBS', 'mb', 'obs://bucket']));

    // TTL: backdate an entry to before the window and expect null
    const ttlToken = createApprovalToken(['OBS', 'rm', 'obs://bucket']);
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    const map = JSON.parse(readFileSync(file, 'utf8'));
    map[ttlToken].createdAt = Date.now() - 6 * 60_000;
    writeFileSync(file, JSON.stringify(map), 'utf8');
    assert.equal(consumeApprovalToken(ttlToken), null);
  });
});

test('runHcloud retries transient network errors and reports retry count', async () => {
  const stateFile = join(fixtureDir('huaweicloud-toolkit-state-'), 'count.txt');
  const script = fakeHcloudScript(`
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const stateFile = ${JSON.stringify(stateFile)};
const count = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0;
writeFileSync(stateFile, String(count + 1));
if (count === 0) {
  console.error('[NETWORK_ERROR]Connection timed out');
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));
`);
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
    maxRetries: 1,
    retryBaseDelayMs: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.retries, 1);
  assert.match(result.stdout!, /ListServersDetails/);
});

test('runHcloud returns a timeout result instead of hanging', async () => {
  const script = fakeHcloudScript('setTimeout(() => {}, 10_000);');
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
    timeoutMs: 50,
    forceKillAfterMs: 50,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TIMEOUT');
  assert.match(result.error!, /timed out/i);
});

test('runHcloud respects cwd parameter', async () => {
  const cwdDir = fixtureDir('huaweicloud-toolkit-cwd-');
  writeFileSync(join(cwdDir, 'test.txt'), 'works', 'utf8');
  const script = fakeHcloudScript(`
import { readFileSync } from 'node:fs';
const content = readFileSync('test.txt', 'utf8');
console.log(content);
`);
  const result = await runHcloud(['test'], {
    executable: process.execPath,
    executableArgs: [script],
    cwd: cwdDir,
  });
  assert.equal(result.ok, true);
  assert.match(result.stdout!, /works/);
});

test('runHcloud captures stderr and returns failed status', async () => {
  const script = fakeHcloudScript(`
console.error('something went wrong');
process.exit(1);
`);
  const result = await runHcloud(['failing'], {
    executable: process.execPath,
    executableArgs: [script],
    maxRetries: 0,
  });
  assert.equal(result.ok, false);
  assert.match(result.stderr!, /something went wrong/);
});

test('runHcloud redacts passwords in output', async () => {
  const script = fakeHcloudScript(`
console.log('adminPass=MySecret123!');
`);
  const result = await runHcloud(['test'], {
    executable: process.execPath,
    executableArgs: [script],
  });
  assert.doesNotMatch(result.stdout!, /MySecret123!/);
});

test('redactOutput redacts bare token= via redactSecrets reuse (#726 D4-27)', () => {
  // Plain-text path: redactOutput falls back to redactSecrets(text).
  const textOut = redactOutput('token=TokenValueABCDEF123456');
  assert.equal(textOut, 'token=<redacted>');
  assert.doesNotMatch(textOut, /TokenValueABCDEF123456/);
  // JSON path: redactOutput parses JSON then redacts via redactSecrets.
  const jsonOut = redactOutput('{"token": "TokenValueABCDEF123456", "note": "keep"}');
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.token, '<redacted>');
  assert.equal(parsed.note, 'keep');
  // No regression on long token-bearing keys and other secrets.
  const reg = redactOutput('security_token=stABC\nx_auth_token=xatABC\npassword=pw1');
  assert.equal(reg, 'security_token=<redacted>\nx_auth_token=<redacted>\npassword=<redacted>');
});

test('redactOutput redacts admin-pass / admin_pass / adminPass variants (#726 D4-27 v2)', () => {
  // Text path: all three separator forms must redact under the /i flag.
  assert.equal(redactOutput('adminPass=Secret123!'), 'adminPass=<redacted>');
  assert.equal(redactOutput('admin-pass=Secret123!'), 'admin-pass=<redacted>');
  assert.equal(redactOutput('admin_pass=Secret123!'), 'admin_pass=<redacted>');
  // JSON path: object-key normalization already classifies all variants.
  const jsonOut = redactOutput('{"admin-pass": "Secret123!", "admin_pass": "v2"}');
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed['admin-pass'], '<redacted>');
  assert.equal(parsed.admin_pass, '<redacted>');
});

test('runHcloud succeeds with active runtime credentials and no KooCLI config (no-crash, no authWarning)', async () => {
  const script = fakeHcloudScript(`
console.log(JSON.stringify({ ok: true }));
`);
  await withTempAuthHome(async () => {
    setRuntimeCredentials('RT_AK', 'RT_SK', undefined, 'cn-north-4');
    const result = await runHcloud(['--version'], {
      executable: process.execPath,
      executableArgs: [script],
    });
    assert.equal(result.ok, true);
    assert.equal(result.authWarning, undefined);
  });
});

test('runHcloud emits authWarning when runtime differs from current profile', async () => {
  const script = fakeHcloudScript(`
console.log(JSON.stringify({ ok: true }));
`);
  await withTempAuthHome(async (home) => {
    const cfgDir = join(home, '.hcloud');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        current: 'deploy',
        profiles: [{ name: 'deploy', accessKeyId: 'CUR_AK', secretAccessKey: 'CUR_SK', region: 'cn-north-4' }],
      }),
      'utf8',
    );
    setRuntimeCredentials('RT_AK', 'RT_SK', undefined, 'cn-north-4');
    const result = await runHcloud(['--version'], {
      executable: process.execPath,
      executableArgs: [script],
    });
    assert.equal(result.ok, true);
    assert.match(result.authWarning!, /KooCLI current/);
  });
});

test(
  'koocli lang G4: approved plan end-to-end does NOT mutate the approved command',
  { skip: process.platform === 'win32' },
  async () => {
    const home = fixtureDir('appr-home-');
    const metaRepo = join(home, '.hcloud', 'metaRepo');
    mkdirSync(metaRepo, { recursive: true });
    writeFileSync(join(metaRepo, 'services_cn.json'), JSON.stringify({ items: [{ Service: { Text: 'BSS' } }] }));
    writeFileSync(join(metaRepo, 'services_en.json'), JSON.stringify({ items: [{ Service: { Text: 'ECS' } }] }));

    const binDir = fixtureDir('appr-bin-');
    const logFile = join(binDir, 'calls.txt');
    const fake = fakeHcloudExecutable(`
import { appendFileSync } from 'node:fs';
const logFile = ${JSON.stringify(logFile)};
const args = process.argv.slice(2);
appendFileSync(logFile, JSON.stringify(args) + '\\n');
console.error('Unsupported service: BSS');
process.exit(1);
`);

    const previousHome = process.env.HOME;
    const previousBin = process.env.HCLOUD_BIN;
    process.env.HOME = home;
    process.env.HCLOUD_BIN = fake;
    try {
      const plan = (await callTool('huaweicloud_plan_cli_command', {
        vendorConfirmed: 'test: vendor established by the harness',
        args: ['BSS', 'ShowCustomerAccountBalances'],
        allowWrites: true,
      })) as HcloudPlan;
      assert.ok(plan.approvalToken, 'plan produces an approvalToken');
      assert.equal(plan.safeToRun, true);
      assert.ok(!plan.args.includes('--cli-lang'), 'approved args carry no lang flag');

      const result = (await callTool('huaweicloud_run_approved_command', {
        vendorConfirmed: 'test: vendor established by the harness',
        args: ['BSS', 'ShowCustomerAccountBalances'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
        maxRetries: 0,
      })) as ApprovedRunResult;
      assert.equal(result.approved, true, 'approved execution flag preserved');
      assert.equal(result.ok, false, 'command itself failed with Unsupported');
      assert.equal(result.langCause, 'lang-missing');
      assert.match(result.langNextStep!, /hcloud configure set --cli-lang=cn/);
      assert.equal(result.injectedLang, undefined, 'no lang flag injected into the approved command');
      assert.equal(result.autoRetried, undefined);

      const calls = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(calls.length, 1, 'exactly one child invocation, command unchanged');
      assert.deepEqual(JSON.parse(calls[0]), ['BSS', 'ShowCustomerAccountBalances']);
    } finally {
      process.env.HOME = previousHome;
      if (previousBin === undefined) delete process.env.HCLOUD_BIN;
      else process.env.HCLOUD_BIN = previousBin;
      rmSync(home, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  },
);

test('koocli lang G4: approval token still rejects args that differ from the approved plan', async () => {
  const plan = (await callTool('huaweicloud_plan_cli_command', {
    vendorConfirmed: 'test: vendor established by the harness',
    args: ['BSS', 'ShowCustomerAccountBalances'],
    allowWrites: true,
  })) as HcloudPlan;
  await assert.rejects(
    callTool('huaweicloud_run_approved_command', {
      vendorConfirmed: 'test: vendor established by the harness',
      args: ['BSS', 'DifferentOperation'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    }),
    /do not match the approved plan/,
  );
});

test('koocli lang: extractApiError keeps JSON keys stable under Chinese KooCLI output', () => {
  const result = extractApiError(
    'ListVpcs有多个版本,默认使用该API版本v3{ "error_code": "BSS.0001", "error_msg": "指定余额不足" }',
  );
  assert.equal(result!.errorCode, 'BSS.0001');
  assert.equal(result!.errorMessage, '指定余额不足');
});

test('runHcloud surfaces Chinese-mode KooCLI JSON error with code and message', async () => {
  const metaDir = withMetaRepo({
    'services_cn.json': [{ Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  const script = fakeHcloudScript(`
console.log('ListVpcs有多个版本,默认使用该API版本v3' + '{ "error_code": "BSS.0001", "error_msg": "指定余额不足" }');
process.exit(1);
`);
  try {
    const result = await runHcloud(['ECS', 'ListServersDetails'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      metaDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'BSS.0001');
    assert.equal(result.errorMessage, '指定余额不足');
  } finally {
    rmSync(metaDir, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('resolveStsInjectArgs returns empty for long-lived creds (no token)', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('AK_NO_TOKEN', 'SK_NO_TOKEN', '');
  assert.deepEqual(resolveStsInjectArgs(['ECS', 'ListServersDetails']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs injects STS args for live runtime tokens', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  const injected = resolveStsInjectArgs(['VPC', 'ListVpcs']);
  assert.deepEqual(injected, ['--cli-access-key=STS_AK', '--cli-secret-key=STS_SK', '--cli-security-token=STS_TOKEN']);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs uses obsutil -i/-k/-t for OBS subcommands', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  const injected = resolveStsInjectArgs(['OBS', 'ls']);
  assert.deepEqual(injected, ['-i', 'STS_AK', '-k', 'STS_SK', '-t', 'STS_TOKEN']);
  clearRuntimeCredentials();
});

test('runHcloud appends STS args to executed command when runtime token is set', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));');
    clearRuntimeCredentials();
    setRuntimeCredentials('RUN_AK', 'RUN_SK', 'RUN_TOKEN', 'cn-north-4');
    const result = await runHcloud(['VPC', 'ListVpcs'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.stdout!) as FakeHcloudOutput;
    // Secret values are redacted to `<redacted>`; presence proves injection.
    assert.ok(
      parsed.args.some((a) => a.startsWith('--cli-security-token=')),
      JSON.stringify(parsed.args),
    );
    assert.ok(parsed.args.some((a) => a.startsWith('--cli-access-key=')));
    assert.ok(parsed.args.some((a) => a.startsWith('--cli-secret-key=')));
    clearRuntimeCredentials();
  });
});

test('per-call env cannot bypass binary resolution with a stale HCLOUD_BIN', { skip: isWin }, async () => {
  const home = fixtureDir('huaweicloud-toolkit-stale-home-');
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, 'hcloud');
  writeFileSync(
    fake,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));\n',
    'utf8',
  );
  chmodSync(fake, 0o755);
  // HOME redirected and the fake named `hcloud` on a prepended PATH so the
  // candidate tier cannot answer with a machine's real install.
  const savedPath = process.env.PATH;
  const savedBin = process.env.HCLOUD_BIN;
  const savedHome = process.env.HOME;
  process.env.PATH = `${binDir}${delimiter}${savedPath || ''}`;
  delete process.env.HCLOUD_BIN;
  process.env.HOME = home;
  try {
    const result = await runHcloud(['VPC', 'ListVpcs'], {
      env: { HCLOUD_BIN: join(binDir, 'no-such-binary') },
      maxRetries: 0,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const parsed = JSON.parse(result.stdout!) as FakeHcloudOutput;
    assert.deepEqual(parsed.args.slice(0, 2), ['VPC', 'ListVpcs'], 'the PATH fake answered');
  } finally {
    process.env.PATH = savedPath;
    if (savedBin === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = savedBin;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test('runHcloud does NOT inject STS args for long-lived creds (no token)', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));');
    clearRuntimeCredentials();
    const result = await runHcloud(['VPC', 'ListVpcs'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.stdout!) as FakeHcloudOutput;
    const injected = parsed.args.filter((a) => a.startsWith('--cli-security-token='));
    assert.equal(injected.length, 0, JSON.stringify(parsed.args));
  });
});

test('resolveStsInjectArgs skips help/metadata commands', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['--help']), []);
  assert.deepEqual(resolveStsInjectArgs(['ECS', '--help']), []);
  assert.deepEqual(resolveStsInjectArgs(['help']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs skips bash/sudo wrapper invocations', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['bash', '-c', 'hcloud ECS ListServersDetails']), []);
  assert.deepEqual(resolveStsInjectArgs(['sudo', 'hcloud', 'ECS', 'ListServersDetails']), []);
  assert.deepEqual(resolveStsInjectArgs(['/bin/sh', '-c', 'hcloud ECS ListServersDetails']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs skips configure/config and existing explicit creds', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['configure', 'set']), []);
  assert.deepEqual(resolveStsInjectArgs(['config', 'list']), []);
  assert.deepEqual(resolveStsInjectArgs(['ECS', 'ListServersDetails', '--cli-access-key=EXPLICIT']), []);
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-i', 'EXPLICIT']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs honors HUAWEICLOUD_INJECT_STS_CMD=0 kill switch', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  const prev = process.env.HUAWEICLOUD_INJECT_STS_CMD;
  try {
    process.env.HUAWEICLOUD_INJECT_STS_CMD = '0';
    assert.deepEqual(resolveStsInjectArgs(['VPC', 'ListVpcs']), []);
  } finally {
    if (prev === undefined) delete process.env.HUAWEICLOUD_INJECT_STS_CMD;
    else process.env.HUAWEICLOUD_INJECT_STS_CMD = prev;
  }
  clearRuntimeCredentials();
});

test('runHcloud redacts injected STS from returned plan.rawArgs', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true }));');
    clearRuntimeCredentials();
    setRuntimeCredentials('RUN_AK', 'RUN_SK', 'RUN_TOKEN', 'cn-north-4');
    const result = await runHcloud(['VPC', 'ListVpcs'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const redactedArgs = result.plan!.rawArgs;
    assert.ok(Array.isArray(redactedArgs));
    // Injected STS must be redacted, not present in cleartext.
    assert.ok(redactedArgs.some((a) => a.startsWith('--cli-security-token=')));
    assert.ok(!redactedArgs.includes('--cli-security-token=RUN_TOKEN'));
    assert.ok(!redactedArgs.includes('--cli-access-key=RUN_AK'));
    assert.ok(!redactedArgs.includes('--cli-secret-key=RUN_SK'));
    clearRuntimeCredentials();
  });
});

test('resolveStsInjectArgs skips injection when security token is expired (R3)', () => {
  clearRuntimeCredentials();
  const past = Math.floor(Date.now() / 1000) - 120; // expired 2 min ago
  const token = Buffer.from(JSON.stringify({ exp: past })).toString('base64url');
  setRuntimeCredentials('STS_AK', 'STS_SK', token, 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['VPC', 'ListVpcs']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs skips injection when expiry is within 60s grace (R3)', () => {
  clearRuntimeCredentials();
  const soon = Math.floor(Date.now() / 1000) + 30; // expires in 30s
  const token = Buffer.from(JSON.stringify({ exp: soon })).toString('base64url');
  setRuntimeCredentials('STS_AK', 'STS_SK', token, 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['VPC', 'ListVpcs']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs still injects when expiry is unparseable (R3 fallback)', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'HSTANOTATOKEN', 'cn-north-4');
  const injected = resolveStsInjectArgs(['VPC', 'ListVpcs']);
  assert.ok(injected.length > 0);
  assert.ok(injected.some((a) => a.startsWith('--cli-security-token=')));
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs injects when expiry is in the future (R3)', () => {
  clearRuntimeCredentials();
  const future = Math.floor(Date.now() / 1000) + 3600; // 1h out
  const token = Buffer.from(JSON.stringify({ exp: future })).toString('base64url');
  setRuntimeCredentials('STS_AK', 'STS_SK', token, 'cn-north-4');
  const injected = resolveStsInjectArgs(['VPC', 'ListVpcs']);
  assert.ok(injected.some((a) => a.startsWith('--cli-security-token=')));
  clearRuntimeCredentials();
});

test('redactArgsWithObs redacts obsutil -i/-k/-t standalone values', () => {
  const out = redactArgsWithObs(['OBS', 'ls', '-i', 'SOME_AK', '-k', 'SOME_SK', '-t', 'SOME_TOKEN']);
  assert.deepEqual(out, ['OBS', 'ls', '-i', '<redacted>', '-k', '<redacted>', '-t', '<redacted>']);
});

test('redactArgsWithObs redacts hcloud key=value form and leaves non-secrets', () => {
  const out = redactArgsWithObs(['VPC', 'ListVpcs', '--cli-access-key=AK', '--cli-region=cn-south-1']);
  assert.ok(out.some((a) => a === '--cli-access-key=<redacted>'));
  assert.ok(out.includes('--cli-region=cn-south-1'));
});

test('runHcloud redacts OBS STS args from returned plan.rawArgs', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true }));');
    clearRuntimeCredentials();
    setRuntimeCredentials('OBS_AK', 'OBS_SK', 'OBS_TOKEN', 'cn-south-1');
    const result = await runHcloud(['OBS', 'ls'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const raw = result.plan!.rawArgs;
    // The injected OBS STS values must be redacted, not in cleartext.
    const joined = raw.join(' ');
    assert.ok(!joined.includes('OBS_AK'));
    assert.ok(!joined.includes('OBS_SK'));
    assert.ok(!joined.includes('OBS_TOKEN'));
    // -i / -k / -t placeholders present.
    assert.ok(joined.includes('-i <redacted>') || joined.includes('-i<redacted>'), JSON.stringify(raw));
    clearRuntimeCredentials();
  });
});

test('resolveStsInjectArgs skips when obsutil attached -iAK/-kSK/-tTOK present', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-iAK_VAL']), []);
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-kSK_VAL', '-tTOK_VAL']), []);
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-iAK_VAL', '-d']), []);
  clearRuntimeCredentials();
});

// ── CREDENTIAL_EXPIRED fast-fail (#919 follow-up UX) ────────────────────────

test('A: runHcloud fails fast with CREDENTIAL_EXPIRED for expired temp STS (no exec)', async () => {
  await withTempAuthHome(async () => {
    const marker = join(fixtureDir('hcdk-gate-'), 'ran.txt');
    const script = fakeHcloudScript(`
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'executed', 'utf8');
console.log(JSON.stringify({ ok: true }));
`);
    const past = Math.floor(Date.now() / 1000) - 300; // expired 5 min ago
    const token = Buffer.from(JSON.stringify({ exp: past })).toString('base64url');
    clearRuntimeCredentials();
    setRuntimeCredentials('GATE_AK', 'GATE_SK', token, 'cn-north-4');
    const result = await runHcloud(['VPC', 'ListVpcs'], {
      executable: process.execPath,
      executableArgs: [script],
    });
    clearRuntimeCredentials();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CREDENTIAL_EXPIRED');
    assert.match(result.error ?? '', /STS.*expired/i);
    assert.ok(!existsSync(marker), 'expired STS must not reach hcloud spawn');
  });
});

// Driver for the never-gated family: set a runtime credential shape, run a
// harmless read through a fake hcloud, and clear the runtime store again.
async function runWithRuntimeCreds(
  ak: string,
  sk: string,
  securityToken: string | undefined,
): Promise<HcloudRunResult> {
  const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));');
  clearRuntimeCredentials();
  setRuntimeCredentials(ak, sk, securityToken, 'cn-north-4');
  try {
    return await runHcloud(['VPC', 'ListVpcs'], {
      executable: process.execPath,
      executableArgs: [script],
    });
  } finally {
    clearRuntimeCredentials();
  }
}

test('A: runHcloud does NOT gate permanent AK/SK (no token) when none expired', async () => {
  await withTempAuthHome(async () => {
    const result = await runWithRuntimeCreds('GATE_PERM_AK', 'GATE_PERM_SK', undefined);
    assert.equal(result.ok, true);
    assert.ok(result.code !== 'CREDENTIAL_EXPIRED', 'permanent AK/SK must never be gated');
  });
});

test('A: runHcloud does NOT gate an unparseable-expiry STS token (unknown → inject anyway)', async () => {
  await withTempAuthHome(async () => {
    const result = await runWithRuntimeCreds('GATE_UNK_AK', 'GATE_UNK_SK', 'not-a-parseable-token');
    assert.equal(result.ok, true);
    assert.ok(result.code !== 'CREDENTIAL_EXPIRED', 'unknown expiry must not be treated as expired');
  });
});

// ── D4-24 (#745): approval token precise JSON contract ─────────────────────

test('inspectApprovalToken classifies a fresh token as valid', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'valid');
    assert.ok(inspection.entry, 'valid state carries the stored entry');
    assert.equal(inspection.entry.argsHash, hashArgs(['ECS', 'ListServersDetails']));
  });
});

// Backdate a stored token past the 5-minute TTL.
function backdateToken(home: string, token: string): void {
  const file = join(home, '.config', 'huaweicloud', 'approvals.json');
  const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { createdAt: number }>;
  map[token]!.createdAt = Date.now() - 6 * 60_000;
  writeFileSync(file, JSON.stringify(map), 'utf8');
}

test('inspectApprovalToken classifies an expired token as expired', async () => {
  await withTempAuthHome((home) => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    backdateToken(home, token);

    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'expired');
    assert.equal(inspection.entry, undefined, 'expired state does not leak the entry');
  });
});

test('inspectApprovalToken classifies an already-consumed token as already_consumed', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const first = consumeApprovalToken(token);
    assert.ok(first, 'first consume returns the stored entry');

    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'already_consumed');
  });
});

test('inspectApprovalToken classifies an unknown token as not_found', async () => {
  await withTempAuthHome(() => {
    const inspection = inspectApprovalToken('never-created-uuid');
    assert.equal(inspection.state, 'not_found');
  });
});

test('consumeApprovalToken keeps a tombstone so the second call is distinguishable from not_found', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const first = consumeApprovalToken(token);
    assert.ok(first);
    // Second consume still returns null (backward compatible), but
    // inspectApprovalToken must report already_consumed, not not_found.
    assert.equal(consumeApprovalToken(token), null);
    assert.equal(inspectApprovalToken(token).state, 'already_consumed');
  });
});

// D4-24 drivers: plan an approval and run it under a fake HCLOUD_BIN, with
// the env restored either way.
async function withFakeHcloudBin<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeHcloudExecutable('console.log(JSON.stringify({ ok: true }));');
  const prevBin = process.env.HCLOUD_BIN;
  process.env.HCLOUD_BIN = fake;
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = prevBin;
  }
}

async function planApproval(): Promise<string> {
  const plan = (await callTool('huaweicloud_plan_cli_command', {
    args: ['ECS', 'ListServersDetails'],
  })) as HcloudPlan;
  assert.ok(plan.approvalToken);
  return plan.approvalToken;
}

async function runApproved(token: string): Promise<ToolArgs> {
  return (await callTool('huaweicloud_run_approved_command', {
    args: ['ECS', 'ListServersDetails'],
    approvalToken: token,
    approvedByUser: true,
    maxRetries: 0,
  })) as ToolArgs;
}

test('runApprovedCommand: expired token returns {status:rejected, code:CONFIRM_TOKEN_EXPIRED}', async () => {
  await withTempAuthHome(async (home) => {
    await withFakeHcloudBin(async () => {
      const token = await planApproval();
      backdateToken(home, token);

      const result = (await runApproved(token)) as { status: string; code: string };
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'CONFIRM_TOKEN_EXPIRED');
    });
  });
});

test('runApprovedCommand: same token submitted twice returns {status:ok, outcome:already_processed}', async () => {
  await withTempAuthHome(async () => {
    await withFakeHcloudBin(async () => {
      const token = await planApproval();

      const first = (await runApproved(token)) as ApprovedRunResult;
      assert.equal(first.approved, true, 'first call executes the command');

      const second = (await runApproved(token)) as { status: string; outcome: string };
      assert.equal(second.status, 'ok');
      assert.equal(second.outcome, 'already_processed');
    });
  });
});

test('runApprovedCommand: unknown token returns {status:rejected, code:CONFIRM_TOKEN_NOT_FOUND}', async () => {
  await withTempAuthHome(async () => {
    const result = (await callTool('huaweicloud_run_approved_command', {
      args: ['ECS', 'ListServersDetails'],
      approvalToken: 'never-created-uuid',
      approvedByUser: true,
      maxRetries: 0,
    })) as { status: string; code: string };
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'CONFIRM_TOKEN_NOT_FOUND');
  });
});

test('tombstones age out: an aged tombstone inspects as not_found, not already_consumed', async () => {
  await withTempAuthHome(async (home) => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    assert.ok(consumeApprovalToken(token), 'first consume wins');

    // Age the TOMBSTONE past the TTL (createdAt is the original mint time).
    backdateToken(home, token);
    const inspection = inspectApprovalToken(token);
    assert.equal(
      inspection.state,
      'not_found',
      'an aged tombstone must read as not_found — the same answer the next mint prune gives',
    );

    // And the next unrelated mint prunes it from the store entirely.
    createApprovalToken(['OBS', 'ls']);
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.ok(!(token in map), 'the aged tombstone is pruned by the mint');
  });
});

// ── #921: CLI ok-judgment holes ─────────────────────────────────────────────

test('#921: exit 0 with a KooCLI parameter error reports ok:false with PARAM_ERROR', async () => {
  const script = fakeHcloudScript(`
console.error("[USE_ERROR]: unknown parameter delete_ip");
process.exit(0);
`);
  const result = await runHcloud(['ECS', 'ListServersDetails', '--delete_ip=x'], {
    executable: process.execPath,
    executableArgs: [script],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, false, 'a parameter error must never read as success');
  assert.equal(result.errorCode, 'PARAM_ERROR');
  assert.match(result.errorMessage ?? '', /unknown parameter delete_ip/);
});

test('#921: exit 0 with a Chinese parameter error is caught too', async () => {
  const script = fakeHcloudScript(`
console.error("[USE_ERROR]: 参数错误: 不正确的参数 delete_ip");
process.exit(0);
`);
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PARAM_ERROR');
});

test('#921: "successfully" heuristic applies ONLY to OBS commands without error indicators', async () => {
  // Non-OBS command, non-zero exit, "successfully" in output: NOT ok.
  const nonObs = fakeHcloudScript(`
console.log("Warning: fallback succeeded but 3 objects were NOT deleted successfully");
process.exit(1);
`);
  const bad = await runHcloud(['ECS', 'ListServersDetails', '--limit=1'], {
    executable: process.execPath,
    executableArgs: [nonObs],
  });
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.ok, false, 'a failing non-OBS command mentioning "successfully" must not pass');

  // OBS obsutil-style command: known to exit non-zero on success (#57).
  const obs = fakeHcloudScript(`
console.log("List bucket objects successfully");
process.exit(1);
`);
  const good = await runHcloud(['obs', 'ls', 'obs://bucket/'], {
    executable: process.execPath,
    executableArgs: [obs],
  });
  assert.equal(good.ok, true, 'OBS success output with a non-zero exit stays ok');

  // OBS command with an error indicator: NOT ok.
  const obsErr = fakeHcloudScript(`
console.log("List bucket objects successfully");
console.error("error: 2 objects failed");
process.exit(1);
`);
  const bad2 = await runHcloud(['obs', 'ls', 'obs://bucket/'], {
    executable: process.execPath,
    executableArgs: [obsErr],
  });
  assert.equal(bad2.ok, false, 'OBS output carrying error indicators must not pass');
});

test('#921: timeout and spawn-error results carry exitCode/signal fields', async () => {
  // Timeout path (from the existing timeout test's shape, now asserting the
  // exitCode/signal fields exist).
  const script = fakeHcloudScript('setTimeout(() => {}, 10_000);');
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
    timeoutMs: 300,
  });
  assert.equal(result.code, 'TIMEOUT');
  // The close-path TIMEOUT carries the child's exitCode/signal (or null on
  // the settle backstop) — the fields must always be present.
  assert.equal('exitCode' in result, true, 'timeout results must carry exitCode');
  assert.equal('signal' in result, true, 'timeout results must carry signal');
});

test('#921 D3-B7: spawn-error results carry exitCode:null, signal:null, and the SPAWN_ERROR code', async () => {
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: '/nonexistent/hcloud-binary-xyz',
    maxRetries: 0,
  });
  assert.equal(result.code, 'SPAWN_ERROR');
  assert.equal('exitCode' in result, true, 'spawn-error results must carry exitCode');
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
});

test('#921 residual: obsutil zero-count summaries do not veto a successful OBS run', async () => {
  const obs = fakeHcloudScript(`
console.log("List bucket objects successfully");
console.log("Failed count: 0");
process.exit(1);
`);
  const result = await runHcloud(['obs', 'ls', 'obs://bucket/'], {
    executable: process.execPath,
    executableArgs: [obs],
  });
  assert.equal(result.ok, true, 'a "Failed count: 0" summary line is not an error');

  const obsRealFail = fakeHcloudScript(`
console.log("List bucket objects successfully");
console.log("Failed count: 2");
process.exit(1);
`);
  const failed = await runHcloud(['obs', 'ls', 'obs://bucket/'], {
    executable: process.execPath,
    executableArgs: [obsRealFail],
  });
  assert.equal(failed.ok, false, 'a non-zero failure count still vetoes');
});

test('KooCLI 7.3.12 pin: the OBS write-subcommand advisory covers the new names', () => {
  // The plan advisory (OBS_WRITE_SUBCOMMANDS) fires for the eleven denied
  // obsutil writes (the 7.3.12 additions plus the pre-existing catches) —
  // its vocabulary has no other regression pin.
  for (const op of [
    'bucket-tagging',
    'object-tagging',
    'encryption',
    'custom-domain',
    'mirror-back-to-source',
    'put-public-access-block',
    'delete-public-access-block',
    'abort',
    'archive',
    'create-share',
    'update',
  ]) {
    // custom-domain's real flag form is -cname/certificate options (not
    // -method); the other ten are -method or full-name writes.
    const opArgs = op === 'custom-domain' ? ['-cname=x.com'] : ['-method=put'];
    const plan = planHcloudCommand(['OBS', op, 'obs://bucket', ...opArgs], { allowWrites: false });
    assert.equal(plan.safeToRun, false, `OBS ${op} must not read as safe to run`);
    // The advisory lands in plan.warnings (the OBS mb pin's shape) — asserting
    // the reason regex alone would pass for every OBS deny regardless of
    // OBS_WRITE_SUBCOMMANDS membership.
    assert.ok(
      plan.warnings.some((w) => typeof w === 'string' && /resource manifest/i.test(w)),
      `OBS ${op} should carry the obsutil batch-approval advisory in plan.warnings`,
    );
  }
  // Read controls stay advisory-free.
  const read = planHcloudCommand(['OBS', 'get-public-access-block', 'obs://bucket'], { allowWrites: false });
  assert.equal(read.safeToRun, true);
});

// A4 (#935): the KooCLI 7.2.x per-command version-upgrade banner must never
// reach agent-facing output; the DevKit one-shot upgrade hint (check_cli /
// doctor's soft mismatch hint) is the only sanctioned upgrade nudge.
test('stripKooCliUpdateBanner removes the KooCLI 7.2.x upgrade banner line (#935 A4)', () => {
  const raw = ['可执行 hcloud update 更新至 7.3.12', '{', '  "servers": []', '}'].join('\n');
  const cleaned = stripKooCliUpdateBanner(raw);
  assert.ok(!cleaned.includes('可执行 hcloud update 更新至 7.3.12'), 'banner line must be removed');
  assert.match(cleaned, /servers/, 'the real output must survive');
});

test('stripKooCliUpdateBanner keeps real output and the DevKit one-shot upgrade hint (#935 A4)', () => {
  // The version-mismatch hint DevKit itself emits (check_cli/doctor soft hint)
  // must NOT be stripped — only the per-command KooCLI banner is.
  const hint =
    'KooCLI version mismatch: installed 7.2.12, paired 7.3.12. Run "npx huaweicloud-devkit update" to upgrade.';
  assert.equal(stripKooCliUpdateBanner(hint), hint, 'the DevKit upgrade hint must be preserved verbatim');

  const normal = 'ListVpcs有多个版本,默认使用该API版本v3\n{"vpcs":[]}';
  assert.equal(stripKooCliUpdateBanner(normal), normal, 'normal multi-version prefix lines are untouched here');
});

test('runHcloud strips the KooCLI update banner from command output (#935 A4)', async () => {
  const dir = fixtureDir('huaweicloud-banner-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(
    script,
    'console.log("可执行 hcloud update 更新至 7.3.12");\nconsole.log(\'{"result":"ok"}\');\n',
    'utf8',
  );
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
  });
  assert.ok(!String(result.stdout).includes('hcloud update 更新至'), 'banner must not reach tool output');
  assert.match(String(result.stdout), /result/, 'real output must survive');
});

test('redactOutput strips the banner before JSON extraction (#935 A4 wiring)', () => {
  // The banner precedes the JSON body — redactOutput's bracket-slice must see
  // output whose first line is already the real content.
  const cleaned = redactOutput('可执行 hcloud update 更新至 7.3.12\n{"result":"ok"}');
  assert.ok(!cleaned.includes('hcloud update'), 'the banner must be gone');
  assert.match(cleaned, /"result"/);
});
