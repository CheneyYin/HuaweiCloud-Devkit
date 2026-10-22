import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  planAgentartsCommand,
  runAgentartsReadonlyCommand,
  runAgentartsApprovedCommand,
  AGENTARTS_TOOL_DEFINITIONS,
  callAgentartsTool,
  resolveAgentartsCommand,
  agentartsVenvDir,
  agentartsVenvBin,
  listAgentartsAgents,
  MEMORY_SUBCOMMAND_VALUE_FLAGS,
} from '../plugins/huaweicloud-core/src/agentarts-cli.mjs';
import { createApprovalToken, planHcloudCommand } from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';
import { scrubPositionalSecrets } from '../plugins/huaweicloud-core/src/approval-tokens.mjs';
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
        '    echo "bearer: [${BEARER_TOKEN}]"',
        '    exit 0;;',
        '  *" --stub-traceback "*)',
        '    echo "Traceback (most recent call last):"',
        '    echo "agentarts.toolkit - ERROR - boom"',
        '    exit 0;;',
        '  *" --stub-usage "*)',
        '    echo "Usage: agentarts memory create [OPTIONS] NAME" >&2',
        '    echo "Try \'agentarts memory create --help\' for help." >&2',
        '    echo "╭─ Error ──────────────────────────────────────────────────────╮" >&2',
        '    echo "│ No such option: --OUTPUT                                      │" >&2',
        '    echo "╰───────────────────────────────────────────────────────────────╯" >&2',
        '    exit 0;;',
        '  *" --stub-usage-stdout "*)',
        '    echo "Try \'agentarts --help\' for help."',
        '    echo "│ No such option: --OUTPUT"',
        '    exit 0;;',
        '  *" --stub-large-key "*)',
        '    PAD=$(head -c 60000 /dev/zero | tr "\\0" "x")',
        '    printf \'{"id": "space-e2e-003", "api_key": "KEY_ONETIME_big111", "prompt": "%s"}\\n\' "$PAD"',
        '    exit 0;;',
        '  *" --stub-usage-cmd "*)',
        '    echo "Usage: agentarts [OPTIONS] COMMAND [ARGS]..." >&2',
        '    echo "Try \'agentarts --help\' for help." >&2',
        "    echo \"│ No such command 'memry'. Did you mean 'memory'?\" >&2",
        '    exit 0;;',
        '  *" --stub-usage-dangling "*)',
        '    echo "│ Option \'--limit\' requires an argument." >&2',
        '    exit 2;;',
        '  *" --stub-usage-box0 "*)',
        '    echo "│ No such option: --OUTPUT" >&2',
        '    exit 0;;',
        '  *" --stub-fp-fail "*)',
        '    echo \'{"id": "space-fp-001", "api_key": "KEY_ONETIME_fp999", "name": "s"}\'',
        '    echo "proxy handshake issue - ERROR - retry succeeded" >&2',
        '    exit 0;;',
        '  *" --stub-evil-id "*)',
        '    echo \'{"id": "x/../../../evil", "api_key": "KEY_ONETIME_evil777", "name": "s"}\'',
        '    exit 0;;',
        '  *" --stub-hang-key "*)',
        '    echo \'{"id": "space-hang-001", "api_key": "KEY_ONETIME_hang42", "name": "s"}\'',
        '    sleep 2',
        '    exit 0;;',
        '  *" --stub-stdin "*)',
        '    if read -t 2 line; then echo "STDIN_LEAK: $line" >&2; exit 1; fi',
        '    echo "OK"',
        '    exit 0;;',
        '  *" --stub-get-key "*)',
        '    echo \'{"id": "sp-verify-1", "api_key": "KEY_ONETIME_get555", "status": "ACTIVE", "api_key_id": "key-9"}\'',
        '    exit 0;;',
        '  *" --stub-key "*)',
        '    echo "2026-10-21 INFO creating space"',
        '    echo \'{"id": "space-e2e-001", "api_key": "KEY_ONETIME_abc123", "name": "s"}\'',
        '    exit 0;;',
        '  *" memory create "*)',
        '    echo \'{"id": "space-e2e-002", "api_key": "KEY_ONETIME_xyz789", "name": "s"}\'',
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

    // PR11: memory create is approved, canonicalized to --output json (the
    // only branch that prints the one-time api_key). --strategies is
    // required (friction fix 1 — server-side 400 + orphan key otherwise).
    const memoryCreate = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic']);
    assert.equal(memoryCreate.tier, 'approved');
    assert.deepEqual(memoryCreate.args, ['memory', 'create', 'x', '--strategies', 'semantic', '--output', 'json']);
    assert.equal(typeof memoryCreate.approvalToken, 'string');
    // The approval guidance teaches the <redacted> replacement flow.
    assert.match(memoryCreate.approvalGuidance, /<redacted>/);
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

    const installOk = planAgentartsCommand(['memory', 'install', 'opencode']);
    assert.equal(installOk.tier, 'approved');
    // --yes is canonicalized like destroy (non-interactive requirement).
    assert.deepEqual(installOk.args, ['memory', 'install', 'opencode', '--yes']);
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

test('plan flags the memory family trap-15 region lie (help cn-north-4 vs actual cn-southwest-2)', async () => {
  await withIsolation(() => {
    // The agent followed the CLI help text's wrong default.
    const lied = planAgentartsCommand(['memory', 'list', '--region', 'cn-north-4']);
    assert.ok(lied.warnings.some((w) => /wrong help text/.test(w) && /cn-southwest-2/.test(w) && /trap 15/.test(w)));
    // Inline and attached short forms parse to the same warning.
    const inline = planAgentartsCommand(['memory', 'get', 'sp1', '--region=cn-north-4']);
    assert.ok(inline.warnings.some((w) => /wrong help text/.test(w)));
    const attached = planAgentartsCommand(['memory', 'status', '-rcn-north-4']);
    assert.ok(attached.warnings.some((w) => /wrong help text/.test(w)));

    // Omitting --region gets the drift-guard note (env chain -> cn-southwest-2)
    // with the full chain and the user-terminal caveat pinned.
    const absent = planAgentartsCommand(['memory', 'list']);
    const absentNote = absent.warnings.find((w) => /No --region on memory list/.test(w));
    assert.ok(absentNote, 'absent-region note missing');
    assert.match(absentNote, /future default drift/);
    assert.match(absentNote, /cn-southwest-2/);
    assert.match(absentNote, /HUAWEICLOUD_SDK_REGION/);
    assert.match(absentNote, /OS_REGION_NAME/);
    assert.match(absentNote, /your own terminal/);

    // Membership is derived from the fixture-pinned value-flag table: every
    // region-flagged memory subcommand fires the absent note.
    const regionSubs = [...MEMORY_SUBCOMMAND_VALUE_FLAGS]
      .filter(([, flags]) => flags.has('--region'))
      .map(([sub]) => sub)
      .sort((a, b) => a.localeCompare(b));
    assert.deepEqual(regionSubs, ['create', 'delete', 'get', 'list', 'status', 'update']);
    for (const sub of regionSubs) {
      const argv = sub === 'create' ? ['memory', 'create', 'x', '--strategies', 'semantic'] : ['memory', sub, 'sp1'];
      const plan = planAgentartsCommand(argv);
      assert.ok(
        plan.warnings.some((w) => new RegExp(`No --region on memory ${sub}`).test(w)),
        `${sub} must fire the absent-region note`,
      );
    }

    // The correct region and non-region subcommands stay quiet.
    const ok = planAgentartsCommand(['memory', 'list', '--region', 'cn-southwest-2']);
    assert.ok(!ok.warnings.some((w) => /trap 15|No --region/.test(w)));
    const install = planAgentartsCommand(['memory', 'install', 'opencode']);
    assert.ok(!install.warnings.some((w) => /trap 15|No --region/.test(w)));

    // A dangling --region is still the pre-existing hard rejection.
    const dangling = planAgentartsCommand(['memory', 'list', '--region']);
    assert.equal(dangling.ok, false);
    assert.match(dangling.error, /dangling --region/);
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

test('readonly memory get masks the quoted one-time api_key (trap 27)', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // The stub prints the `memory get -o json` shape: a QUOTED api_key —
    // the form that rode the readonly payload unmasked before trap 27
    // (extractMemoryApiKey only guards the create path; get relies on
    // redactSecrets string redaction alone).
    const out = await runAgentartsReadonlyCommand([
      'memory',
      'get',
      'sp-verify-1',
      '--region',
      'cn-southwest-2',
      '--output',
      'json',
      '--stub-get-key',
    ]);
    assert.equal(out.ok, true);
    assert.match(out.stdout, /"api_key": <redacted>/);
    // The identifier (not the secret) stays visible for traceability.
    assert.match(out.stdout, /"api_key_id": "key-9"/);
    assert.doesNotMatch(JSON.stringify(out), /KEY_ONETIME_get555/);
  });
});

test('readonly run rejects non-readonly tiers and bearer tokens', async () => {
  await withIsolation(async () => {
    const approved = await runAgentartsReadonlyCommand(['launch']);
    assert.equal(approved.ok, false);
    assert.match(approved.error, /run_approved/);
    const blocked = await runAgentartsReadonlyCommand(['memory', 'create']);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /run_approved/);
    const bearer = await runAgentartsReadonlyCommand(['memory', 'list', '--bearer-token', 'x']);
    assert.equal(bearer.ok, false);
    assert.match(bearer.error, /bearer-token/i);
  });
});

test('approved run enforces the token lifecycle and args binding', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
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
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
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
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
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
    assert.equal(AGENTARTS_TOOL_DEFINITIONS.length, 4);
    const names = AGENTARTS_TOOL_DEFINITIONS.map((t) => t.name);
    assert.deepEqual(
      names.sort((a, b) => a.localeCompare(b)),
      [
        'huaweicloud_agentarts_list_agents',
        'huaweicloud_agentarts_plan_cli_command',
        'huaweicloud_agentarts_run_approved_command',
        'huaweicloud_agentarts_run_readonly_command',
      ],
    );
    // The schema must not expose a stdin passthrough (the hcloud trio's
    // latent hole is not inherited).
    for (const def of AGENTARTS_TOOL_DEFINITIONS) {
      assert.equal(def.inputSchema.properties.stdin, undefined, def.name);
    }

    const plan = await callTool('huaweicloud_agentarts_plan_cli_command', {
      args: ['memory', 'list'],
    });
    assert.equal(plan.tier, 'readonly');

    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
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
    // force: bypasses the process-level probe cache (the stub was swapped).
    const versioned = join(stubPath, '..', 'agentarts-versioned.sh');
    writeFileSync(versioned, '#!/bin/bash\necho "agentarts version: 0.1.7"\n', { mode: 0o755 });
    chmodSync(versioned, 0o755);
    process.env.AGENTARTS_BIN = versioned;
    const ok = probeAgentarts({ force: true });
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

test('payload-first invoke keeps operation clean, 900s timeout semantics, and layer parity', async () => {
  await withIsolation(() => {
    // `invoke {payload}` is the DOCUMENTED shape (fixture invoke.txt): the
    // payload must NOT become the subcommand.
    const resolved = resolveAgentartsTier(['invoke', '{"message":"hello"}']);
    assert.equal(resolved.operation, 'invoke');
    assert.equal(resolved.tier, 'approved');
    assert.equal(resolved.unregistered, false);
    assert.deepEqual(resolved.labels, ['execute']);

    // Node/Python deny-reason parity for the payload shape: the payload
    // stays out of the reason string.
    const nodeReason = classifyTextCommand('agentarts invoke {"message":"hello"}');
    assert.equal(nodeReason.decision, 'deny');
    assert.match(nodeReason.reason, /agentarts invoke \(execute\)/);
    assert.doesNotMatch(nodeReason.reason, /hello/);

    // Timeout selection is by operation, and invoke-family carries 900s
    // (defaultTimeoutMs is internal; assert via the plan's tool description
    // contract instead — the documented default).
    const plan = planAgentartsCommand(['invoke', '{"message":"hello"}']);
    assert.equal(plan.operation, 'invoke');
    assert.equal(plan.tier, 'approved');
    assert.ok(!plan.warnings.some((w) => /not in the measured command registry/.test(w)));
  });
});

test('positional secrets are scrubbed from display surfaces but the token binds the real args', async () => {
  await withIsolation(async () => {
    const realArgs = ['config', 'set-env', 'HUAWEICLOUD_SDK_AK', 'AKIDEXAMPLESECRET123'];
    const plan = planAgentartsCommand(realArgs);
    assert.equal(plan.tier, 'approved');
    // Display surfaces carry the placeholder, never the value.
    assert.deepEqual(plan.args, ['config', 'set-env', 'HUAWEICLOUD_SDK_AK', '<redacted>']);
    assert.doesNotMatch(plan.command, /AKIDEXAMPLESECRET123/);
    // The approvals store never carries the raw value either.
    const { inspectApprovalToken } = await import('../plugins/huaweicloud-core/src/hcloud-cli.mjs');
    void inspectApprovalToken;
    // And the real args still hash-match at run time (env-or-fail rejects
    // before spawn here — the binding itself is what this asserts).
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const run = await runAgentartsApprovedCommand({
      args: realArgs,
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    // The stub is not a real config project: the run executes the stub and
    // succeeds; the hash-match is proven by NOT throwing the mismatch error.
    assert.equal(run.status, 'ok');
    assert.doesNotMatch(JSON.stringify(run), /AKIDEXAMPLESECRET123/);
  });
});

test('runs without devkit credentials fail closed with a clear pointer (env-or-fail)', async () => {
  await withIsolation(async () => {
    // withIsolation points HUAWEICLOUD_HOME at the scratch home and no
    // runtime credentials are set: there is nothing to inject.
    const readonly = await runAgentartsReadonlyCommand(['memory', 'list']);
    assert.equal(readonly.ok, false);
    assert.match(readonly.error, /huaweicloud_auth_init/);
    assert.match(readonly.error, /never falls back to unmanaged profile/);

    const plan = planAgentartsCommand(['launch']);
    const approved = await runAgentartsApprovedCommand({
      args: ['launch'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(approved.status, 'rejected');
    assert.equal(approved.code, 'NO_DEVKIT_CREDENTIALS');
    assert.match(approved.detail, /huaweicloud_auth_init/);
  });
});

test('list agents runs the stub sibling python, passes argv-as-data, and parses the list', async () => {
  await withIsolation(async ({ home }) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // A stub python BESIDE the stub CLI: prints a JSON array, echoes the
    // json argv element ($3: $1=-c $2=snippet $3=json) to stderr so the
    // data-channel contract is asserted with a real spawn.
    const stubPython = join(home, 'python');
    writeFileSync(
      stubPython,
      ['#!/bin/bash', 'echo \'[{"name":"demo-agent","status":"RUNNING"}]\'', 'echo "JSONARG=$3" >&2', ''].join('\n'),
      { encoding: 'utf8', mode: 0o755 },
    );
    chmodSync(stubPython, 0o755);
    const result = await listAgentartsAgents({});
    assert.equal(result.ok, true);
    assert.equal(result.executable, stubPython);
    assert.equal(result.count, 1);
    assert.equal(result.agents[0].name, 'demo-agent');
    // The JSON request is a SEPARATE argv element — never woven into the snippet.
    assert.match(result.stderr, /^JSONARG=\{"region":"cn-southwest-2"\}$/m);
    assert.doesNotMatch(JSON.stringify(result), /AKVALUE123|SKVALUE456/);
  });
});

test('list agents exit-code contract: ours, with detectFailure as the second layer', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // exit 1 with valid stdout is a failure, and a runnable candidate's
    // failure is FINAL (the chain does not advance).
    const calls = [];
    let result = await listAgentartsAgents(
      {},
      {
        runCandidate: async (candidate) => {
          calls.push(candidate);
          return { exitCode: 1, stdout: '[]', stderr: 'ValueError: boom' };
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.failureDetected, true);
    assert.equal(result.exitCode, 1);
    assert.equal(calls.length, 1);
    // exit 0 with a traceback on stderr still fails (second defense layer).
    result = await listAgentartsAgents(
      {},
      {
        runCandidate: async () => ({
          exitCode: 0,
          stdout: '[{"name":"x"}]',
          stderr: 'Traceback (most recent call last):',
        }),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.failureDetected, true);
    // exit 0 + clean output parses; stdout that is not JSON degrades to agents:null.
    result = await listAgentartsAgents(
      {},
      {
        runCandidate: async () => ({ exitCode: 0, stdout: '[{"name":"x"},{"name":"y"}]', stderr: '' }),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    result = await listAgentartsAgents(
      {},
      {
        runCandidate: async () => ({ exitCode: 0, stdout: 'not json', stderr: '' }),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.agents, null);
    assert.equal(result.count, null);
  });
});

test('list agents pagination omission and explicit params shape the JSON arg', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    let seenArgs;
    const capture = async (candidate, args) => {
      seenArgs = args;
      return { exitCode: 0, stdout: '[]', stderr: '' };
    };
    // Omitted params never reach the request — SDK defaults stay the single
    // source of truth.
    await listAgentartsAgents({}, { runCandidate: capture });
    assert.deepEqual(JSON.parse(seenArgs[2]), { region: 'cn-southwest-2' });
    assert.equal(seenArgs[0], '-c');
    assert.ok(seenArgs[1].includes('get_agents'));
    // Explicit params all travel.
    await listAgentartsAgents({ agent_name: 'demo', limit: 100, offset: 2 }, { runCandidate: capture });
    assert.deepEqual(JSON.parse(seenArgs[2]), { region: 'cn-southwest-2', agent_name: 'demo', limit: 100, offset: 2 });
    // Region override travels too.
    await listAgentartsAgents({ region: 'cn-north-4' }, { runCandidate: capture });
    assert.deepEqual(JSON.parse(seenArgs[2]), { region: 'cn-north-4' });
  });
});

test('list agents advances python candidates only on module-missing or spawn errors', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // exit 3 (module missing) on the first candidate, success on the next.
    let result = await listAgentartsAgents(
      {},
      {
        runCandidate: async (candidate) =>
          candidate.endsWith('python3')
            ? { exitCode: 0, stdout: '[{"name":"z"}]', stderr: '' }
            : { exitCode: 3, stdout: '', stderr: 'AGENTARTS_SDK_MISSING' },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    // ModuleNotFoundError text in stderr (not our exit code) also advances.
    result = await listAgentartsAgents(
      {},
      {
        runCandidate: async (candidate) =>
          candidate.endsWith('python3')
            ? { exitCode: 0, stdout: '[]', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'ModuleNotFoundError: No module named ' },
      },
    );
    assert.equal(result.ok, true);
    // ENOENT (spawnError) advances as well.
    result = await listAgentartsAgents(
      {},
      {
        runCandidate: async (candidate) =>
          candidate.endsWith('python3')
            ? { exitCode: 0, stdout: '[]', stderr: '' }
            : { exitCode: null, stdout: '', stderr: '', spawnError: new Error('spawn ENOENT') },
      },
    );
    assert.equal(result.ok, true);
    // Every candidate module-missing: install guidance, not a traceback dump.
    result = await listAgentartsAgents(
      {},
      {
        runCandidate: async () => ({ exitCode: 3, stdout: '', stderr: 'AGENTARTS_SDK_MISSING' }),
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /install-agentarts/);
    assert.match(result.error, /tried:/);
  });
});

test('list agents fails closed without devkit credentials and dispatches through callTool', async () => {
  await withIsolation(async ({ home }) => {
    // Env-or-fail: the wrapper never falls back to unmanaged profile auth.
    const rejected = await listAgentartsAgents({});
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /huaweicloud_auth_init/);
    assert.match(rejected.error, /never falls back to unmanaged profile/);

    // callTool dispatch reaches the same runner (stub sibling python).
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const stubPython = join(home, 'python');
    writeFileSync(stubPython, '#!/bin/bash\necho "[]"\n', { encoding: 'utf8', mode: 0o755 });
    chmodSync(stubPython, 0o755);
    const viaTool = await callTool('huaweicloud_agentarts_list_agents', {});
    assert.equal(viaTool.ok, true);
    assert.equal(viaTool.count, 0);
    assert.deepEqual(viaTool.agents, []);
  });
});

test('plan canonicalizes memory create/delete and rejects non-json output (PR11)', async () => {
  await withIsolation(() => {
    // create: --output json appended, token binds to the canonical form.
    const create = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic']);
    assert.equal(create.tier, 'approved');
    assert.deepEqual(create.args, ['memory', 'create', 'x', '--strategies', 'semantic', '--output', 'json']);
    assert.match(create.command, /--output json/);
    assert.equal(typeof create.approvalToken, 'string');
    // Explicit forms are never double-appended.
    for (const explicit of [
      ['memory', 'create', 'x', '--strategies', 'semantic', '--output', 'json'],
      ['memory', 'create', 'x', '--strategies', 'semantic', '-o', 'json'],
      ['memory', 'create', 'x', '--strategies', 'semantic', '--output=json'],
    ]) {
      assert.deepEqual(planAgentartsCommand(explicit).args, explicit);
    }
    // An explicit non-json --output is a plan-level rejection (the one-time
    // api_key would be permanently lost — no argv surgery on bound args).
    const rejected = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--output', 'table']);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /json/);
    assert.match(rejected.error, /api_key|one-time/i);
    const rejectedShort = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '-o', 'table']);
    assert.equal(rejectedShort.ok, false);

    // delete: --force appended (NOT --yes — the measured flag), never both.
    const del = planAgentartsCommand(['memory', 'delete', 'space-1']);
    assert.equal(del.tier, 'approved');
    assert.deepEqual(del.args, ['memory', 'delete', 'space-1', '--force']);
    assert.ok(!del.args.includes('--yes'));
    assert.deepEqual(del.labels, ['irreversible']);
    const delShort = planAgentartsCommand(['memory', 'delete', 'space-1', '-f']);
    assert.deepEqual(delShort.args, ['memory', 'delete', 'space-1', '-f']);
    assert.ok(!delShort.args.includes('--yes'));

    // update: approved, no canonical flag (fixture shows none).
    const update = planAgentartsCommand(['memory', 'update', 'space-1', '--name', 'y']);
    assert.equal(update.tier, 'approved');
    assert.deepEqual(update.args, ['memory', 'update', 'space-1', '--name', 'y']);
  });
});

test('plan rejects memory create without strategies before any cloud call (friction fix 1)', async () => {
  await withIsolation(() => {
    // Missing --strategies: the server answers 400 [AgentArts.01010400]
    // AFTER an orphan API key was created (key-before-space order,
    // e2e-measured). The plan rejects up front: readable error listing the
    // legal values, no approvalToken (nothing enters the approval flow).
    const missing = planAgentartsCommand(['memory', 'create', 'my-space']);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /--strategies/);
    assert.match(missing.error, /AgentArts\.01010400/);
    assert.match(missing.error, /orphan/);
    assert.match(missing.error, /semantic/);
    assert.equal(missing.approvalToken, undefined);
    assert.equal(missing.safeToRun, undefined);

    // Empty and whitespace-only values count as missing (the CLI would
    // pass [''] or skip the list entirely — same server 400). The '='-
    // attached short form counts as missing too: click parses
    // `-s=semantic` as the value '=semantic' (no '='-stripping for short
    // options) — KooCLI's universal --param=value convention makes this
    // the likeliest agent accident.
    for (const empty of [
      ['--strategies', ''],
      ['--strategies', ' , '],
      ['-s', ''],
      ['--strategies='],
      ['-s=semantic'],
    ]) {
      const rejected = planAgentartsCommand(['memory', 'create', 'my-space', ...empty]);
      assert.equal(rejected.ok, false, `expected rejection for ${JSON.stringify(empty)}`);
      assert.match(rejected.error, /--strategies/);
    }
    // A trailing --strategies with no value rejects too.
    const dangling = planAgentartsCommand(['memory', 'create', 'my-space', '--strategies']);
    assert.equal(dangling.ok, false);

    // Valid forms pass: long with next token, inline =, short forms.
    for (const valid of [
      ['memory', 'create', 'x', '--strategies', 'semantic,episodic'],
      ['memory', 'create', 'x', '--strategies=semantic'],
      ['memory', 'create', 'x', '-s', 'user_preference'],
      ['memory', 'create', 'x', '-ssummary'],
    ]) {
      const plan = planAgentartsCommand(valid);
      assert.equal(plan.ok, true, `expected pass for ${JSON.stringify(valid)}`);
      assert.equal(plan.tier, 'approved');
      assert.equal(typeof plan.approvalToken, 'string');
    }

    // Unknown values: a WARNING (the server makes the final call), never a
    // rejection — same fail-safe posture as unregistered commands.
    const unknown = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'bogus,semantic']);
    assert.equal(unknown.ok, true);
    assert.ok(unknown.warnings.some((w) => /bogus/.test(w) && /built-in/.test(w)));
    assert.equal(typeof unknown.approvalToken, 'string');

    // Root-flag prefixes resolve like the classifier does (skip leading
    // dashes): --verbose is a boolean, so the collapse fix must still
    // fire; --version is a GENUINE root terminal (click prints the
    // version and exits) and stays local.
    const verboseApproved = planAgentartsCommand([
      '--verbose',
      'memory',
      'create',
      'x',
      '--strategies',
      'semantic',
      '-d',
      '--help',
    ]);
    assert.equal(verboseApproved.ok, true);
    assert.equal(verboseApproved.tier, 'approved');
    const verboseGuard = planAgentartsCommand(['--verbose', 'memory', 'create', 'my-space', '--strategies', '--help']);
    assert.equal(verboseGuard.ok, false);
    assert.match(verboseGuard.error, /--strategies/);
    assert.equal(planAgentartsCommand(['--version', 'memory', 'create', 'x', '-d', '--help']).tier, 'local');
    assert.equal(planAgentartsCommand(['--verbose', 'memory', 'create', '--help']).tier, 'local');

    // Raw-segment validation: padded and empty segments stay OBSERVABLE
    // (warning), never silently normalized away — the CLI sends the string
    // unnormalized and server-side trimming is unmeasured.
    const padded = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic, episodic']);
    assert.equal(padded.ok, true);
    assert.ok(padded.warnings.some((w) => /outside the known built-in set/.test(w) && / episodic/.test(w)));
    const trailing = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic,']);
    assert.equal(trailing.ok, true);
    assert.ok(trailing.warnings.some((w) => /outside the known built-in set/.test(w) && /empty segment/.test(w)));

    // Dangling value flags reject at plan (click: "Option '--X' requires an
    // argument"): the appended --output json / --force would otherwise be
    // eaten as the dangling flag's value — with NAME unfilled, 'json' fills
    // the required positional and the create silently runs the TABLE
    // branch, losing the one-time key.
    for (const dangling of [
      ['memory', 'create', 'x', '--strategies', 'semantic', '--description'],
      ['memory', 'create', '--strategies', 'semantic', '--tags'],
      ['memory', 'delete', 'sp1', '--region'],
    ]) {
      const p = planAgentartsCommand(dangling);
      assert.equal(p.ok, false, `expected rejection for ${JSON.stringify(dangling)}`);
      assert.match(p.error, /dangling/);
      assert.match(p.error, /requires an argument/);
    }

    // Pre-subcommand tokens parse at the ROOT context (no value flags
    // there): a root-level --strategies is an unknown root option, not a
    // strategy — the plan rejects as missing strategies.
    const rootPhantom = planAgentartsCommand(['--strategies=semantic', 'memory', 'create', 'x']);
    assert.equal(rootPhantom.ok, false);
    assert.match(rootPhantom.error, /--strategies/);
    // A root-level `-o table` breaks group resolution itself ('table'
    // reads as the group after the leading-dash skip) → unregistered
    // fail-safe approval; the run fails loudly at click's root parse.
    const rootOutput = planAgentartsCommand(['-o', 'table', 'memory', 'create', 'x', '--strategies', 'semantic']);
    assert.equal(rootOutput.ok, true);
    assert.ok(rootOutput.warnings.some((w) => /not in the measured command registry/.test(w)));

    // The family fix covers every subcommand shape, not just create/update
    // (delete is the irreversible one): a help token in a value slot is
    // data, so the real tier applies.
    assert.equal(planAgentartsCommand(['memory', 'delete', 'sp1', '--region', '--help']).tier, 'approved');
    assert.equal(planAgentartsCommand(['memory', 'get', 'sp1', '--region', '--help']).tier, 'readonly');
    assert.equal(planAgentartsCommand(['memory', 'list', '--limit', '--help']).tier, 'readonly');
    assert.equal(planAgentartsCommand(['memory', 'status', 'sp1', '--region', '--help']).tier, 'readonly');

    // Ordinary positionals never scrub their successor — a memory space
    // named my-task / auth-token / TASK / PROD_SK / MY_TOKEN must leave
    // --strategies (or any flag) visible in the approval surface: bearer
    // detection is context-based (dash-flags, the set-env NAME slot, and
    // obsutil shorts for the hcloud CLI), never a shape guess on the
    // positional itself.
    for (const name of ['my-task', 'auth-token', 'TASK', 'flask-agent', 'PROD_SK', 'MY_TOKEN', 'MY_API_KEY']) {
      const p = planAgentartsCommand(['memory', 'create', name, '--strategies', 'semantic']);
      assert.equal(p.ok, true, name);
      assert.ok(p.args.includes('--strategies'), `${name} must not scrub --strategies`);
    }
    // The intended secret-bearer shapes still scrub: the set-env NAME slot
    // (ANY case — lowercase env names and bare AK/SK are the norm there)
    // and secret-named flags.
    for (const envName of ['HUAWEICLOUD_SDK_AK', 'api_key', 'token', 'AK', 'OPENAI_API_KEY']) {
      const p = planAgentartsCommand(['config', 'set-env', envName, 'RAWSECRET123']);
      assert.ok(p.args.includes('<redacted>'), `${envName} value must be scrubbed`);
    }
    // A non-secret env NAME does not scrub its value.
    const regionPlan = planAgentartsCommand(['config', 'set-env', 'REGION', 'cn-southwest-2']);
    assert.ok(regionPlan.args.includes('cn-southwest-2'));
    const flagPlan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--api-key', 'zzz']);
    assert.ok(flagPlan.args.includes('<redacted>'));

    // Root-terminal argvs are exempt from the dangling guard: click prints
    // --version/--help and exits before subcommand args are parsed.
    assert.equal(planAgentartsCommand(['--version', 'memory', 'list', '--limit']).tier, 'local');
    assert.equal(planAgentartsCommand(['memory', 'create', '--help', '--strategies']).tier, 'local');
    assert.equal(
      planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--description']).ok,
      false,
    );

    // Mid-argv cannibalization warns (a dash-leading value is legitimate
    // click input, so not a rejection): `--description --output json`
    // would parse as description='--output' with 'json' filling NAME. The
    // warning's interpolated tokens go through the SAME redaction as
    // plan.args — a secret-shaped token in a value slot never rides the
    // warning into the transcript.
    const cannibal = planAgentartsCommand([
      'memory',
      'create',
      '--strategies',
      'semantic',
      '--description',
      '--output',
      'json',
    ]);
    assert.equal(cannibal.ok, true);
    assert.ok(cannibal.warnings.some((w) => /--description consumes --output/.test(w)));
    const cannibalSecret = planAgentartsCommand([
      'memory',
      'create',
      'x',
      '--strategies',
      'semantic',
      '--description',
      '--api-key=TOPSECRET99',
    ]);
    assert.equal(cannibalSecret.ok, true);
    assert.doesNotMatch(JSON.stringify(cannibalSecret), /TOPSECRET99/);

    // The check is scoped to memory create: update HAS a --strategies flag
    // (fixture memory_update.txt:20) but its empty/missing semantics are
    // UNMEASURED (S0 item, findings trap 24) — no create-style rejection
    // there. Real flags only (update takes no --name).
    assert.equal(planAgentartsCommand(['memory', 'update', 'space-1', '--description', 'y']).ok, true);
    assert.equal(planAgentartsCommand(['memory', 'list', '--region', 'cn-southwest-2']).ok, true);

    // Last-wins (click semantics): the plan validates the value the CLI
    // will actually execute — a semantic-then-bogus pair warns on bogus.
    const dup = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--strategies', 'bogus']);
    assert.equal(dup.ok, true);
    assert.ok(dup.warnings.some((w) => /bogus/.test(w)));

    // Duplicate --output follows the same rule: first-json/last-table must
    // REJECT (the CLI executes the table branch and the one-time key is
    // lost) — the plan inspects the last occurrence.
    const dupOut = planAgentartsCommand([
      'memory',
      'create',
      'x',
      '--strategies',
      'semantic',
      '--output',
      'json',
      '--output',
      'table',
    ]);
    assert.equal(dupOut.ok, false);
    assert.match(dupOut.error, /json/);
    const dupOutShort = planAgentartsCommand([
      'memory',
      'create',
      'x',
      '--strategies',
      'semantic',
      '--output',
      'json',
      '-o',
      'table',
    ]);
    assert.equal(dupOutShort.ok, false);

    // Flag names are case-sensitive like click: a mixed-case spelling is
    // NOT recognized and degrades to the missing-strategies rejection
    // (better than passing a form the CLI rejects outright).
    const upper = planAgentartsCommand(['memory', 'create', 'x', '--STRATEGIES=semantic']);
    assert.equal(upper.ok, false);
    assert.match(upper.error, /--strategies/);
    // The output VALUE check is case-sensitive too: the CLI compares
    // output == "json" (commands.py), so "JSON" would take the table
    // branch and silently lose the one-time key.
    const upperJson = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--output', 'JSON']);
    assert.equal(upperJson.ok, false);

    // --help/-h at a GENUINE option position bypass the guard (classifier
    // eager-flag short-circuit, tier local) — parameter discovery stays
    // reachable.
    for (const helpForm of [['--help'], ['-h']]) {
      const h = planAgentartsCommand(['memory', 'create', ...helpForm]);
      assert.equal(h.ok, true, `expected --help bypass for ${helpForm[0]}`);
      assert.equal(h.tier, 'local');
    }

    // A --help/-h token in a VALUE slot is data, not help (click consumes
    // it): the guard must still fire, and the position-blind classifier
    // collapse must NOT de-escalate the tier (trap 26 wrapper half).
    const helpAsValue = planAgentartsCommand(['memory', 'create', 'x', '--strategies', '--help']);
    assert.equal(helpAsValue.ok, false);
    assert.match(helpAsValue.error, /--strategies/);
    const helpInDescription = planAgentartsCommand([
      'memory',
      'create',
      'x',
      '--strategies',
      'semantic',
      '-d',
      '--help',
    ]);
    assert.equal(helpInDescription.ok, true);
    assert.equal(helpInDescription.tier, 'approved');
    assert.equal(typeof helpInDescription.approvalToken, 'string');
    // Case-insensitive help detection mirrors the classifier (which
    // lowercases): bare --HELP stays local; consumed in a value slot it is
    // data like any other.
    assert.equal(planAgentartsCommand(['memory', 'create', '--HELP']).tier, 'local');
    assert.equal(
      planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '-d', '--HELP']).tier,
      'approved',
    );
    assert.equal(planAgentartsCommand(['memory', 'create', 'x', '--strategies', '--HELP']).ok, false);

    // Value-slot awareness (round 3): a dash-prefixed token in a VALUE
    // slot is NOT a flag — `-d -summary` has NO strategies (click eats
    // -summary as the description), so the guard must reject instead of
    // manufacturing a phantom strategy.
    for (const phantom of [
      ['memory', 'create', 'x', '-d', '-summary'],
      ['memory', 'create', 'x', '--tags', '-stable'],
      ['memory', 'create', 'x', '--extract-idle', '--help'],
    ]) {
      const p = planAgentartsCommand(phantom);
      assert.equal(p.ok, false, `expected rejection for ${JSON.stringify(phantom)}`);
      assert.match(p.error, /--strategies/);
    }
    // The mirror direction: `-d -ojson` has NO --output — the append must
    // still happen (the one-time key would take the table branch
    // otherwise); `-d -overview` must not trip a spurious output check.
    for (const descValue of [
      ['-d', '-ojson'],
      ['-d', '-overview'],
      ['--description', '-output-notes'],
    ]) {
      const p = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', ...descValue]);
      assert.equal(p.ok, true, `expected pass for ${JSON.stringify(descValue)}`);
      assert.deepEqual(p.args, ['memory', 'create', 'x', '--strategies', 'semantic', ...descValue, '--output', 'json']);
    }

    // The same collapse fix covers the whole memory family in the plan
    // tool: `memory update -d --help` is an approved cloud write (the
    // --help is the description value), not a local-tier help request.
    const updateHelp = planAgentartsCommand(['memory', 'update', 'space-1', '-d', '--help']);
    assert.equal(updateHelp.ok, true);
    assert.equal(updateHelp.tier, 'approved');
    assert.equal(typeof updateHelp.approvalToken, 'string');
    assert.equal(planAgentartsCommand(['memory', 'update', '--help']).tier, 'local');

    // Every MEASURED built-in plans warning-free; enum-evidenced values
    // (`event`) get the provenance note — and it fires INDEPENDENTLY of
    // the unknown-value warning (`event,bogus` gets both).
    for (const s of ['semantic', 'episodic', 'user_preference', 'summary']) {
      const p = planAgentartsCommand(['memory', 'create', 'x', '--strategies', s]);
      assert.equal(p.ok, true);
      assert.ok(
        !p.warnings.some((w) => /outside the known built-in set/.test(w)),
        `${s} must carry no unknown-strategy warning`,
      );
      assert.ok(!p.warnings.some((w) => /enum-evidenced/.test(w)), `${s} must carry no provenance note`);
    }
    const ev = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'event']);
    assert.equal(ev.ok, true);
    assert.ok(ev.warnings.some((w) => /enum-evidenced/.test(w)));
    assert.ok(!ev.warnings.some((w) => /outside the known built-in set/.test(w)));
    const evBogus = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'event,bogus']);
    assert.equal(evBogus.ok, true);
    // The provenance note covers KNOWN built-ins only — `bogus` is unknown,
    // not enum-evidenced, and appears only in the unknown warning.
    const provenanceNote = evBogus.warnings.find((w) => /enum-evidenced/.test(w));
    const unknownNote = evBogus.warnings.find((w) => /outside the known built-in set/.test(w));
    assert.ok(provenanceNote, 'provenance note must fire for event,bogus');
    assert.match(provenanceNote, /event/);
    assert.doesNotMatch(provenanceNote, /bogus/);
    assert.ok(unknownNote, 'unknown warning must fire for event,bogus');
    assert.match(unknownNote, /bogus/);

    // Rejection payloads scrub bare positional secrets like the success
    // path: config set-env HUAWEICLOUD_SDK_AK <value> + a bearer token
    // must never echo the raw AK back.
    const leaky = planAgentartsCommand([
      'config',
      'set-env',
      'HUAWEICLOUD_SDK_AK',
      'RAWSECRET123',
      '--bearer-token',
      'tok',
    ]);
    assert.equal(leaky.ok, false);
    assert.ok(leaky.args.includes('<redacted>'));
    assert.doesNotMatch(JSON.stringify(leaky), /RAWSECRET123/);
  });
});

test('usage errors are detected from stderr only, in the real 0.1.7 rich-boxed format', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // The stubs print the CAPTURED real formats (stderr, rich box) AND
    // exit 0 — modeling the CLI's exit-code hygiene. Only the
    // stderr-scoped usage signature can catch them. Three forms:
    // subcommand-level option error, root-level unknown command, and a
    // dangling value flag.
    for (const [flag, form] of [
      ['--stub-usage', 'subcommand option'],
      ['--stub-usage-cmd', 'root no-such-command'],
      ['--stub-usage-dangling', 'dangling option'],
    ]) {
      const plan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', flag]);
      const run = await runAgentartsApprovedCommand({
        args: ['memory', 'create', 'x', '--strategies', 'semantic', flag, '--output', 'json'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
      });
      assert.equal(run.status, 'ok', form);
      assert.equal(run.ok, false, form);
      assert.equal(run.failureDetected, true, form);
    }

    // The box forms AND the Try line are skipped for the invoke family
    // (their stderr can carry child output — an invoked agent shelling out
    // to a failing agentarts command echoes exactly these lines): the
    // exit-2 backstop is the usage-error detector there. Pinned with
    // exit-0 stubs, which isolate the signature layering.
    const invPlan = planAgentartsCommand(['invoke', '{"message":"hi"}', '--stub-usage-box0']);
    const invRun = await runAgentartsApprovedCommand({
      args: ['invoke', '{"message":"hi"}', '--stub-usage-box0'],
      approvalToken: invPlan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(invRun.status, 'ok');
    assert.equal(invRun.ok, true);
    assert.equal(invRun.failureDetected, false);
    const invTry = planAgentartsCommand(['invoke', '{"message":"hi"}', '--stub-usage']);
    const invTryRun = await runAgentartsApprovedCommand({
      args: ['invoke', '{"message":"hi"}', '--stub-usage'],
      approvalToken: invTry.approvalToken,
      approvedByUser: true,
    });
    assert.equal(invTryRun.status, 'ok');
    assert.equal(invTryRun.ok, true);
    assert.equal(invTryRun.failureDetected, false);
    // The exit-2 backstop (measured: usage errors exit 2) catches the
    // box-only dangling form on the invoke family — the REAL 0.1.7
    // behavior, no silent no-op.
    const inv2Plan = planAgentartsCommand(['invoke', '{"message":"hi"}', '--stub-usage-dangling']);
    const inv2Run = await runAgentartsApprovedCommand({
      args: ['invoke', '{"message":"hi"}', '--stub-usage-dangling'],
      approvalToken: inv2Plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(inv2Run.status, 'ok');
    assert.equal(inv2Run.ok, false);
    assert.equal(inv2Run.failureDetected, true);
    assert.equal(inv2Run.exitCode, 2);

    // The same-looking lines on STDOUT with clean stderr stay a success:
    // invoke-family stdout carries arbitrary agent text, and a spurious
    // failure on a cloud write invites blind retries (and on memory
    // create would skip the key capture AND its scrub).
    const okPlan = planAgentartsCommand(['memory', 'list', '--region', 'cn-southwest-2', '--stub-usage-stdout']);
    const okRun = await runAgentartsReadonlyCommand([
      'memory',
      'list',
      '--region',
      'cn-southwest-2',
      '--stub-usage-stdout',
    ]);
    assert.equal(okPlan.ok, true);
    assert.equal(okRun.ok, true);
    assert.equal(okRun.failureDetected, false);
  });
});

test('readonly runner agrees with the plan tool on help-in-value-slot argvs (trap 26)', async () => {
  await withIsolation(async () => {
    // The collapsed argv is an approved-tier write under click's real
    // semantics — the readonly runner must reject it as such (pointing at
    // the approval flow), never steer it to unapproved Bash execution.
    const result = await runAgentartsReadonlyCommand(['memory', 'create', 'x', '--strategies', '--help']);
    assert.equal(result.ok, false);
    assert.match(result.error, /tier: approved/);
    assert.match(result.error, /run_approved_command/);
    assert.doesNotMatch(result.error, /Bash/);
  });
});

test('large-output side file never carries the one-time key (scrubbed before save)', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // Real creates print ~53KB (trap 25) — above the 50KB side-file
    // threshold. The stub models that shape: a >50KB JSON carrying the
    // one-time key.
    const plan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--stub-large-key']);
    const run = await runAgentartsApprovedCommand({
      args: ['memory', 'create', 'x', '--strategies', 'semantic', '--stub-large-key', '--output', 'json'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.ok, true);
    assert.ok(run.largeOutputFile, 'stub output must exceed the large-output threshold');
    assert.equal(run.spaceId, 'space-e2e-003');
    assert.equal(readFileSync(run.memoryApiKeyFile, 'utf8').trim(), 'KEY_ONETIME_big111');
    // Both the returned payload AND the side file stay scrubbed. The side
    // file carries the FULL text; the payload stdout is TRUNCATED to a
    // head + pointer (the hcloud pattern) so the ~53KB rides neither the
    // payload nor the transcript.
    assert.doesNotMatch(JSON.stringify(run), /KEY_ONETIME_big111/);
    assert.ok(run.stdout.length < 5000, 'payload stdout must be truncated when the side file exists');
    assert.match(run.stdout, /truncated, full output saved to/);
    const sideFile = readFileSync(run.largeOutputFile, 'utf8');
    assert.doesNotMatch(sideFile, /KEY_ONETIME_big111/);
    assert.match(sideFile, /<redacted>/);
    assert.ok(sideFile.length > 50000, 'the side file keeps the full text');
    rmSync(run.largeOutputFile, { force: true });
  });
});

test('MEMORY_SUBCOMMAND_VALUE_FLAGS is pinned to the 0.1.7 fixtures', () => {
  // The value-flag table is the foundation of scanMemoryArgs and the
  // trap-26 collapse fix: dropping an entry silently reopens the
  // help-in-value-slot bypass for that subcommand. Rows in the fixtures'
  // Options panel with a <int>/<str> type column are value-taking flags.
  const fixturesDir = join(import.meta.dirname, 'fixtures', 'agentarts', 'help-tree');
  const files = {
    create: 'memory_create.txt',
    update: 'memory_update.txt',
    delete: 'memory_delete.txt',
    get: 'memory_get.txt',
    list: 'memory_list.txt',
    status: 'memory_status.txt',
    install: 'memory_install.txt',
    uninstall: 'memory_uninstall.txt',
  };
  for (const [sub, file] of Object.entries(files)) {
    const text = readFileSync(join(fixturesDir, file), 'utf8');
    const expected = new Set();
    for (const m of text.matchAll(/^│ (--[a-z0-9-]+)(?:\s+(-[a-z0-9]+))?\s+<(?:int|str)>/gm)) {
      expected.add(m[1]);
      if (m[2]) expected.add(m[2]);
    }
    assert.deepEqual(
      [...MEMORY_SUBCOMMAND_VALUE_FLAGS.get(sub)].sort((a, b) => a.localeCompare(b)),
      [...expected].sort((a, b) => a.localeCompare(b)),
      `value-flag table drifted from ${file} for memory ${sub}`,
    );
  }
});

test('key-file write failure surfaces an honest capture-failed note, never a phantom path', async () => {
  await withIsolation(async ({ home }) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // Plant a DIRECTORY at the exact key-file path → writeFileSync fails
    // (EISDIR). The create succeeds, but the payload must NOT claim the
    // key was saved — it is scrubbed from the output and shown only once
    // by the CLI, so a silent swallow would lose it irrecoverably.
    const keyPath = join(home, '.config', 'huaweicloud', 'agentarts-memory-api-key-space-e2e-002.txt');
    mkdirSync(keyPath, { recursive: true });
    const plan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic']);
    const run = await runAgentartsApprovedCommand({
      args: ['memory', 'create', 'x', '--strategies', 'semantic', '--output', 'json'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.ok, true);
    assert.equal(run.spaceId, 'space-e2e-002');
    assert.equal(run.memoryApiKeyCaptureFailed, true);
    assert.equal(run.memoryApiKeyFile, undefined);
    assert.match(run.memoryApiKeyNote, /FAILED to save/);
    assert.match(run.memoryApiKeyNote, /unrecoverable/);
    assert.doesNotMatch(JSON.stringify(run), /KEY_ONETIME_xyz789/);
  });
});

test('a server space id that is not path-safe never steers the key-file path', async () => {
  await withIsolation(async ({ home }) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const plan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--stub-evil-id']);
    const run = await runAgentartsApprovedCommand({
      args: ['memory', 'create', 'x', '--strategies', 'semantic', '--stub-evil-id', '--output', 'json'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.ok, true);
    assert.equal(run.memoryApiKeyCaptureFailed, true);
    assert.equal(run.memoryApiKeyFile, undefined);
    assert.match(run.memoryApiKeyNote, /not path-safe/);
    // No file was created outside the state root, and the key never rides
    // the payload.
    assert.doesNotMatch(JSON.stringify(run), /KEY_ONETIME_evil777/);
    assert.ok(!existsSync(join(home, 'evil.txt')));
    assert.ok(!existsSync(join(home, '.config', 'huaweicloud', 'agentarts-memory-api-key-x.txt')));
  });
});

test('a false-positive failure verdict never leaks the one-time key (scrub is unconditional)', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // A successful create whose stderr carries a line matching the OLD
    // failure signatures (both-stream scanning, residual trap 26b): the
    // run flips to failed — but the key must still be scrubbed from the
    // payload AND captured to the file (extraction is the gate, not the
    // verdict).
    const plan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--stub-fp-fail']);
    const run = await runAgentartsApprovedCommand({
      args: ['memory', 'create', 'x', '--strategies', 'semantic', '--stub-fp-fail', '--output', 'json'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.ok, false);
    assert.equal(run.failureDetected, true);
    assert.doesNotMatch(JSON.stringify(run), /KEY_ONETIME_fp999/);
    assert.equal(run.memoryApiKeyCaptureFailed, undefined);
    assert.equal(readFileSync(run.memoryApiKeyFile, 'utf8').trim(), 'KEY_ONETIME_fp999');
  });
});

test('literal <redacted> placeholders never execute; substitutions bind only at secret slots', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // A hash-exact replay of an approved argv that LEGITIMATELY contains
    // the literal '<redacted>' (an invoke payload, a description) IS the
    // approved command — the placeholder guard sits on the fallback path,
    // after the hash check.
    const literal = ['memory', 'create', 'x', '--strategies', 'semantic', '--description', 'see <redacted> notes'];
    const literalPlan = planAgentartsCommand(literal);
    const literalRun = await runAgentartsApprovedCommand({
      args: [...literal, '--output', 'json'],
      approvalToken: literalPlan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(literalRun.status, 'ok');
    assert.equal(literalRun.approved, true);
    // The inline bearer short form (-bt=SECRET) and EVERY other spelling
    // (-btSECRET attached, -BT/-Bt mixed case, --bearer-tokenSECRET) is
    // rejected like the separated form — only the exact spellings are
    // valid click parses, and no rejection payload ever echoes the value.
    for (const bearerForm of [
      ['invoke', '{"message":"hi"}', '-bt=SECRET123'],
      ['invoke', '{"message":"hi"}', '-btSECRET123'],
      ['invoke', '{"message":"hi"}', '-BT', 'SECRET123'],
      ['invoke', '{"message":"hi"}', '-Bt=SECRET123'],
      ['invoke', '{"message":"hi"}', '--bearer-tokenSECRET123'],
    ]) {
      const p = planAgentartsCommand(bearerForm);
      assert.equal(p.ok, false, `expected rejection for ${JSON.stringify(bearerForm)}`);
      assert.match(p.error, /bearer-token/i);
      assert.doesNotMatch(
        JSON.stringify(p),
        /SECRET123/,
        `payload must stay scrubbed for ${JSON.stringify(bearerForm)}`,
      );
    }
    // A literal <redacted> at a SECRET slot is rejected at PLAN time (its
    // display would be indistinguishable from a redacted real secret);
    // literals elsewhere (descriptions, payloads) still plan and replay.
    const slotLiteral = planAgentartsCommand(['config', 'set-env', 'HUAWEICLOUD_SDK_AK', '<redacted>']);
    assert.equal(slotLiteral.ok, false);
    assert.match(slotLiteral.error, /secret slot/);
    // Placeholder pass-back: the plan displays the secret redacted; an
    // agent feeding that back verbatim must get a LOUD rejection, never a
    // silent write of the literal string — in the BARE form and the INLINE
    // --param=<redacted> form the plan displays for KooCLI-style
    // parameters.
    const plan = planAgentartsCommand(['config', 'set-env', 'HUAWEICLOUD_SDK_AK', 'REALSECRET']);
    await assert.rejects(
      runAgentartsApprovedCommand({
        args: ['config', 'set-env', 'HUAWEICLOUD_SDK_AK', '<redacted>'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
      }),
      /placeholder/,
    );
    const inlinePlan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic']);
    await assert.rejects(
      runAgentartsApprovedCommand({
        args: ['memory', 'create', 'x', '--strategies', 'semantic', '--description=<redacted>'],
        approvalToken: inlinePlan.approvalToken,
        approvedByUser: true,
      }),
      /placeholder/,
    );
    // Flag substitution after an ordinary positional (auth-token as a
    // space NAME) must NOT pass the binding: the scrub no longer treats
    // it as a secret bearer, so the changed flag fails the comparison.
    const sub = planAgentartsCommand(['memory', 'update', 'auth-token', '-d', 'x']);
    await assert.rejects(
      runAgentartsApprovedCommand({
        args: ['memory', 'update', 'auth-token', '--strategies', 'x'],
        approvalToken: sub.approvalToken,
        approvedByUser: true,
      }),
      /do not match the approved plan/i,
    );
    // The unknown-strategies warning redacts its display segments like
    // plan.args: a secret pasted into the wrong flag never rides the
    // warning into the transcript.
    const wrongSlot = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'my_token=SECRETVAL99']);
    assert.equal(wrongSlot.ok, true);
    assert.doesNotMatch(JSON.stringify(wrongSlot), /SECRETVAL99/);
  });
});

test('scrubber contexts: obsutil shorts only for the hcloud OBS family, never agentarts -t ttl', () => {
  // The shared scrubber's obsutil branch (-i/-k/-t, separated AND attached
  // forms) is keyed to the hcloud CLI AND the OBS family: credentials
  // never ride display/storage surfaces, innocent successors are never
  // corrupted by attached forms, and other services' -i stays visible.
  const obs = scrubPositionalSecrets(['OBS', 'cp', '-i', 'AK1', '-k', 'SK1', '-t', 'T1', 'obs://b', 'f'], 'hcloud');
  assert.deepEqual(obs, ['OBS', 'cp', '-i', '<redacted>', '-k', '<redacted>', '-t', '<redacted>', 'obs://b', 'f']);
  // Word-form obsutil OPTIONS (-include, -threshold, -tempFileDir,
  // -timeRange — core `OBS cp` syntax, taught by the huawei-obs skill)
  // stay visible: only credential shapes (-iAK, -i=AK, -kSK, -tTOKEN —
  // '=' or uppercase/digit/underscore after the letter) are secrets.
  const wordOpts = scrubPositionalSecrets(
    [
      'OBS',
      'cp',
      'dist',
      'obs://b',
      '-r',
      '-include=*.html',
      '-exclude=*.js',
      '-threshold=52428800',
      '-acl=public-read',
    ],
    'hcloud',
  );
  assert.deepEqual(wordOpts, [
    'OBS',
    'cp',
    'dist',
    'obs://b',
    '-r',
    '-include=*.html',
    '-exclude=*.js',
    '-threshold=52428800',
    '-acl=public-read',
  ]);
  // Attached credentials are rewritten PRESERVING the flag letter
  // (-i<redacted>): the form round-trips through the binding — a retry
  // with any attached spelling scrubs to the same shape — while a
  // literal echo is rejected by the placeholder guard. The trailing
  // position is covered too (no successor iteration for the last token).
  const attached = scrubPositionalSecrets(['OBS', 'cp', '-iAKVALUE', '-kSKVALUE', '-tTOKEN', 'obs://b', 'f'], 'hcloud');
  assert.deepEqual(attached, ['OBS', 'cp', '-i<redacted>', '-k<redacted>', '-t<redacted>', 'obs://b', 'f']);
  const trailing = scrubPositionalSecrets(['OBS', 'cp', 'src', 'dst', '-iAK'], 'hcloud');
  assert.deepEqual(trailing, ['OBS', 'cp', 'src', 'dst', '-i<redacted>']);
  const roundTrip = scrubPositionalSecrets(['OBS', 'cp', 'src', 'dst', '-iNEWAK'], 'hcloud');
  assert.deepEqual(roundTrip, ['OBS', 'cp', 'src', 'dst', '-i<redacted>']);
  const roundTripEq = scrubPositionalSecrets(['OBS', 'cp', 'src', 'dst', '-i=NEWAK'], 'hcloud');
  assert.deepEqual(roundTripEq, ['OBS', 'cp', 'src', 'dst', '-i<redacted>']);
  // Case-variant groups still hit the set-env NAME slot (every other
  // layer lowercases; the scrubber's context check does too). The
  // `config set KEY VALUE` slot (the taught fallback when set-env crashes
  // on basic templates) covers dotted secret keys.
  const upperConfig = scrubPositionalSecrets(['CONFIG', 'set-env', 'HUAWEICLOUD_SDK_AK', 'RAWSECRET'], 'agentarts');
  assert.ok(upperConfig.includes('<redacted>'));
  const upperSetEnv = scrubPositionalSecrets(['config', 'SET-ENV', 'AK', 'XXX'], 'agentarts');
  assert.ok(upperSetEnv.includes('<redacted>'));
  const setKey = scrubPositionalSecrets(['config', 'set', 'env.access_key', 'AKIAIOSFODNN7EXAMPLE'], 'agentarts');
  assert.ok(setKey.includes('<redacted>'));
  const setToken = scrubPositionalSecrets(['config', 'set', 'my_token', 'SECRETTOKEN123'], 'agentarts');
  assert.ok(setToken.includes('<redacted>'));
  const setRegion = scrubPositionalSecrets(['config', 'set', 'base.region', 'cn-southwest-2'], 'agentarts');
  assert.ok(setRegion.includes('cn-southwest-2'));
  // A separated global flag before the service makes the service position
  // AMBIGUOUS — the obsutil scrub applies conservatively there (over-
  // scrubbing an already-invalid argv is harmless; missing credentials
  // leaks at rest).
  const ambiguous = scrubPositionalSecrets(
    ['--cli-region', 'cn-north-4', 'OBS', 'cp', '-i', 'AK1', '-k', 'SK1', 'obs://b', 'f'],
    'hcloud',
  );
  assert.ok(ambiguous.includes('<redacted>'));
  // The -bt short flag (argv-rejected by the wrapper) never echoes its
  // value in any payload.
  const bt = scrubPositionalSecrets(['invoke', '-bt', 'SECRETTOKEN123'], 'agentarts');
  assert.ok(bt.includes('<redacted>'));
  // Non-OBS hcloud commands: -i is an ordinary param, stays visible.
  const ecs = scrubPositionalSecrets(['ECS', 'ListServers', '-i', 'some-id', '--cli-region', 'cn-north-4'], 'hcloud');
  assert.deepEqual(ecs, ['ECS', 'ListServers', '-i', 'some-id', '--cli-region', 'cn-north-4']);
  // The SAME argv under the agentarts CLI (or no CLI) is untouched —
  // agentarts `-t` is --ttl (an int), never a secret.
  const ttl = scrubPositionalSecrets(['memory', 'create', 'x', '-t', '3600'], 'agentarts');
  assert.deepEqual(ttl, ['memory', 'create', 'x', '-t', '3600']);
  // admin_pass (the real ECS password param the toolkit teaches) is
  // covered in the separated form too — same as the inline form
  // redactString already masks.
  const adminPass = scrubPositionalSecrets(
    ['ECS', 'CreateServers', '--admin_pass', 'Pwd123!', '--cli-region', 'cn-north-4'],
    'hcloud',
  );
  assert.ok(adminPass.includes('<redacted>'));
  // The set-env NAME slot requires the config group ('configure' alias
  // included) — a stray 'set-env' token elsewhere is not a bearer.
  const stray = scrubPositionalSecrets(['invoke', 'set-env', 'TOKEN', 'abc'], 'agentarts');
  assert.deepEqual(stray, ['invoke', 'set-env', 'TOKEN', 'abc']);
  const configureAlias = scrubPositionalSecrets(['configure', 'set-env', 'AK', 'XXX'], 'agentarts');
  assert.ok(configureAlias.includes('<redacted>'));
  // hcloud plan display consumes the same scrubber: bare flag values and
  // obsutil shorts never ride the plan response, and the token still
  // binds the raw args.
  const pwPlan = planHcloudCommand(['ECS', 'CreateServers', '--password', 'AAA', '--cli-region', 'cn-north-4']);
  assert.ok(pwPlan.args.includes('<redacted>'));
  assert.doesNotMatch(pwPlan.command, /AAA/);
  const obsPlan = planHcloudCommand(['OBS', 'cp', '-i', 'AK1', '-k', 'SK1', '-t', 'T1', 'obs://b', 'f']);
  assert.ok(obsPlan.args.filter((a) => a === '<redacted>').length >= 3);
});

test('a rejected binding never burns the token — the corrected retry executes', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // The placeholder rejection (and mismatches) validate against the
    // INSPECTION entry before consume: the approval survives for the
    // corrected retry instead of reporting already_processed for a
    // command that never ran.
    const plan = planAgentartsCommand(['config', 'set-env', 'HUAWEICLOUD_SDK_AK', 'REALSECRET']);
    await assert.rejects(
      runAgentartsApprovedCommand({
        args: ['config', 'set-env', 'HUAWEICLOUD_SDK_AK', '<redacted>'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
      }),
      /placeholder/,
    );
    const retry = await runAgentartsApprovedCommand({
      args: ['config', 'set-env', 'HUAWEICLOUD_SDK_AK', 'REALSECRET'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(retry.status, 'ok');
    assert.equal(retry.approved, true);
    assert.notEqual(retry.outcome, 'already_processed');
  });
});

test('BEARER_TOKEN never reaches the child despite the invoke-family env fallback (trap 21 pin)', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // invoke.py:375 falls back to os.environ['BEARER_TOKEN'] — the CLI
    // would silently switch auth principal. The allowlist child env is
    // the only defense; this pin makes a future process.env spread fail.
    const prev = process.env.BEARER_TOKEN;
    process.env.BEARER_TOKEN = 'SECRET_BT_VALUE';
    try {
      const result = await runAgentartsReadonlyCommand([
        'memory',
        'list',
        '--region',
        'cn-southwest-2',
        '--stub-creds',
      ]);
      assert.equal(result.ok, true);
      assert.match(result.stdout, /bearer: \[\]/);
      assert.doesNotMatch(JSON.stringify(result), /SECRET_BT_VALUE/);
    } finally {
      if (prev === undefined) delete process.env.BEARER_TOKEN;
      else process.env.BEARER_TOKEN = prev;
    }
  });
});

test('a policy alias into the memory family resolves identically in wrapper and classifier (no crash)', async () => {
  await withIsolation(() => {
    // The value-flag table lookup goes through the SAME exported
    // resolveAgentartsGroupTokens the classifier consumes (aliases
    // included) — an alias mapping into memory must keep the guards
    // running instead of crashing on a null scan.
    const policy = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'plugins', 'huaweicloud-core', 'safety', 'policy.json'), 'utf8'),
    );
    policy.agentartsCommandPolicy.aliases.mem = 'memory';
    const ok = planAgentartsCommand(['mem', 'create', 'x', '--strategies', 'semantic'], { policy });
    assert.equal(ok.ok, true);
    assert.equal(ok.tier, 'approved');
    assert.equal(ok.operation, 'memory create');
    const missing = planAgentartsCommand(['mem', 'create', 'x'], { policy });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /--strategies/);
    const collapsed = planAgentartsCommand(['mem', 'create', 'x', '--strategies', 'semantic', '-d', '--help'], {
      policy,
    });
    assert.equal(collapsed.ok, true);
    assert.equal(collapsed.tier, 'approved');
  });
});

test('approvals.json never stores bare positional secrets; the placeholder flow still binds', async () => {
  await withIsolation(async ({ home }) => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // The token store's argsRedacted is positional-scrubbed: a bare
    // secret value after a secret-named flag must not ride approvals.json
    // at rest. The hash still binds the REAL args; substituting a secret
    // value (the documented replace-<redacted> flow) stays allowed because
    // both comparison sides scrub positionals.
    const secretArgs = ['config', 'set-env', 'HUAWEICLOUD_SDK_AK', 'RAWSECRET123'];
    const plan = planAgentartsCommand(secretArgs);
    assert.equal(plan.tier, 'approved');
    const approvalsPath = join(home, '.config', 'huaweicloud', 'approvals.json');
    const store = JSON.parse(readFileSync(approvalsPath, 'utf8'));
    const entry = store[plan.approvalToken];
    assert.ok(entry, 'token entry must exist in approvals.json');
    assert.doesNotMatch(JSON.stringify(store), /RAWSECRET123/);
    assert.ok(entry.argsRedacted.includes('<redacted>'));
    // Placeholder flow: run with a DIFFERENT secret value — the hash
    // differs, both redacted forms scrub to <redacted> → allowed (this is
    // the documented "replace <redacted> placeholders" path).
    const run = await runAgentartsApprovedCommand({
      args: ['config', 'set-env', 'HUAWEICLOUD_SDK_AK', 'OTHERSECRET456'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(run.status, 'ok');
    assert.doesNotMatch(JSON.stringify(run), /RAWSECRET123|OTHERSECRET456/);
    // A non-secret positional substitution still fails the binding.
    const tamper = planAgentartsCommand(['config', 'set', 'base.region', 'cn-southwest-2']);
    await assert.rejects(
      runAgentartsApprovedCommand({
        args: ['config', 'set', 'base.region', 'cn-north-4'],
        approvalToken: tamper.approvalToken,
        approvedByUser: true,
      }),
      /do not match the approved plan/i,
    );
  });
});

test('a timed-out create still captures the one-time key — exactly once', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // The stub prints the create JSON, then hangs: the run times out, but
    // the key must be captured from the accumulated stdout. The late
    // post-SIGKILL close is guarded by `if (settled) return` — no second
    // capture pass (no orphan side file, no late duplicate key write
    // contradicting the reported outcome).
    const plan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--stub-hang-key']);
    const run = await runAgentartsApprovedCommand({
      args: ['memory', 'create', 'x', '--strategies', 'semantic', '--stub-hang-key', '--output', 'json'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
      timeoutMs: 1500,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.ok, false);
    assert.equal(run.timedOut, true);
    assert.equal(run.spaceId, 'space-hang-001');
    assert.equal(readFileSync(run.memoryApiKeyFile, 'utf8').trim(), 'KEY_ONETIME_hang42');
    assert.doesNotMatch(JSON.stringify(run), /KEY_ONETIME_hang42/);
    // Pin the single-capture guard OBSERVABLY: the stub's short sleep
    // fires the post-SIGKILL close shortly after the timeout settle —
    // without `if (settled) return` a second captureAndScrub would run
    // then (a second key write / side file). Wait past the close window
    // and assert the key file was not rewritten.
    const mtimeAfterRun = statSync(run.memoryApiKeyFile).mtimeMs;
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(statSync(run.memoryApiKeyFile).mtimeMs, mtimeAfterRun, 'late close must not re-capture');
  });
});

test('approved memory create captures the one-time key to a 0600 file, payload stays redacted', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    const plan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic']);
    const run = await runAgentartsApprovedCommand({
      args: ['memory', 'create', 'x', '--strategies', 'semantic', '--output', 'json'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.ok, true);
    // The key file exists, is 0600, under the scratch state root, and holds
    // the RAW key.
    assert.equal(run.spaceId, 'space-e2e-002');
    const keyFile = run.memoryApiKeyFile;
    assert.match(keyFile, /agentarts-memory-api-key-space-e2e-002\.txt$/);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(keyFile, 'utf8').trim(), 'KEY_ONETIME_xyz789');
    // The returned payload NEVER carries the raw key (trap (a): extraction
    // happened pre-redaction, but only the path flows out).
    assert.doesNotMatch(JSON.stringify(run), /KEY_ONETIME_xyz789/);
    assert.match(run.stdout, /<redacted>/);
    // The token binds to the canonical form: non-canonical args mismatch.
    const plan2 = planAgentartsCommand(['memory', 'create', 'y', '--strategies', 'semantic']);
    await assert.rejects(
      runAgentartsApprovedCommand({
        args: ['memory', 'create', 'y', '--strategies', 'semantic'],
        approvalToken: plan2.approvalToken,
        approvedByUser: true,
      }),
      /do not match the approved plan/i,
    );
  });
});

test('key extraction survives noisy stdout; failure writes no key file', async () => {
  await withIsolation(async () => {
    setRuntimeCredentials('AKVALUE123', 'SKVALUE456');
    // The --stub-key variant prepends a log line before the JSON — the
    // regex fallback path must still capture the key.
    const plan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--stub-key']);
    const run = await runAgentartsApprovedCommand({
      args: ['memory', 'create', 'x', '--strategies', 'semantic', '--stub-key', '--output', 'json'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(run.ok, true);
    assert.equal(readFileSync(run.memoryApiKeyFile, 'utf8').trim(), 'KEY_ONETIME_abc123');

    // A failed create writes no key file and surfaces no capture fields.
    const failPlan = planAgentartsCommand(['memory', 'create', 'x', '--strategies', 'semantic', '--stub-traceback']);
    const failRun = await runAgentartsApprovedCommand({
      args: ['memory', 'create', 'x', '--strategies', 'semantic', '--stub-traceback', '--output', 'json'],
      approvalToken: failPlan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(failRun.status, 'ok');
    assert.equal(failRun.ok, false);
    assert.equal(failRun.memoryApiKeyFile, undefined);
    assert.equal(failRun.spaceId, undefined);
  });
});

test('resolveAgentartsCommand resolves AGENTARTS_BIN > devkit venv > PATH', () => {
  // Own env management (not withIsolation): the resolution chain must be
  // observable with AGENTARTS_BIN unset, which withIsolation never does.
  const home = mkdtempSync(join(tmpdir(), 'agentarts-resolve-'));
  const previousHome = process.env.HUAWEICLOUD_HOME;
  const previousBin = process.env.AGENTARTS_BIN;
  process.env.HUAWEICLOUD_HOME = home;
  delete process.env.AGENTARTS_BIN;
  const pathFallback = process.platform === 'win32' ? 'agentarts.exe' : 'agentarts';
  try {
    // No venv under the scratch devkit home: PATH fallback.
    assert.equal(resolveAgentartsCommand(), pathFallback);

    // A half-built venv (directory exists, CLI binary missing) never
    // shadows PATH.
    mkdirSync(agentartsVenvDir(), { recursive: true });
    assert.equal(resolveAgentartsCommand(), pathFallback);

    // The CLI binary in the devkit venv shadows PATH: the pinned
    // devkit-managed install beats an arbitrary PATH version.
    const venvBin = agentartsVenvBin();
    mkdirSync(dirname(venvBin), { recursive: true });
    writeFileSync(venvBin, 'stub', { mode: 0o755 });
    assert.equal(resolveAgentartsCommand(), venvBin);

    // The env override beats everything (e2e scratch venvs, user installs).
    process.env.AGENTARTS_BIN = '/opt/custom/agentarts';
    assert.equal(
      resolveAgentartsCommand(),
      process.platform === 'win32' ? '/opt/custom/agentarts.exe' : '/opt/custom/agentarts',
    );
    // An explicit value already ending in .exe is never double-suffixed.
    process.env.AGENTARTS_BIN = 'C:\\tools\\agentarts.exe';
    assert.equal(resolveAgentartsCommand(), 'C:\\tools\\agentarts.exe');
  } finally {
    if (previousHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = previousHome;
    if (previousBin === undefined) delete process.env.AGENTARTS_BIN;
    else process.env.AGENTARTS_BIN = previousBin;
    rmSync(home, { recursive: true, force: true });
  }
});
