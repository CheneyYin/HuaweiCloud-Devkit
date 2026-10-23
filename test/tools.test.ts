import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { callTool, TOOL_DEFINITIONS, listSkillDirs, type ToolArgs } from '../plugins/huaweicloud-core/src/tools.ts';
import { runVersionCheck } from '../plugins/huaweicloud-core/src/packs/huaweicloud-cli/tools.ts';
import { getToolSchema, TOOL_SCHEMAS } from '../plugins/huaweicloud-core/src/tool-schemas.ts';
import {
  clearRuntimeCredentials,
  resolveCredentialsWithRuntime,
  setRuntimeCredentials,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { getKooCliVersion } from '../plugins/huaweicloud-core/src/koocli-version.ts';
import type { RiskFinding } from '../plugins/huaweicloud-core/src/risk-rule-engine.ts';
import { fixtureDir } from './fixture-dir.ts';

interface HookCheckResult {
  ok: boolean;
  decision: 'allow' | 'warn' | 'deny';
  findings: RiskFinding[];
}

interface ServiceCatalogResult {
  recommendedSkills: string[];
}

interface RetrieveSkillResult {
  ok: boolean;
  error?: string;
  name?: string;
  version?: string | number;
  description?: string;
  content?: string;
  references: Array<{ filename: string; content: string }>;
}

interface AuthSwitchResult {
  status: string;
  scope?: string;
  error?: string;
}

test('runVersionCheck uses hcloud version instead of --version', async () => {
  const dir = fixtureDir('huaweicloud-toolkit-version-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, 'console.log(JSON.stringify({ version: "7.0.0", args: process.argv.slice(2) }));', 'utf8');

  const result = await runVersionCheck({
    executable: process.execPath,
    executableArgs: [script],
  });

  assert.equal(result.installed, true);
  assert.match(result.output, /"version":\s*"7\.0\.0"/);
  assert.doesNotMatch(result.output, /--version/);
});

test('runVersionCheck returns installed:false and errorCode on ENOENT', async () => {
  const result = await runVersionCheck({ executable: 'nonexistent-hcloud-xyz' });
  assert.equal(result.installed, false);
  assert.equal(result.errorCode, 'HCLOUD_NOT_FOUND');
  // #900: top-level nextStep is executable; verbose guidance moved to raw.
  assert.match(result.nextStep, /^(npx |hcloud )/);
  assert.equal(result.nextStep, 'npx huaweicloud-devkit install-hcloud');
  assert.match(result.raw, /koocli-install\.log/);
  assert.doesNotMatch(result.nextStep, /restart the agent/i);
});

test('runVersionCheck reports versionMismatch when installed version differs from kooCliVersion', async () => {
  const dir = fixtureDir('huaweicloud-toolkit-version-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, 'console.log(JSON.stringify({ version: "7.0.0", args: process.argv.slice(2) }));', 'utf8');

  const result = await runVersionCheck({
    executable: process.execPath,
    executableArgs: [script],
  });

  assert.equal(result.installed, true);
  assert.equal(result.installedVersion, '7.0.0');
  assert.equal(result.kooCliVersion, getKooCliVersion());
  assert.equal(result.versionMismatch, true);
  // #900: executable top-level nextStep; English detail only in raw.
  assert.match(result.nextStep, /^npx /);
  assert.match(result.raw, /version mismatch/i);
});

test('runVersionCheck reports no versionMismatch when installed version matches kooCliVersion', async () => {
  const dir = fixtureDir('huaweicloud-toolkit-version-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, `console.log("当前KooCLI版本:${getKooCliVersion()}");`, 'utf8');

  const result = await runVersionCheck({
    executable: process.execPath,
    executableArgs: [script],
  });

  assert.equal(result.installed, true);
  assert.equal(result.installedVersion, getKooCliVersion());
  assert.equal(result.versionMismatch, false);
});

test('TOOL_DEFINITIONS includes all required tools including sandbox', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  const required = [
    'huaweicloud_check_cli',
    'huaweicloud_plan_cli_command',
    'huaweicloud_run_readonly_command',
    'huaweicloud_list_operations',
    'huaweicloud_run_approved_command',
    'huaweicloud_show_profile_redacted',
    'huaweicloud_service_catalog',
    'huaweicloud_explain_error',
    'huaweicloud_search_docs',
    'huaweicloud_retrieve_skill',
    'huaweicloud_list_regions',
    'huaweicloud_get_regional_availability',
    'huaweicloud_search_marketplace',
    'huaweicloud_setup_obs_config',
    'huaweicloud_auth_status',
    'huaweicloud_auth_sync',
    'huaweicloud_sandbox_exec_with_session',
    'huaweicloud_sandbox_upload_file',
    'huaweicloud_sandbox_close_session',
    'huaweicloud_sandbox_check_user',
    'huaweicloud_sandbox_sign_agreement',
    'huaweicloud_sandbox_connect',
    'huaweicloud_sandbox_credentials',
    'huaweicloud_sandbox_expose_tunnel',
    'huaweicloud_voucher_status',
    'huaweicloud_voucher_claim',
    'huaweicloud_competition_voucher_claim',
    'huaweicloud_list_packs',
    'huaweicloud_pack_info',
    'huaweicloud_list_skills',
    'huaweicloud_secret_set',
    'huaweicloud_secret_list',
    'huaweicloud_secret_delete',
  ] as const;
  for (const name of required) {
    assert.ok(names.includes(name), `Missing tool: ${name}`);
  }
  assert.ok(names.length >= 25);
  assert.ok(names.includes('huaweicloud_search_marketplace'), 'Should have marketplace search tool');
});

test('TOOL_DEFINITIONS expose cwd parameter on run tools', () => {
  const readonlySchema = getToolSchema('huaweicloud_run_readonly_command').toJSONSchema();
  assert.ok(Object.hasOwn(readonlySchema.properties!, 'cwd'), 'run_readonly_command should have cwd param');

  const approvedSchema = getToolSchema('huaweicloud_run_approved_command').toJSONSchema();
  assert.ok(Object.hasOwn(approvedSchema.properties!, 'cwd'), 'run_approved_command should have cwd param');
});

test('TOOL_DEFINITIONS includes proactive hook check tools', () => {
  const names = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
  assert.ok(names.has('huaweicloud_hook_check_command'));
  assert.ok(names.has('huaweicloud_hook_check_artifacts'));
  assert.ok(names.has('huaweicloud_hook_check_deploy_plan'));
});

test('TOOL_SCHEMAS keys exactly match TOOL_DEFINITIONS names (no orphans either way)', () => {
  const registryNames = TOOL_DEFINITIONS.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
  const schemaKeys = Object.keys(TOOL_SCHEMAS).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    schemaKeys,
    registryNames,
    'a tool registered without a schema is unreachable over MCP; a schema without a registry entry is dead code',
  );
});

test('the vendorConfirmed gate rejects unasserted calls, and the first asserted call clears the challenge once', async () => {
  // The enforcement rung plus the challenge rung above it (A/B-measured,
  // 2026-10-23: teaching-only never asked 0/5; the gate asked 4/5 with the
  // residual failure a COLD fabricated assertion — so the session's first
  // asserted call bounces once with the BY-THE-USER-or-assumed challenge,
  // the plan→run dance shape models complete honestly). service_catalog is
  // the side-effect-free face for the positive arms; auth_status the
  // measured first move for the negative arm. The seam is toggled ON here
  // (file-top sets it off for the file's incidental cold asserts) and the
  // sessionIds are unique so the consumed flag never leaks across tests.
  process.env.HUAWEICLOUD_VENDOR_CHALLENGE = undefined;
  try {
    await assert.rejects(callTool('huaweicloud_auth_status', {}, { sessionId: 'vendor-dance' }), (error: Error) => {
      assert.match(error.message, /Vendor gate: this tool operates on Huawei Cloud/);
      assert.match(error.message, /Pass vendorConfirmed with the user's establishing words/);
      assert.match(error.message, /ask which cloud they mean, then retry once established/);
      return true;
    });
    // Quote-form regressions: the boolean shape no longer passes (the
    // A/B residual showed a checkbox models will check on assumption —
    // a quote is the statement they will not fabricate lightly), and an
    // empty quote is no quote.
    await assert.rejects(
      // The old boolean shape is deliberately typed-out of ToolArgs; the
      // cast sends it anyway to pin that the gate (not just the type)
      // rejects it.
      callTool('huaweicloud_auth_status', { vendorConfirmed: true } as unknown as ToolArgs, {
        sessionId: 'vendor-dance',
      }),
      (error: Error) => {
        assert.match(error.message, /Vendor gate: this tool operates on Huawei Cloud/);
        return true;
      },
    );
    await assert.rejects(
      callTool('huaweicloud_auth_status', { vendorConfirmed: '   ' }, { sessionId: 'vendor-dance' }),
      (error: Error) => {
        assert.match(error.message, /Vendor gate: this tool operates on Huawei Cloud/);
        return true;
      },
    );
    // Unasserted rejections never consume the challenge: the next COLD
    // quoted call still bounces.
    await assert.rejects(
      callTool(
        'huaweicloud_auth_status',
        { vendorConfirmed: 'test: vendor established by the harness' },
        { sessionId: 'vendor-dance' },
      ),
      (error: Error) => {
        assert.match(error.message, /Vendor challenge: first Huawei Cloud tool call this session/);
        assert.match(error.message, /is the vendorConfirmed quote the user's actual words, or invented/);
        assert.match(error.message, /Retry the same call to proceed/);
        return true;
      },
    );
    // The dance completes: the retried asserted call dispatches.
    const cataloged = (await callTool(
      'huaweicloud_service_catalog',
      { vendorConfirmed: 'test: vendor established by the harness', intent: 'deploy an ecs instance' },
      { sessionId: 'vendor-dance' },
    )) as unknown;
    assert.ok(cataloged, 'the retried attested call must dispatch');
    // Once per session: the challenge is consumed — the next asserted call
    // in the same session passes without a bounce.
    const again = (await callTool(
      'huaweicloud_service_catalog',
      { vendorConfirmed: 'test: vendor established by the harness', intent: 'list obs buckets' },
      { sessionId: 'vendor-dance' },
    )) as unknown;
    assert.ok(again, 'a second asserted call in the same session must not bounce');
  } finally {
    process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';
  }
});

test('huaweicloud_hook_check_command returns deny finding', async () => {
  const result = (await callTool('huaweicloud_hook_check_command', {
    command:
      'hcloud VPC CreateSecurityGroupRule --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
  })) as HookCheckResult;
  assert.equal(result.decision, 'deny');
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].ruleId, 'hwc-network-public-admin-port');
});

test('huaweicloud_explain_error maps APIGW.0301 to credential/project_id guidance', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'unknown',
    errorCode: 'APIGW.0301',
    message: 'Incorrect IAM authentication information',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Incorrect IAM authentication information/);
  assert.match(text, /auth init/);
  assert.match(text, /project_id/);
});

// A3/E2E-B1 (#935): the new ECS order-failure mappings, the Kps service
// entry, and the errorCode-only routing (real MCP calls pass only errorCode —
// the service key is derived from the dotted-code prefix).
test('huaweicloud_explain_error maps Ecs.0019 to on-sale flavor re-listing (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0019',
    message: 'the flavor does not exist',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0019/);
  assert.match(text, /ListFlavors/, 'must direct at hcloud ECS ListFlavors');
  assert.match(text, /replacement|替代/, 'must point at switching to a replacement flavor');
  assert.match(text, /flavors\.md/, 'must reference the flavors.md status field rules');
});

test('huaweicloud_explain_error maps Ecs.0319 to AZ-capacity guidance (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0319',
    message: 'insufficient capacity',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0319/);
  assert.match(text, /availability zone|AZ/i, 'must suggest changing the AZ');
  assert.match(text, /replacement|替代|ListFlavors/, 'must suggest switching the flavor and retrying');
});

test('huaweicloud_explain_error maps Ecs.0044 to volume-type sellout guidance (#971 A)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0044',
    message: 'the volumeType [SATA] is sellout in az[cn-north-4a]',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0044/);
  assert.match(text, /volume type|volumetype/i, 'must name the volume-type root cause');
  assert.match(text, /root_volume\.volumetype/, 'must direct at the exact parameter to change');
  assert.match(text, /Ecs\.0319/, 'must distinguish from the flavor-capacity error Ecs.0319');
  assert.match(text, /NovaListAvailabilityZones/, 'must offer the AZ-switch alternative');
});

test('huaweicloud_explain_error maps Ecs.0067 to cash-balance/recharge guidance (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0067',
    message: 'insufficient account balance',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0067/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must direct at the BSS cash balance query');
  assert.match(text, /top up|充值/i, 'must instruct topping up');
  assert.match(text, /代金券|voucher/i, 'must explain vouchers do not count in order risk control');
});

test('huaweicloud_explain_error adds a Kps service entry mapping KPS.9004 (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'KPS',
    errorCode: 'KPS.9004',
    message: 'keypair creation restricted',
  });
  const text = JSON.stringify(result);
  assert.match(text, /KPS\.9004/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must direct at the BSS cash balance query');
  assert.match(text, /arrears|欠费|historical/i, 'must mention settling historical arrears');
  // Lowercase service alias resolves to the same mapping.
  const lower = await callTool('huaweicloud_explain_error', {
    service: 'kps',
    errorCode: 'KPS.9004',
    message: 'keypair creation restricted',
  });
  assert.match(JSON.stringify(lower), /KPS\.9004/);
});

test('explain_error with errorCode only (no service) hits Ecs.0019 mapping (#935 E2E-B1)', async () => {
  // MCP probe evidence: errorCode-only call returned "No known error-code
  // pattern matched", service: unknown — the service-keyed table was never hit.
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0019' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0019/);
  assert.match(text, /taken offline/, 'must hit the Ecs.0019 flavor-offline mapping');
  assert.match(text, /ListFlavors/, 'must direct at hcloud ECS ListFlavors');
});

test('explain_error with errorCode only (no service) hits Ecs.0319 mapping (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0319' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0319/);
  assert.match(text, /availability zone/i, 'must hit the Ecs.0319 AZ-capacity mapping');
});

test('explain_error with errorCode only (no service) hits Ecs.0067 mapping (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0067' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0067/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must hit the cash-balance mapping without a service arg');
});

test('huaweicloud_explain_error fallback teaches context capture and error-center lookup (#648)', async () => {
  // Regression input from issue #648 EXP-E08: ECS Ecs.0103 with minimal context
  // fell into the generic fallback and produced only a "collect info" line.
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0103',
    message: 'ECS instance startup failed',
  });
  const text = JSON.stringify(result);
  assert.match(text, /--debug/);
  assert.match(text, /X-Request-Id/);
  assert.match(text, /re-call explain_error/);
  assert.match(text, /Ecs\.0103/);
  assert.match(text, /support\.huaweicloud\.com/);
  // requestId was empty, so the support-ticket line must not appear.
  assert.doesNotMatch(text, /Provide the Request ID/);
});

test('huaweicloud_explain_error still appends support line when requestId is present', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0103',
    message: 'ECS instance startup failed',
    requestId: 'req-abc-123',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Provide the Request ID \(req-abc-123\) when contacting Huawei Cloud support\./);
});

test('callTool rejects invalid numeric timeoutMs instead of silently ignoring it', async () => {
  await assert.rejects(
    () =>
      callTool('huaweicloud_run_readonly_command', {
        vendorConfirmed: 'test: vendor established by the harness',
        args: ['ECS', 'ListServersDetails'],
        timeoutMs: 'not-a-number',
      } as unknown as ToolArgs),
    /positive number/,
  );
});

test('callTool accepts maxRetries 0 and integer timeoutMs (no false rejection)', async () => {
  // maxRetries: 0 is legitimate ("no retries") and must pass normalization (#530)
  await assert.doesNotReject(() =>
    callTool('huaweicloud_plan_cli_command', {
      vendorConfirmed: 'test: vendor established by the harness',
      args: ['ECS', 'ListServersDetails'],
      maxRetries: 0,
      timeoutMs: 30000,
    }),
  );
});

test('huaweicloud_hook_check_artifacts detects broad IAM policy', async () => {
  const result = (await callTool('huaweicloud_hook_check_artifacts', {
    artifacts: [
      {
        path: 'policy.json',
        content: '{"Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}',
      },
    ],
  })) as HookCheckResult;
  assert.equal(result.decision, 'deny');
  assert.equal(result.findings[0].ruleId, 'hwc-iam-admin-policy');
});

test('huaweicloud_hook_check_deploy_plan warns on sandbox without ttl', async () => {
  const result = (await callTool('huaweicloud_hook_check_deploy_plan', {
    plan: {
      environment: 'preview',
      resources: [{ service: 'FunctionGraph', action: 'CreateFunction' }],
    },
  })) as HookCheckResult;
  assert.equal(result.decision, 'warn');
  assert.equal(result.ok, true);
  assert.equal(result.findings[0].ruleId, 'hwc-sandbox-missing-ttl');
});

test('service_catalog recommends sandbox first for static website deployment intent', async () => {
  const en = (await callTool('huaweicloud_service_catalog', {
    vendorConfirmed: 'test: vendor established by the harness',
    intent: 'deploy a static website',
  })) as ServiceCatalogResult;
  assert.equal(en.recommendedSkills[0], 'huawei-sandbox');
  assert.ok(en.recommendedSkills.includes('huawei-obs'));

  const zh = (await callTool('huaweicloud_service_catalog', {
    vendorConfirmed: 'test: vendor established by the harness',
    intent: '部署静态网站到华为云',
  })) as ServiceCatalogResult;
  assert.equal(zh.recommendedSkills[0], 'huawei-sandbox');

  const webApp = (await callTool('huaweicloud_service_catalog', {
    vendorConfirmed: 'test: vendor established by the harness',
    intent: 'host a web app for preview',
  })) as ServiceCatalogResult;
  assert.equal(webApp.recommendedSkills[0], 'huawei-sandbox');
});

test('service_catalog keeps storage routing for pure storage intent', async () => {
  const result = (await callTool('huaweicloud_service_catalog', {
    vendorConfirmed: 'test: vendor established by the harness',
    intent: 'store files in an obs bucket',
  })) as ServiceCatalogResult;
  assert.ok(result.recommendedSkills.includes('huawei-obs'));
  assert.notEqual(result.recommendedSkills[0], 'huawei-sandbox');
});

// Symlink creation needs privileges on Windows (the repo's other symlink
// tests skip there for the same reason); GitHub-hosted runners happen to be
// elevated, but the suite must not depend on that.
test(
  'listSkillDirs ignores files, subdirs without SKILL.md, and counts symlinked skill dirs',
  { skip: process.platform === 'win32' },
  () => {
    const base = fixtureDir('huaweicloud-list-skills-');
    try {
      const root = join(base, 'root');
      const external = join(base, 'external');
      mkdirSync(root, { recursive: true });
      mkdirSync(join(external, 'huawei-vpc'), { recursive: true });
      writeFileSync(join(external, 'huawei-vpc', 'SKILL.md'), '---\nname: huawei-vpc\n---\n', 'utf8');
      symlinkSync(join(external, 'huawei-vpc'), join(root, 'huawei-vpc'));
      mkdirSync(join(root, 'no-skill'));
      writeFileSync(join(root, 'stray.md'), 'x');

      assert.deepEqual(
        listSkillDirs(root).sort((a, b) => a.localeCompare(b)),
        ['huawei-vpc'],
      );
      assert.deepEqual(listSkillDirs(join(base, 'missing')), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

// retrieve_skill is the server-side skill loader, so its name boundary is
// security-relevant: traversal-shaped names must be rejected before any
// filesystem access.
test('retrieve_skill rejects traversal-shaped and non-skill names', async () => {
  for (const name of ['../src/packs/obs/skills/huawei-obs', '..%2f..', 'huawei ecs', 'HUAWAI-ECS', '/etc', '']) {
    const result = (await callTool('huaweicloud_retrieve_skill', { name })) as RetrieveSkillResult;
    assert.equal(result.ok, false, `name ${JSON.stringify(name)} must be rejected`);
    assert.match(result.error!, /Invalid skill name|Skill name is required/);
  }
});

test('retrieve_skill serves the full skill from the server-relative tree', async () => {
  const result = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' })) as RetrieveSkillResult;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.name, 'huawei-ecs');
  assert.match(result.content!, /^---\r?\nname: huawei-ecs/);
  assert.ok(result.references.length > 0, 'huawei-ecs ships reference files');
  assert.ok(result.references.some((ref) => ref.filename === 'create-instance.md'));
});

// The consumer-level pin of the truncation fix: the parser unit tests and
// the structure invariant guard the module and the corpus, this guards the
// wiring — a future first-line regex dropped back into retrieveSkill fails
// here even though every other gate stays green.
test('retrieve_skill returns the full multi-line description, quote-stripped', async () => {
  const result = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' })) as RetrieveSkillResult;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.version, '1');
  assert.ok(result.description!.startsWith('Use when'), 'the YAML quote must not survive into retrieve_skill output');
  assert.ok(
    result.description!.includes('HC活动场景'),
    'the multi-line second paragraph must survive into retrieve_skill output',
  );
  assert.deepEqual(
    result.references.map((ref) => ref.filename),
    ['create-instance.md', 'evs.md', 'flavors.md', 'hc-activity.md', 'troubleshooting.md', 'windows-ssh.md'],
    'references list in the same deterministic order list_skills serves',
  );
});

// The truncation cap must be visible, not silent: a reference cut at 4000
// chars carries a marker naming the <skillRoot> direct-read path, so a
// cross-reference deeper than the cap (e.g. a safety remediation citing a
// late section) reads as "beyond the cut", never as "does not exist".
test('retrieve_skill marks truncated references and leaves short ones whole', async () => {
  const result = (await callTool('huaweicloud_retrieve_skill', { name: 'huawei-ecs' })) as RetrieveSkillResult;
  assert.equal(result.ok, true, result.error);
  const long = result.references.find((ref) => ref.filename === 'create-instance.md')!;
  assert.ok(long.content.length > 4000, 'create-instance.md exceeds the cap after the 1.1.10 port');
  assert.match(long.content, /\[truncated at 4000 chars[^\]]*\]/, 'cut references must carry the truncation marker');
  const short = result.references.find((ref) => ref.filename === 'evs.md')!;
  assert.ok(!short.content.includes('[truncated'), 'short references must not carry the marker');
});

test('search_docs matches tokens from the multi-line description second paragraph', async () => {
  // 'Nginx部署' lives only in huawei-ecs's second paragraph: the CONTENT
  // index path found it even before the multi-line fix (whole-file match),
  // so the discriminating assertion is the snippet — the old first-line
  // snippet was quote-prefixed and paragraph-free.
  const result = (await callTool('huaweicloud_search_docs', { query: 'Nginx部署' })) as {
    ok: boolean;
    results: Array<{ name: string; snippet: string }>;
  };
  assert.equal(result.ok, true);
  const hit = result.results.find((entry) => entry.name === 'huawei-ecs');
  assert.ok(hit, 'the second-paragraph token must find huawei-ecs');
  assert.ok(hit!.snippet.startsWith('Use when'), 'the snippet must carry the quote-stripped description');
});

test('auth_switch temporary sets runtime credentials for api path', async () => {
  const prev = {
    AK: process.env.HW_ACCESS_KEY,
    SK: process.env.HW_SECRET_KEY,
  };
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  try {
    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'temporary',
      ak: 'RUNTIME_AK',
      sk: 'RUNTIME_SK',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
    assert.equal(out.scope, 'temporary');
    const resolved = resolveCredentialsWithRuntime({});
    assert.equal(resolved!.ak, 'RUNTIME_AK');
  } finally {
    clearRuntimeCredentials();
    if (prev.AK === undefined) delete process.env.HW_ACCESS_KEY;
    else process.env.HW_ACCESS_KEY = prev.AK;
    if (prev.SK === undefined) delete process.env.HW_SECRET_KEY;
    else process.env.HW_SECRET_KEY = prev.SK;
  }
});

test('auth_switch clear resets runtime', async () => {
  const isolatedHome = fixtureDir('huaweicloud-auth-clear-');
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = isolatedHome;
  try {
    setRuntimeCredentials('A', 'B', undefined, 'cn-north-4');
    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      action: 'clear',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'cleared');
    let threw = false;
    try {
      resolveCredentialsWithRuntime({});
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

// Hand-rolled HUAWEICLOUD_HOME isolation for the import-file tests: set a
// fixture home, run, and restore (with the runtime store cleared either way).
async function withImportHome(fn: () => Promise<void>): Promise<void> {
  const home = fixtureDir('auth-import-case-');
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
}

// Seed a creds-import.json under the isolated home.
function seedImportFile(ak: string, sk: string): { cfgDir: string; importFile: string } {
  const cfgDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud');
  mkdirSync(cfgDir, { recursive: true });
  const importFile = join(cfgDir, 'creds-import.json');
  writeFileSync(importFile, JSON.stringify({ ak, sk }), 'utf8');
  return { cfgDir, importFile };
}

test('auth_switch persist(mode=import) rejects missing region and keeps import file (#502)', async () => {
  await withImportHome(async () => {
    const { cfgDir, importFile } = seedImportFile('IMPORT_AK', 'IMPORT_SK');

    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'import',
      action: 'persist',
    })) as AuthSwitchResult;

    assert.equal(out.status, 'error');
    assert.equal(out.scope, 'invalid_region');
    assert.match(out.error!, /region/);
    // S1 must not be written on a rejected persist.
    assert.equal(existsSync(join(cfgDir, 'credentials.json')), false);
    // Import file must survive for replay.
    assert.equal(existsSync(importFile), true);
  });
});

test('auth_switch temporary(mode=import) clears import file on success', async () => {
  await withImportHome(async () => {
    const { importFile } = seedImportFile('TMP_AK', 'TMP_SK');

    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'import',
      action: 'temporary',
    })) as AuthSwitchResult;

    assert.equal(out.scope, 'temporary');
    assert.equal(existsSync(importFile), false, 'import file should be cleared after successful temporary set');
    assert.equal(resolveCredentialsWithRuntime({})!.ak, 'TMP_AK');
  });
});

test('auth_switch persist(mode=import) with STS token is rejected and clears import file', async () => {
  const home = fixtureDir('auth-import-sts-');
  const prevHome = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    const cfgDir = join(home, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    const importFile = join(cfgDir, 'creds-import.json');
    writeFileSync(
      importFile,
      JSON.stringify({ ak: 'STS_AK', sk: 'STS_SK', securityToken: 'STS_TOK', region: 'cn-north-4' }),
      'utf8',
    );

    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'import',
      action: 'persist',
    })) as AuthSwitchResult;

    assert.equal(out.status, 'error');
    assert.equal(out.scope, 'rejected');
    assert.equal(
      existsSync(importFile),
      false,
      'unfixable STS import must be cleared — no replay value, and no plaintext token residual',
    );
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    clearRuntimeCredentials();
    rmSync(home, { recursive: true, force: true });
  }
});

test('huaweicloud_explain_error maps Ecs.0707 to flavor/image-type combination troubleshooting (#922)', async () => {
  // Regression input from the 1024 activity report: kc2.small.2 + market-type
  // Ubuntu image → Ecs.0707 "the product does not exist", with no hint which
  // side (flavor vs image type) is wrong. Both service spellings (ECS and the
  // lowercase alias) must route to the Ecs pattern table.
  for (const service of ['ECS', 'ecs']) {
    const result = (await callTool('huaweicloud_explain_error', {
      service,
      errorCode: 'Ecs.0707',
      message: 'the product does not exist',
    })) as { suggestions?: string[] };
    const text = JSON.stringify(result);
    assert.match(text, /flavor \+ image-type combination/);
    if (service === 'ECS') {
      assert.match(text, /gold/, 'must point at gold-type images');
      assert.match(text, /market/, 'must name the market-type incompatibility');
      assert.match(text, /ListFlavors/, 'must direct at re-listing flavors');
      assert.match(text, /cond:operation/, 'must point at the AZ/status spec fields');
    }
  }
});

test('G: explain_error surfaces CREDENTIAL_EXPIRED first when temp STS has expired', async () => {
  // parseStsExpiry prioritizes HW_STS_EXPIRES_AT over the token itself — scrub
  // it (and the ambient HW_* triplet) so the expired-token setup is real.
  const prev = {
    HW_STS_EXPIRES_AT: process.env.HW_STS_EXPIRES_AT,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
  };
  for (const key of ['HW_STS_EXPIRES_AT', 'HW_ACCESS_KEY', 'HW_SECRET_KEY', 'HW_SECURITY_TOKEN']) {
    delete process.env[key];
  }
  clearRuntimeCredentials();
  const past = Math.floor(Date.now() / 1000) - 3600;
  const token = Buffer.from(JSON.stringify({ exp: past })).toString('base64url');
  setRuntimeCredentials('EXP_AK', 'EXP_SK', token, 'cn-north-4');
  try {
    const result = (await callTool('huaweicloud_explain_error', {
      service: 'VPC',
      errorCode: 'APIGW.0301',
      message: 'Incorrect IAM authentication information',
    })) as { suggestions?: string[] };
    const text = JSON.stringify(result);
    assert.match(text, /CREDENTIAL_EXPIRED/);
    assert.match(text, /security token has expired/i);
    assert.ok(Array.isArray(result.suggestions) && result.suggestions.length > 0);
  } finally {
    clearRuntimeCredentials();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// Hermetic fake hcloud for list_operations (honors --help/help, exits 0) with
// the HCLOUD_BIN pair set around the body and restored either way.
async function withFakeHcloudForList(fn: () => Promise<void>): Promise<void> {
  const dir = fixtureDir('tools-list-ops-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, `console.log('operations: ListX ShowX CreateX'); process.exit(0);`, 'utf8');
  const prevBin = process.env.HCLOUD_BIN;
  const prevArgs = process.env.HCLOUD_BIN_ARGS_JSON;
  process.env.HCLOUD_BIN = process.execPath;
  process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([script]);
  try {
    await fn();
  } finally {
    if (prevBin === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = prevBin;
    if (prevArgs === undefined) delete process.env.HCLOUD_BIN_ARGS_JSON;
    else process.env.HCLOUD_BIN_ARGS_JSON = prevArgs;
  }
}

// ── list_operations aggregate fan-out + Chinese intent keywords ─────────────

test('list_operations fans DMS/DEW out to their KooCLI sub-services', async () => {
  await withFakeHcloudForList(async () => {
    for (const [aggregate, subs] of [
      ['DMS', ['Kafka', 'RabbitMQ', 'RocketMQ']],
      ['DEW', ['KMS', 'CSMS']],
    ] as const) {
      const result = (await callTool('huaweicloud_list_operations', {
        service: aggregate,
        maxRetries: 0,
        timeoutMs: 30000,
      })) as {
        service: string;
        aggregate: boolean;
        aggregatedFrom: string[];
        subServices: Array<{ subService: string; command: string }>;
      };
      assert.equal(result.aggregate, true, `${aggregate} is an aggregate name`);
      assert.deepEqual(result.aggregatedFrom, [...subs]);
      assert.deepEqual(
        result.subServices.map((s) => s.subService),
        [...subs],
      );
      for (const sub of result.subServices) {
        assert.match(sub.command, new RegExp(`^hcloud ${sub.subService} --help$`));
      }
    }
  });
});

test('list_operations carries BSS identity notes (Customer vs Partner API split)', async () => {
  await withFakeHcloudForList(async () => {
    const result = (await callTool('huaweicloud_list_operations', {
      service: 'BSS',
      maxRetries: 0,
      timeoutMs: 30000,
    })) as {
      identityNotes: Array<{ identity: string; apis: string[]; note: string }>;
    };
    assert.ok(Array.isArray(result.identityNotes) && result.identityNotes.length === 2);
    const partner = result.identityNotes.find((n) => n.identity.includes('Partner'));
    assert.ok(partner, 'the Partner-level class is present');
    assert.ok(partner!.apis.includes('ListQuotaCoupons'));
    assert.match(partner!.note, /NOT bad AK\/SK or a missing cli-domain-id/);
  });
});

async function assertSkillForIntent(intent: string, expectedSkill: string): Promise<void> {
  const result = (await callTool('huaweicloud_service_catalog', { intent })) as {
    recommendedSkills?: string[];
  };
  assert.ok(
    (result.recommendedSkills ?? []).includes(expectedSkill),
    `intent "${intent}" must route to ${expectedSkill}, got ${JSON.stringify(result.recommendedSkills)}`,
  );
}

test('serviceCatalog routes Chinese intent keywords to the right skills', async () => {
  const cases: Array<[string, string]> = [
    ['弹性云服务器怎么创建', 'huawei-ecs'],
    ['申请一个弹性公网IP', 'huawei-vpc'],
    ['对象存储静态托管', 'huawei-obs'],
    ['函数工作流触发器配置', 'huawei-functiongraph'],
    ['关系型数据库高可用', 'huawei-rds'],
    ['访问密钥在哪里管理', 'huawei-iam'],
    ['密钥管理服务加密', 'huawei-cloud-dew-key-management'],
    ['查询账单计费明细', 'huawei-billing'],
    ['配置监控告警', 'huawei-cloud-eye'],
    ['查看审计追踪记录', 'huawei-cloud-cts-trace-management'],
    ['创建备份存储库', 'huawei-cbr'],
    ['文档数据库连接', 'huawei-cloud-dds-dcs-instance-management'],
    ['负载均衡监听器', 'huawei-vpc'],
  ];
  for (const [intent, expectedSkill] of cases) {
    await assertSkillForIntent(intent, expectedSkill);
  }
});

test('serviceCatalog: slash-bearing keywords (ak/sk, ci/cd) match via the phrase path', async () => {
  // Same routing contract as the Chinese-intent test above, exercised through
  // the shared assertSkillForIntent helper to avoid duplicating its loop.
  await assertSkillForIntent('configure AK/SK credentials', 'huawei-iam');
  await assertSkillForIntent('ci/cd pipeline for deployment', 'huawei-cloud-deployment-task-management');
});
