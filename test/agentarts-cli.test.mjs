import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  planAgentartsCommand,
  runAgentartsReadonlyCommand,
  runAgentartsApprovedCommand,
  AGENTARTS_TOOL_DEFINITIONS,
  callAgentartsTool,
} from '../plugins/huaweicloud-core/src/agentarts-cli.mjs';
import { createApprovalToken } from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';
import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';
import { classifyTextCommand, resolveAgentartsTier } from '../plugins/huaweicloud-core/src/safety-policy.mjs';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.mjs';

// Spawn-based tests need an executable stub: skip them on platforms without
// POSIX shell scripts (CI parity with the python-hook skip pattern).
const canSpawnStub = process.platform !== 'win32';

async function withIsolation(fn) {
  const home = mkdtempSync(join(tmpdir(), 'agentarts-wrapper-'));
  const previousHome = process.env.HUAWEICLOUD_HOME;
  const previousBin = process.env.AGENTARTS_BIN;
  process.env.HUAWEICLOUD_HOME = home;
  let stubPath;
  if (canSpawnStub) {
    stubPath = join(home, 'agentarts-stub.sh');
    writeFileSync(
      stubPath,
      [
        '#!/bin/bash',
        'case " $* " in',
        '  *" --stub-creds "*)',
        '    echo "ak: $HUAWEICLOUD_SDK_AK"',
        '    echo "sk: $HUAWEICLOUD_SDK_SK"',
        '    echo "sentinel: [${STUB_SENTINEL}]"',
        '    exit 0;;',
        '  *" --stub-traceback "*)',
        '    echo "Traceback (most recent call last):"',
        '    echo "agentarts.toolkit - ERROR - boom"',
        '    exit 0;;',
        '  *" --stub-stdin "*)',
        '    if read -t 2 line; then echo "STDIN_LEAK: $line" >&2; exit 1; fi',
        '    echo "OK"',
        '    exit 0;;',
        '  *)',
        '    echo \'{"items":[]}\'',
        '    exit 0;;',
        'esac',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 },
    );
    chmodSync(stubPath, 0o755);
    process.env.AGENTARTS_BIN = stubPath;
  }
  try {
    return await fn({ home, stubPath });
  } finally {
    if (previousHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = previousHome;
    if (previousBin === undefined) delete process.env.AGENTARTS_BIN;
    else process.env.AGENTARTS_BIN = previousBin;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
}

test('plan classifies tiers, normalizes aliases, and canonicalizes destroy', async () => {
  await withIsolation(() => {
    const readonly = planAgentartsCommand(['memory', 'list', '--region', 'cn-southwest-2']);
    assert.equal(readonly.ok, true);
    assert.equal(readonly.tier, 'readonly');
    assert.equal(readonly.safeToRun, true);
    assert.equal(readonly.approvalToken, undefined);

    const launch = planAgentartsCommand(['launch']);
    assert.equal(launch.tier, 'approved');
    assert.deepEqual(launch.labels, ['billing']);
    assert.equal(typeof launch.approvalToken, 'string');
    assert.match(launch.approvalGuidance, /approval/i);

    // deploy is an alias of launch: same normalized operation, token binds.
    const deploy = planAgentartsCommand(['deploy']);
    assert.equal(deploy.operation, 'launch');
    assert.equal(deploy.tier, 'approved');

    // destroy canonicalizes to --yes; the token binds to the canonical form.
    const destroy = planAgentartsCommand(['destroy']);
    assert.deepEqual(destroy.args, ['destroy', '--yes']);
    assert.equal(destroy.tier, 'approved');
    assert.match(destroy.command, /destroy --yes/);

    const local = planAgentartsCommand(['init', '-n', 'demo', '-t', 'basic', '-r', 'cn-southwest-2']);
    assert.equal(local.tier, 'local');
    assert.match(local.executionBlock, /Bash/i);

    const blocked = planAgentartsCommand(['memory', 'create', '--name', 'x']);
    assert.equal(blocked.tier, 'blocked');
    assert.match(blocked.executionBlock, /deferred/i);
    assert.equal(blocked.approvalToken, undefined);
  });
});

test('plan hard-stops bearer tokens, bare config, interactive gateway deletes, and missing install target', async () => {
  await withIsolation(() => {
    const bearer = planAgentartsCommand(['invoke', '--bearer-token', 'tok123']);
    assert.equal(bearer.ok, false);
    assert.match(bearer.error, /bearer-token/i);
    const bearerShort = planAgentartsCommand(['invoke', '-bt', 'tok123']);
    assert.equal(bearerShort.ok, false);

    const bareConfig = planAgentartsCommand(['config']);
    assert.equal(bareConfig.safeToRun, false);
    assert.match(bareConfig.executionBlock, /wizard|subcommand/i);
    assert.equal(bareConfig.approvalToken, undefined);

    const gatewayDelete = planAgentartsCommand(['gateway', 'delete', '123']);
    assert.equal(gatewayDelete.safeToRun, false);
    assert.match(gatewayDelete.executionBlock, /no skip flag|terminal/i);
    assert.equal(gatewayDelete.approvalToken, undefined);

    const installNoTarget = planAgentartsCommand(['memory', 'install']);
    assert.equal(installNoTarget.safeToRun, false);
    assert.match(installNoTarget.executionBlock, /target/i);

    const installOk = planAgentartsCommand(['memory', 'install', 'opencode', '--yes']);
    assert.equal(installOk.tier, 'approved');
    assert.equal(typeof installOk.approvalToken, 'string');
  });
});

test('plan marks unknown commands fail-safe and suggests --help', async () => {
  await withIsolation(() => {
    const unknown = planAgentartsCommand(['newsubcommand', '--flag']);
    assert.equal(unknown.tier, 'approved');
    assert.equal(typeof unknown.approvalToken, 'string');
    assert.ok(unknown.warnings.some((w) => /--help/.test(w)));

    const unknownSub = planAgentartsCommand(['memory', 'newsub']);
    assert.equal(unknownSub.tier, 'approved');
    assert.ok(unknownSub.warnings.some((w) => /--help/.test(w)));
  });
});

test('wrapper tier equals the hook decision for the same vectors (single classification source)', async () => {
  await withIsolation(() => {
    const cases = [
      [['memory', 'list'], 'allow'],
      [['gateway', 'list-targets', '123'], 'allow'],
      [['init'], 'allow'],
      [['launch'], 'deny'],
      [['destroy'], 'deny'],
      [['config', 'set', 'base.region', 'x'], 'deny'],
      [['memory', 'create'], 'deny'],
      [['memory', 'install', 'opencode', '--yes'], 'deny'],
      [['runtime', 'exec-command', 'ls'], 'deny'],
      [['newsub'], 'deny'],
    ];
    for (const [args, hookDecision] of cases) {
      const hook = classifyTextCommand(`agentarts ${args.join(' ')}`);
      assert.equal(hook.decision, hookDecision, `hook: ${args.join(' ')}`);
      const tier = resolveAgentartsTier(args).tier;
      const expectedTier = hookDecision === 'deny' ? ['approved', 'blocked'] : ['local', 'readonly'];
      assert.ok(expectedTier.includes(tier), `tier ${tier} must match hook ${hookDecision}: ${args.join(' ')}`);
    }
  });
});

test('readonly run executes the stub, parses output, and redacts credential-shaped values', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    process.env.STUB_SENTINEL = 'leaky';
    const ok = await runAgentartsReadonlyCommand(['memory', 'list', '--stub-creds']);
    delete process.env.STUB_SENTINEL;
    assert.equal(ok.ok, true);
    // Injection + redaction compose: the child SAW the credentials (it echoes
    // them), but the returned output carries only the redacted forms.
    assert.match(ok.stdout, /ak=<redacted>/);
    assert.match(ok.stdout, /sk=<redacted>/);
    assert.doesNotMatch(JSON.stringify(ok), /AKVALUE123|SKVALUE456/);
    // Allowlist env: the ambient sentinel never reached the child (empty).
    assert.match(ok.stdout, /sentinel: \[\]/);

    const failure = await runAgentartsReadonlyCommand(['memory', 'list', '--stub-traceback']);
    assert.equal(failure.ok, false);
    assert.equal(failure.failureDetected, true);
    // Exit code lies in 0.1.7 — success is decided by output parsing only.
    assert.equal(failure.exitCode, 0);
  });
});

test('readonly run rejects non-readonly tiers and bearer tokens', async () => {
  await withIsolation(async () => {
    const approved = await runAgentartsReadonlyCommand(['launch']);
    assert.equal(approved.ok, false);
    assert.match(approved.error, /run_approved/);
    const blocked = await runAgentartsReadonlyCommand(['memory', 'create']);
    assert.equal(blocked.ok, false);
    const bearer = await runAgentartsReadonlyCommand(['memory', 'list', '--bearer-token', 'x']);
    assert.equal(bearer.ok, false);
    assert.match(bearer.error, /bearer-token/i);
  });
});

test('approved run enforces the token lifecycle and args binding', async () => {
  await withIsolation(async () => {
    const plan = planAgentartsCommand(['launch', '--stub-ok']);
    const token = plan.approvalToken;

    const run = await runAgentartsApprovedCommand({
      args: ['launch', '--stub-ok'],
      approvalToken: token,
      approvedByUser: true,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.approved, true);
    assert.equal(run.ok, true);

    const second = await runAgentartsApprovedCommand({
      args: ['launch', '--stub-ok'],
      approvalToken: token,
      approvedByUser: true,
    });
    assert.equal(second.status, 'ok');
    assert.equal(second.outcome, 'already_processed');

    const notFound = await runAgentartsApprovedCommand({
      args: ['launch', '--stub-ok'],
      approvalToken: 'never-issued',
      approvedByUser: true,
    });
    assert.equal(notFound.status, 'rejected');
    assert.equal(notFound.code, 'CONFIRM_TOKEN_NOT_FOUND');

    await assert.rejects(
      runAgentartsApprovedCommand({ args: ['launch', '--stub-ok'], approvalToken: 'x', approvedByUser: false }),
      /approvedByUser/,
    );

    // Tampered args do not match the approved plan.
    const plan2 = planAgentartsCommand(['launch', '--stub-ok']);
    await assert.rejects(
      runAgentartsApprovedCommand({
        args: ['destroy', '--yes'],
        approvalToken: plan2.approvalToken,
        approvedByUser: true,
      }),
      /do not match the approved plan/i,
    );
  });
});

test('approval tokens cannot cross CLI namespaces', async () => {
  await withIsolation(async () => {
    // A token minted by the hcloud wrapper with the IDENTICAL args array.
    const hcloudToken = createApprovalToken(['launch', '--stub-ok']);
    const r = await runAgentartsApprovedCommand({
      args: ['launch', '--stub-ok'],
      approvalToken: hcloudToken,
      approvedByUser: true,
    });
    assert.equal(r.status, 'rejected');
    assert.equal(r.code, 'CONFIRM_TOKEN_NOT_FOUND');
  });
});

test('approved run never writes stdin (prompts EOF-abort, no blind y)', async () => {
  await withIsolation(async () => {
    const plan = planAgentartsCommand(['launch', '--stub-stdin']);
    const run = await runAgentartsApprovedCommand({
      args: ['launch', '--stub-stdin'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.ok, true);
    assert.doesNotMatch(run.stderr || '', /STDIN_LEAK/);
  });
});

test('tool definitions register and dispatch through callTool', async () => {
  await withIsolation(async () => {
    assert.equal(AGENTARTS_TOOL_DEFINITIONS.length, 3);
    const names = AGENTARTS_TOOL_DEFINITIONS.map((t) => t.name);
    assert.deepEqual(names.sort(), [
      'huaweicloud_agentarts_plan_cli_command',
      'huaweicloud_agentarts_run_approved_command',
      'huaweicloud_agentarts_run_readonly_command',
    ]);
    // The schema must not expose a stdin passthrough (the hcloud trio's
    // latent hole is not inherited).
    for (const def of AGENTARTS_TOOL_DEFINITIONS) {
      assert.equal(def.inputSchema.properties.stdin, undefined, def.name);
    }

    const plan = await callTool('huaweicloud_agentarts_plan_cli_command', {
      args: ['memory', 'list'],
    });
    assert.equal(plan.tier, 'readonly');

    const run = await callTool('huaweicloud_agentarts_run_readonly_command', {
      args: ['memory', 'list'],
    });
    assert.equal(run.ok, true);
  });
});

test('agentarts doctor probes CLI version, Python, and Docker (advisory)', async () => {
  const { probeAgentarts, checkAgentarts } = await import('../plugins/huaweicloud-core/src/agentarts-doctor.mjs');
  await withIsolation(async ({ stubPath }) => {
    const probe = probeAgentarts();
    assert.equal(probe.installed, true);
    // The stub does not print the version banner — version-unreadable, still
    // installed, never throws.
    assert.equal(probe.reason, 'version-unreadable');

    // A stub that prints the measured version banner reports the pinned match.
    const versioned = join(stubPath, '..', 'agentarts-versioned.sh');
    writeFileSync(versioned, '#!/bin/bash\necho "agentarts version: 0.1.7"\n', { mode: 0o755 });
    chmodSync(versioned, 0o755);
    process.env.AGENTARTS_BIN = versioned;
    const ok = probeAgentarts();
    assert.equal(ok.version, '0.1.7');
    assert.equal(ok.pinned, '0.1.7');
    assert.equal(ok.versionMatches, true);

    const full = checkAgentarts();
    assert.equal(full.advisory, true);
    assert.equal(typeof full.ok, 'boolean');
    assert.ok(Array.isArray(full.warnings));
    assert.ok(Array.isArray(full.nextSteps));
  });
});
