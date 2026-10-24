// Full-scenario matrix for the credential reconciliation feature.
// Every test is hermetic: HUAWEICLOUD_HOME points at a temp dir, HW_* / HCLOUD_*
// env vars are wiped and restored, runtime credentials are cleared, and none of
// the developer's real ~/.config/huaweicloud or ~/.hcloud files are touched.
// Only masked fingerprints (sha256(ak+sk).slice(0,8)) appear in assertions.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  backupGlobalCredentials,
  clearRuntimeCredentials,
  globalCredentialsPath,
  hasRuntimeCredentials,
  lastSyncPath,
  readGlobalCredentials,
  resolveCredentials,
  resolveCredentialsWithRuntime,
  restoreGlobalCredentialsBackup,
  setRuntimeCredentials,
  writeGlobalCredentials,
  writeLastSync,
  writeObsConfig,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { fingerprint, runHcloudConfigure, scanState } from '../plugins/huaweicloud-core/src/auth/reconcile.ts';
import { syncAuth, getAuthStatus, type SyncAuthResult } from '../plugins/huaweicloud-core/src/auth/service.ts';
import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern) so cold-attested calls in this file dispatch without the
// challenge bounce. The challenge itself is pinned where it is the subject
// (tools.test.ts's gate test drives the dance; the selfcheck drives it on
// the wire); the real-model e2e tier never sets this seam.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

const FAKE_HCLOUD = fileURLToPath(new URL('./fixtures/fake-hcloud.ts', import.meta.url));
const FAKE_HCLOUD_FAIL = fileURLToPath(new URL('./fixtures/fake-hcloud-fail-config.ts', import.meta.url));
const FAKE_HCLOUD_FAIL_PROJECT_ID = fileURLToPath(
  new URL('./fixtures/fake-hcloud-fail-project-id.ts', import.meta.url),
);
const FAKE_HCLOUD_PRIVACY = fileURLToPath(new URL('./fixtures/fake-hcloud-privacy.ts', import.meta.url));

const ENV_KEYS = [
  'HUAWEICLOUD_HOME',
  'HCLOUD_CONFIG_PATH',
  'HCLOUD_OBS_CONFIG_PATH',
  'HW_ACCESS_KEY',
  'HW_SECRET_KEY',
  'HW_SECURITY_TOKEN',
  'HW_REGION',
  'HUAWEICLOUD_REGION',
  'HCLOUD_BIN',
  'HCLOUD_BIN_ARGS_JSON',
  'HCLOUD_FAKE_LOG',
  'HCLOUD_FAKE_SCRIPT',
  'HCLOUD_FAKE_DELETE_ERROR',
  'HW_STS_EXPIRES_AT',
  'CODEARTS_PROJECT_DIR',
];

type AuthSwitchResult =
  | { status: 'needs_confirmation'; confirmToken: string }
  | { status: 'error'; scope: string; error: string }
  | { status: 'ok' | 'cleared' | 'partial'; scope?: string; backedUp?: boolean; outcome?: string };

function withTempHome(fn: (dir: string) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-e2e-'));
  const prev: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) prev[key] = process.env[key];
  process.env.HUAWEICLOUD_HOME = dir;
  process.env.HCLOUD_CONFIG_PATH = join(dir, '.hcloud', 'config.json');
  process.env.HCLOUD_OBS_CONFIG_PATH = join(dir, '.obsutilconfig');
  for (const key of ENV_KEYS) {
    if (key !== 'HUAWEICLOUD_HOME' && key !== 'HCLOUD_CONFIG_PATH' && key !== 'HCLOUD_OBS_CONFIG_PATH')
      delete process.env[key];
  }
  clearRuntimeCredentials();
  const cleanup = () => {
    clearRuntimeCredentials();
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

// The fake KooCLI config is wired to HCLOUD_CONFIG_PATH (set in withTempHome),
// so readKooCliProfiles reads it instead of the real ~/.hcloud/config.json.
interface FakeKooCliProfile {
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  securityToken?: string;
}

function writeFakeKooCli(current: string, profiles: FakeKooCliProfile[]) {
  const p = join(process.env.HUAWEICLOUD_HOME!, '.hcloud', 'config.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ current, profiles }, null, 2));
  return p;
}

function setFakeHcloud(logPath: string, fixture: string = FAKE_HCLOUD) {
  process.env.HCLOUD_BIN = process.execPath;
  process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([fixture]);
  process.env.HCLOUD_FAKE_LOG = logPath;
}

test('01 auth init path keeps S1/S2-current/S3 fingerprints equal', () => {
  withTempHome((dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E1_AK';
    const sk = 'E2E1_SK';
    const region = 'cn-north-4';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region }]);
    writeGlobalCredentials({ ak, sk, region });
    writeObsConfig({ ak, sk, region });
    const res = runHcloudConfigure('deploy', ak, sk, region);
    assert.equal(res.ok, true);

    const scan = scanState();
    assert.equal(scan.stores.s1Fingerprint, fingerprint(ak, sk));
    assert.equal(scan.stores.currentFingerprint, fingerprint(ak, sk));
    assert.equal(scan.stores.s3Fingerprint, fingerprint(ak, sk));
    assert.equal(scan.inconsistencies.length, 0);
  });
});

test('02 manual edit of KooCLI current profile reports S2-current manualModified', () => {
  withTempHome((dir) => {
    writeGlobalCredentials({ ak: 'E2E2_S1_AK', sk: 'E2E2_S1_SK', region: 'cn-north-4' });
    // Marker is written with an old ts BEFORE the config write so the mtime
    // comparison (config mtime > marker ts) is deterministic.
    const cfgDir = join(dir, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(lastSyncPath(), JSON.stringify({ ts: Date.now() - 60_000 }));
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E2_S2_AK', secretAccessKey: 'E2E2_S2_SK', region: 'cn-north-4' },
    ]);

    const scan = scanState();
    const inc = scan.inconsistencies.find((i) => i.store === 'S2-current');
    assert.ok(inc, 'expected an S2-current inconsistency');
  });
});

test('03 manual edit of obsutilconfig reports S3 manualModified', () => {
  withTempHome((dir) => {
    writeGlobalCredentials({ ak: 'E2E3_S1_AK', sk: 'E2E3_S1_SK', region: 'cn-north-4' });
    const cfgDir = join(dir, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(lastSyncPath(), JSON.stringify({ ts: Date.now() - 60_000 }));
    writeObsConfig({ ak: 'E2E3_S3_AK', sk: 'E2E3_S3_SK', region: 'cn-north-4' });

    const scan = scanState();
    const inc = scan.inconsistencies.find((i) => i.store === 'S3');
    assert.ok(inc, 'expected an S3 inconsistency');
    assert.equal(inc.manualModified, true);
  });
});

test('04 syncAuth is rejected (R10) while runtime credentials are active', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E4_AK', sk: 'E2E4_SK', region: 'cn-north-4' });
    setRuntimeCredentials('E2E4_RT_AK', 'E2E4_RT_SK');
    const res = syncAuth('all');
    assert.equal(res.ok, false);
    // #900: the unified ERROR_TABLE shape — messageZh carries the Chinese
    // verdict, action is executable, and no internal codename (R10) leaks.
    assert.equal(res.code, 'HDKIT_SYNC_SKIPPED_RUNTIME');
    assert.match(res.messageZh ?? '', /运行时凭证生效,自动同步已跳过。/);
    assert.equal(res.action, 'huaweicloud_auth_switch action=clear');
    assert.equal(res.nextStep, res.action);
    assert.doesNotMatch(res.error, /R10/);
  });
});

test('05 syncAuth propagates S1 into the KooCLI current profile', () => {
  withTempHome((dir) => {
    const log = join(dir, 'hcloud.log');
    setFakeHcloud(log);
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E5_OLD_AK', secretAccessKey: 'E2E5_OLD_SK', region: 'cn-north-4' },
    ]);
    writeGlobalCredentials({ ak: 'E2E5_AK', sk: 'E2E5_SK', region: 'cn-north-4' });

    const res = syncAuth('all');
    assert.equal(res.ok, true);
    assert.equal(res.profile, 'deploy');

    const logContent = readFileSync(log, 'utf8');
    assert.match(logContent, /--cli-profile=deploy/);
    assert.match(logContent, /--cli-access-key=E2E5_AK/);
    assert.equal(existsSync(lastSyncPath()), true, 'syncAuth must write the .last_sync marker');

    // #920: syncAuth walks the SAME purge as the persist path — delete before
    // set — and the honest message carries no stale-token warning on success.
    assertDeleteBeforeSet(readHcloudCalls(log));
    assert.match(res.hcloud.message, /synced to profile=deploy/);
    assert.doesNotMatch(res.hcloud.message, /profile reset failed/);
    assert.doesNotMatch(res.hcloud.message, /project-id not restored/);
    // And the purge's project-id wipe is restored end-to-end.
    assert.equal(res.projectId, 'proj-e2e-001');
  });
});

test('06 auth_switch temporary activates runtime; auth_sync is then rejected (R10)', async () => {
  await withTempHome(async () => {
    writeGlobalCredentials({ ak: 'E2E6_AK', sk: 'E2E6_SK', region: 'cn-north-4' });
    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'temporary',
      ak: 'E2E6_RT_AK',
      sk: 'E2E6_RT_SK',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(out.scope, 'temporary');
    assert.equal(resolveCredentialsWithRuntime({})!.ak, 'E2E6_RT_AK');

    const sync = (await callTool('huaweicloud_auth_sync', { target: 'all' })) as SyncAuthResult;
    assert.equal(sync.ok, false);
    // #900: the table shape — Chinese messageZh, executable action, no codename.
    assert.equal(sync.code, 'HDKIT_SYNC_SKIPPED_RUNTIME');
    assert.match(sync.messageZh ?? '', /运行时凭证生效,自动同步已跳过。/);
    assert.doesNotMatch(sync.error, /R10/);
  });
});

test('07 auth_switch persist first time writes configuredBySession and keeps files consistent', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E7_AK';
    const sk = 'E2E7_SK';
    const region = 'cn-north-4';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region }]);

    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'persist',
      ak,
      sk,
      region,
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(out.scope, 'persist');
    assert.equal(readGlobalCredentials()!.configuredBySession, true);

    const scan = scanState();
    assert.equal(scan.inconsistencies.length, 0);
    assert.equal(scan.stores.s1Fingerprint, fingerprint(ak, sk));
    assert.equal(scan.stores.currentFingerprint, fingerprint(ak, sk));
    assert.equal(scan.stores.s3Fingerprint, fingerprint(ak, sk));
  });
});

test('08 auth_switch persist with conflicting S1 returns needs_confirmation and leaves S1 intact', async () => {
  await withTempHome(async () => {
    writeGlobalCredentials({ ak: 'E2E8_A_AK', sk: 'E2E8_A_SK', region: 'cn-north-4' });
    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'persist',
      ak: 'E2E8_B_AK',
      sk: 'E2E8_B_SK',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'needs_confirmation');
    assert.ok(typeof out.confirmToken === 'string' && out.confirmToken.length > 0);
    assert.equal(readGlobalCredentials()!.ak, 'E2E8_A_AK', 'S1 must be unchanged before confirmation');
  });
});

test('09 auth_confirm decision=newImported applies the new account and backs up S1', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const newAk = 'E2E9_B_AK';
    const newSk = 'E2E9_B_SK';
    const region = 'cn-north-4';
    // Current profile already matches the new account so the post-confirm scan is consistent.
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: newAk, secretAccessKey: newSk, region }]);
    writeGlobalCredentials({ ak: 'E2E9_A_AK', sk: 'E2E9_A_SK', region });

    const switched = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'persist',
      ak: newAk,
      sk: newSk,
      region,
    })) as AuthSwitchResult;
    assert.equal(switched.status, 'needs_confirmation');

    const out = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: switched.confirmToken,
      decision: 'newImported',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(out.backedUp, true);
    assert.equal(readGlobalCredentials()!.ak, newAk);
    assert.equal(readGlobalCredentials()!.configuredBySession, true);
    assert.equal(existsSync(`${globalCredentialsPath()}.bak`), true, 'backup file must exist');

    const scan = scanState();
    assert.equal(scan.inconsistencies.length, 0);
    assert.equal(scan.stores.s1Fingerprint, fingerprint(newAk, newSk));
    assert.equal(scan.stores.currentFingerprint, fingerprint(newAk, newSk));
    assert.equal(scan.stores.s3Fingerprint, fingerprint(newAk, newSk));
  });
});

test('10 auth_confirm decision=s1 aborts and leaves S1 unchanged', async () => {
  await withTempHome(async () => {
    writeGlobalCredentials({ ak: 'E2E10_A_AK', sk: 'E2E10_A_SK', region: 'cn-north-4' });
    const switched = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'persist',
      ak: 'E2E10_B_AK',
      sk: 'E2E10_B_SK',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
    assert.equal(switched.status, 'needs_confirmation');

    const out = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: switched.confirmToken,
      decision: 's1',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(out.outcome, 'aborted');
    assert.equal(readGlobalCredentials()!.ak, 'E2E10_A_AK');
  });
});

test('10b auth_confirm(newImported) from import clears the import file on success', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const newAk = 'E2E10B_B_AK';
    const newSk = 'E2E10B_B_SK';
    const region = 'cn-north-4';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: newAk, secretAccessKey: newSk, region }]);
    writeGlobalCredentials({ ak: 'E2E10B_A_AK', sk: 'E2E10B_A_SK', region });

    const importFile = join(dir, '.config', 'huaweicloud', 'creds-import.json');
    mkdirSync(dirname(importFile), { recursive: true });
    writeFileSync(importFile, JSON.stringify({ ak: newAk, sk: newSk, region }), 'utf8');

    const switched = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'import',
      action: 'persist',
    })) as AuthSwitchResult;
    assert.equal(switched.status, 'needs_confirmation');
    assert.equal(existsSync(importFile), true, 'import file kept while awaiting confirmation');

    const out = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: switched.confirmToken,
      decision: 'newImported',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(readGlobalCredentials()!.ak, newAk);
    assert.equal(existsSync(importFile), false, 'import file cleared after successful confirm');
  });
});

test('11 auth_switch clear empties runtime and lets syncAuth run again', async () => {
  await withTempHome(async (dir) => {
    const log = join(dir, 'hcloud.log');
    setFakeHcloud(log);
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E11_OLD', secretAccessKey: 'E2E11_OLD', region: 'cn-north-4' },
    ]);
    setRuntimeCredentials('E2E11_RT_AK', 'E2E11_RT_SK');

    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      action: 'clear',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'cleared');
    assert.equal(hasRuntimeCredentials(), false);

    let threw = false;
    try {
      resolveCredentialsWithRuntime({});
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'no credentials resolvable after clear');

    writeGlobalCredentials({ ak: 'E2E11_AK', sk: 'E2E11_SK', region: 'cn-north-4' });
    const res = syncAuth('all');
    assert.equal(res.ok, true);
    assert.equal((res as { error?: string }).error, undefined);
    assert.doesNotMatch(JSON.stringify(res), /R10/);
    assert.match(readFileSync(log, 'utf8'), /--cli-access-key=E2E11_AK/);
  });
});

test('12 auth_switch mode=import reads creds-import.json then wipes it', async () => {
  await withTempHome(async (dir) => {
    const importPath = join(dir, '.config', 'huaweicloud', 'creds-import.json');
    mkdirSync(dirname(importPath), { recursive: true });
    writeFileSync(importPath, JSON.stringify({ ak: 'E2E12_IMP_AK', sk: 'E2E12_IMP_SK', region: 'cn-north-4' }));

    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'import',
      action: 'temporary',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(out.scope, 'temporary');
    assert.equal(existsSync(importPath), false, 'import file must be wiped after reading');

    const resolved = resolveCredentialsWithRuntime({});
    assert.equal(resolved!.ak, 'E2E12_IMP_AK');
    assert.equal(resolved!.sk, 'E2E12_IMP_SK');
  });
});

test('13 without configuredBySession, env credentials win over S1', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E13_S1_AK', sk: 'E2E13_S1_SK', region: 'cn-north-4' });
    process.env.HW_ACCESS_KEY = 'E2E13_ENV_AK';
    process.env.HW_SECRET_KEY = 'E2E13_ENV_SK';
    const creds = resolveCredentials();
    assert.equal(creds!.ak, 'E2E13_ENV_AK');
    assert.equal(creds!.sk, 'E2E13_ENV_SK');
  });
});

test('14 with configuredBySession=true, S1 wins over env (R9)', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E14_S1_AK', sk: 'E2E14_S1_SK', region: 'cn-north-4', configuredBySession: true });
    process.env.HW_ACCESS_KEY = 'E2E14_ENV_AK';
    process.env.HW_SECRET_KEY = 'E2E14_ENV_SK';
    const creds = resolveCredentials();
    assert.equal(creds!.ak, 'E2E14_S1_AK');
    assert.equal(creds!.sk, 'E2E14_S1_SK');
  });
});

test('15 active runtime shows in scanState and suppresses auto-write (R10)', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E15_AK', sk: 'E2E15_SK', region: 'cn-north-4' });
    setRuntimeCredentials('E2E15_RT_AK', 'E2E15_RT_SK');

    const scan = scanState();
    assert.equal(scan.hasRuntime, true);
    assert.equal(scan.stores.runtimeFingerprint, fingerprint('E2E15_RT_AK', 'E2E15_RT_SK'));

    const res = syncAuth('all');
    assert.equal(res.ok, false);
    // #900: the table shape replaces the old "suppressed (R10)" English string.
    assert.equal(res.code, 'HDKIT_SYNC_SKIPPED_RUNTIME');
    assert.match(res.messageZh ?? '', /运行时凭证生效,自动同步已跳过。/);
    assert.doesNotMatch(res.error, /R10/);
  });
});

test('16 restoreGlobalCredentialsBackup restores the previous S1', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E16_A_AK', sk: 'E2E16_A_SK', region: 'cn-north-4' });
    assert.ok(backupGlobalCredentials(), 'initial backup must succeed');
    writeGlobalCredentials({ ak: 'E2E16_B_AK', sk: 'E2E16_B_SK', region: 'cn-north-4' });
    assert.equal(readGlobalCredentials()!.ak, 'E2E16_B_AK');
    assert.equal(restoreGlobalCredentialsBackup(), true);
    assert.equal(readGlobalCredentials()!.ak, 'E2E16_A_AK');
  });
});

test('17 persist with securityToken is rejected (R3) and S1 is not written (mode=memory)', async () => {
  await withTempHome(async () => {
    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'persist',
      ak: 'E2E17_AK',
      sk: 'E2E17_SK',
      securityToken: 'E2E17_TOKEN',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'error');
    assert.equal(out.scope, 'rejected');
    assert.match(out.error, /R3/);
    assert.equal(existsSync(globalCredentialsPath()), false, 'S1 must not be written for STS credentials');
  });
});

test('18 persist via mcp-config with platform STS token is rejected (R3) and S1 untouched', async () => {
  await withTempHome(async (dir) => {
    const mcpDir = join(dir, 'codearts');
    mkdirSync(join(mcpDir, '.codeartsdoer', 'mcp'), { recursive: true });
    writeFileSync(
      join(mcpDir, '.codeartsdoer', 'mcp', 'mcp_settings.json'),
      JSON.stringify({
        mcpServers: {
          'huaweicloud-devkit': {
            env: {
              HW_ACCESS_KEY: 'E2E18_MCP_AK',
              HW_SECRET_KEY: 'E2E18_MCP_SK',
              HW_SECURITY_TOKEN: 'E2E18_MCP_TOKEN',
              HW_REGION: 'cn-north-4',
            },
          },
        },
      }),
      'utf8',
    );
    process.env.CODEARTS_PROJECT_DIR = mcpDir;

    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'mcp-config',
      action: 'persist',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'error');
    assert.equal(out.scope, 'rejected');
    assert.match(out.error, /R3/);
    assert.equal(existsSync(globalCredentialsPath()), false, 'S1 must not be written for platform STS token');

    const stored = readGlobalCredentials();
    assert.ok(!stored?.securityToken, 'no token may be at rest in S1');
  });
});

test('19 malformed creds-import.json is still wiped even though the import is rejected', async () => {
  await withTempHome(async (dir) => {
    const importPath = join(dir, '.config', 'huaweicloud', 'creds-import.json');
    mkdirSync(dirname(importPath), { recursive: true });
    writeFileSync(importPath, '{not-valid-json', 'utf8');

    await assert.rejects(
      callTool('huaweicloud_auth_switch', {
        vendorConfirmed: 'test: vendor established by the harness',
        mode: 'import',
        action: 'temporary',
      }),
      /ak and sk are required/,
    );
    assert.equal(existsSync(importPath), false, 'malformed import file must still be wiped');
  });
});

test('20 syncAuth returns ok:false and skips .last_sync when S2 configure fails', () => {
  withTempHome((dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'), FAKE_HCLOUD_FAIL);
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E20_OLD_AK', secretAccessKey: 'E2E20_OLD_SK', region: 'cn-north-4' },
    ]);
    writeGlobalCredentials({ ak: 'E2E20_AK', sk: 'E2E20_SK', region: 'cn-north-4' });

    const res = syncAuth('all');
    assert.equal(res.ok, false);
    assert.ok(res.error, 'failure must carry an error message');
    // Non-projectId configure failure: the table's KOOCLI_NOT_READY action
    // would advise reinstalling a CLI the probe just passed — action follows
    // the survivor's auth-init refresh verb instead (coherent remediation).
    assert.equal(res.code, 'HDKIT_KOOCLI_NOT_READY');
    assert.equal(res.action, 'npx huaweicloud-devkit auth init');
    assert.match(res.nextStep ?? '', /real terminal/);
    assert.equal(existsSync(lastSyncPath()), false, 'no .last_sync marker may be stamped when S2 sync failed');
  });
});

test('20b #900: configure failure with project_id stderr routes to HDKIT_PROJECT_ID_MISSING', () => {
  withTempHome((dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'), FAKE_HCLOUD_FAIL_PROJECT_ID);
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E20B_OLD_AK', secretAccessKey: 'E2E20B_OLD_SK', region: 'cn-north-4' },
    ]);
    writeGlobalCredentials({ ak: 'E2E20B_AK', sk: 'E2E20B_SK', region: 'cn-north-4' });

    const res = syncAuth('all');
    assert.equal(res.ok, false);
    // The projectIdCause heuristic: stderr mentions project id → the table's
    // project-id entry, with the executable configure action as nextStep.
    assert.equal(res.code, 'HDKIT_PROJECT_ID_MISSING');
    assert.match(res.messageZh ?? '', /KooCLI 配置缺少 project_id/);
    assert.match(res.messageZh ?? '', /invalid project id for region/);
    assert.equal(res.action, 'hcloud configure set --cli-project-id=<id>');
    assert.equal(res.nextStep, res.action);
    assert.ok(res.obs?.configured, 'OBS was already written before the configure step');
  });
});

test('20c #900: a not-ready probe routes to HDKIT_KOOCLI_NOT_READY with raw side-channel', () => {
  withTempHome((dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'), FAKE_HCLOUD_PRIVACY);
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E20C_OLD_AK', secretAccessKey: 'E2E20C_OLD_SK', region: 'cn-north-4' },
    ]);
    writeGlobalCredentials({ ak: 'E2E20C_AK', sk: 'E2E20C_SK', region: 'cn-north-4' });

    const res = syncAuth('all');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'HDKIT_KOOCLI_NOT_READY');
    assert.match(res.messageZh ?? '', /隐私协议待同意/);
    // Top-level nextStep is the executable table action; the verbose
    // English guidance (accept the agreement in a real terminal) is raw-only.
    assert.equal(res.nextStep, 'npx huaweicloud-devkit install-hcloud');
    assert.match(res.raw ?? '', /privacy agreement/i);
    assert.match(res.raw ?? '', /real terminal/);

    // getAuthStatus surfaces the same composition: executable kooCliNextStep
    // plus the verbose kooCliRaw side-channel.
    const status = getAuthStatus('all');
    assert.equal(status.kooCliStatus, 'privacy_pending');
    assert.equal(status.kooCliNextStep, 'npx huaweicloud-devkit install-hcloud');
    assert.match(status.kooCliRaw ?? '', /privacy agreement/i);
  });
});

test('21 scanState trusts fresh DevKit sync marker when KooCLI stores transformed SK', () => {
  withTempHome(() => {
    const ak = 'E2E21_AK';
    const sk = 'E2E21_SK';
    const region = 'cn-north-4';
    writeGlobalCredentials({ ak, sk, region });
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: ak, secretAccessKey: 'encrypted-or-transformed-by-koocli', region },
    ]);
    writeLastSync({ kooCliProfile: 'deploy', s1Fingerprint: fingerprint(ak, sk) });

    const scan = scanState();
    assert.equal(scan.stores.currentFingerprint, fingerprint(ak, sk));
    assert.equal(
      scan.inconsistencies.some((i) => i.store === 'S2-current'),
      false,
    );
  });
});

test('22 scanState still reports S2-current mismatch when KooCLI AK differs from S1', () => {
  withTempHome(() => {
    const ak = 'E2E22_AK';
    const sk = 'E2E22_SK';
    const region = 'cn-north-4';
    writeGlobalCredentials({ ak, sk, region });
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E22_OTHER_AK', secretAccessKey: 'encrypted-or-transformed-by-koocli', region },
    ]);
    writeLastSync({ kooCliProfile: 'deploy', s1Fingerprint: fingerprint(ak, sk) });

    const scan = scanState();
    const inc = scan.inconsistencies.find((i) => i.store === 'S2-current');
    assert.ok(inc, 'expected an S2-current inconsistency');
  });
});

test('23 scanState reports manualModified when KooCLI config is newer than .last_sync', () => {
  withTempHome(() => {
    const ak = 'E2E23_AK';
    const sk = 'E2E23_SK';
    const region = 'cn-north-4';
    writeGlobalCredentials({ ak, sk, region });
    writeFileSync(
      lastSyncPath(),
      JSON.stringify({ ts: Date.now() - 60_000, kooCliProfile: 'deploy', s1Fingerprint: fingerprint(ak, sk) }),
      'utf8',
    );
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: ak, secretAccessKey: 'encrypted-or-transformed-by-koocli', region },
    ]);

    const scan = scanState();
    const inc = scan.inconsistencies.find((i) => i.store === 'S2-current');
    assert.ok(inc, 'expected an S2-current inconsistency after manual KooCLI edit');
    assert.equal(inc.manualModified, true);
  });
});

// #920 test helpers: persist via the tool, read the fake hcloud call log,
// and assert the delete-before-set ordering the stale-token purge requires.
async function persistViaSwitch(
  ak: string,
  sk: string,
  region: string,
): Promise<AuthSwitchResult & { hcloud?: { ok?: boolean; profileReset?: boolean } }> {
  return (await callTool('huaweicloud_auth_switch', {
    mode: 'memory',
    action: 'persist',
    ak,
    sk,
    region,
    vendorConfirmed: 'test: vendor established by the harness',
  })) as AuthSwitchResult & { hcloud?: { ok?: boolean; profileReset?: boolean } };
}

function readHcloudCalls(log: string): string[][] {
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
}

function assertDeleteBeforeSet(calls: string[][]): void {
  const deleteIdx = calls.findIndex((c) => c[0] === 'configure' && c[1] === 'delete');
  const setIdx = calls.findIndex((c) => c[0] === 'configure' && c[1] === 'set');
  assert.ok(deleteIdx !== -1, 'configure delete must run (stale-token cleanup, #920)');
  assert.ok(setIdx !== -1, 'configure set must run after the delete (re-create)');
  assert.ok(deleteIdx < setIdx, 'the profile delete must precede the re-create');
}

// Read one profile from the fake KooCLI config (the fake implements the
// configure delete/set effects against the real config path).
function readFakeProfile(dir: string, name: string): Record<string, string> {
  const config = JSON.parse(readFileSync(join(dir, '.hcloud', 'config.json'), 'utf8')) as {
    profiles: Array<Record<string, string>>;
  };
  const profile = config.profiles.find((p) => p.name === name);
  assert.ok(profile, `profile ${name} must exist in the fake config`);
  return profile;
}

test('24 persist without a security token resets the profile (delete + recreate) so a stale token cannot survive (#920)', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E24_AK';
    const sk = 'E2E24_SK';
    const region = 'cn-north-4';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region }]);

    const out = await persistViaSwitch(ak, sk, region);
    assert.equal(out.status, 'ok');
    assert.equal(out.hcloud?.profileReset, true, 'persist without a token must walk the delete/recreate path');

    const calls = readHcloudCalls(join(dir, 'hcloud.log'));
    assertDeleteBeforeSet(calls);
    const deleteIdx = calls.findIndex((c) => c[0] === 'configure' && c[1] === 'delete');
    assert.ok(
      calls[deleteIdx]!.some((a) => String(a).startsWith('--cli-profile=')),
      'the delete must target the managed profile',
    );

    // END state (the fake implements configure delete/set against the real
    // config path): the recreated profile carries the new AK/SK and the
    // project-id the persist re-applies after the purge wiped every setting.
    const recreated = readFakeProfile(dir, 'deploy');
    assert.equal(recreated.accessKeyId, ak);
    assert.equal(recreated.projectId, 'proj-e2e-001', 'project-id is re-applied after the purge');
    assert.ok(!('securityToken' in recreated), 'no security token at rest');

    // The recreated profile keeps the credential stores consistent.
    const scan = scanState();
    assert.equal(scan.inconsistencies.length, 0);
  });
});

test('24b persist still succeeds when the profile to reset does not exist (delete is best-effort, #920)', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E24B_AK';
    const sk = 'E2E24B_SK';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region: 'cn-north-4' }]);
    // Simulate a KooCLI that reports "profile does not exist" on delete.
    process.env.HCLOUD_FAKE_DELETE_ERROR = '1';

    const out = await persistViaSwitch(ak, sk, 'cn-north-4');
    assert.equal(out.status, 'ok');
    assert.equal(out.hcloud?.ok, true, 'a missing profile on delete must not fail the persist');
    assert.equal(out.hcloud?.profileReset, true, '"not exist" on delete counts as nothing-to-clean');
  });
});

test('25 initial scenario: a preset profile with a stale/expired securityToken is reset by persist (#920)', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E25_AK';
    const sk = 'E2E25_SK';
    const region = 'cn-north-4';
    // Initial scenario: the preset profile already carries a stale/expired
    // securityToken. `configure set` refuses empty values, so the token can
    // never be overwritten in place — only the delete/recreate path removes it.
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region, securityToken: 'E2E25_STALE_TOKEN' },
    ]);

    const out = await persistViaSwitch(ak, sk, region);
    assert.equal(out.status, 'ok');
    assert.equal(
      out.hcloud?.profileReset,
      true,
      'persist must walk the delete/recreate path when the preset profile carries a stale token',
    );

    const calls = readHcloudCalls(join(dir, 'hcloud.log'));
    assertDeleteBeforeSet(calls);
    const setIdx = calls.findIndex((c) => c[0] === 'configure' && c[1] === 'set');
    assert.ok(
      calls[setIdx]!.every((a) => !String(a).startsWith('--cli-security-token=')),
      'the re-create must not pass a security token (no new token at rest)',
    );

    // END state: the preset profile's stale securityToken is GONE from the
    // on-disk config (the fake implements the delete/set effects), and the
    // project-id survives the purge via the persist's re-application.
    const recreated = readFakeProfile(dir, 'deploy');
    assert.ok(!('securityToken' in recreated), 'the stale securityToken is gone');
    assert.equal(recreated.projectId, 'proj-e2e-001', 'project-id is re-applied after the purge');

    // The recreated profile keeps the credential stores consistent.
    const scan = scanState();
    assert.equal(scan.inconsistencies.length, 0);
  });
});

// D4-24 (#745): auth_confirm returns the precise JSON contract for consumed
// and unknown tokens instead of throwing a generic Error string.
test('26 auth_confirm: same token submitted twice returns {status:ok, outcome:already_processed}', async () => {
  await withTempHome(async () => {
    writeGlobalCredentials({ ak: 'E2E26_A_AK', sk: 'E2E26_A_SK', region: 'cn-north-4' });
    const switched = (await callTool('huaweicloud_auth_switch', {
      mode: 'memory',
      action: 'persist',
      ak: 'E2E26_B_AK',
      sk: 'E2E26_B_SK',
      region: 'cn-north-4',
      vendorConfirmed: 'test: vendor established by the harness',
    })) as AuthSwitchResult;
    assert.equal(switched.status, 'needs_confirmation');

    const first = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: switched.confirmToken,
      decision: 's1',
    })) as { status: string; outcome: string };
    assert.equal(first.status, 'ok');
    assert.equal(first.outcome, 'aborted');

    const second = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: switched.confirmToken,
      decision: 's1',
    })) as { status: string; outcome: string };
    assert.equal(second.status, 'ok');
    assert.equal(second.outcome, 'already_processed');
  });
});

test("26b auth_confirm: unknown token returns {status:'rejected', code:'CONFIRM_TOKEN_NOT_FOUND'}", async () => {
  await withTempHome(async () => {
    const out = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: 'never-created-token',
      decision: 'newImported',
    })) as { status: string; code: string };
    assert.equal(out.status, 'rejected');
    assert.equal(out.code, 'CONFIRM_TOKEN_NOT_FOUND');
  });
});

// #919 follow-up UX: auth_status exposes the credential panel (temporary STS
// vs permanent S1, and which one is active).
test('27 auth_status exposes credentialPanel with sts/s1/activeSource', async () => {
  await withTempHome(async () => {
    // No STS anywhere → panel reports S1-absent, activeSource none.
    const bare = getAuthStatus('all');
    assert.equal(bare.credentialPanel.s1.configured, false);
    assert.equal(bare.credentialPanel.activeSource, 'none');
    assert.equal(bare.stsExpiry, null);

    // Permanent S1 → s1 configured with fingerprint, activeSource s1-persistent.
    writeGlobalCredentials({ ak: 'E2E27_AK', sk: 'E2E27_SK', region: 'cn-north-4' });
    const withS1 = getAuthStatus('all');
    assert.equal(withS1.credentialPanel.s1.configured, true);
    assert.equal(withS1.credentialPanel.s1.fingerprint, fingerprint('E2E27_AK', 'E2E27_SK'));
    assert.equal(withS1.credentialPanel.s1.persistent, true);
    assert.equal(withS1.credentialPanel.activeSource, 's1-persistent');

    // Runtime temporary STS (unexpired) → panel's sts half populated and active.
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = Buffer.from(JSON.stringify({ exp: future })).toString('base64url');
    setRuntimeCredentials('E2E27_RT_AK', 'E2E27_RT_SK', token, 'cn-north-4');
    const withSts = getAuthStatus('all');
    assert.equal(typeof withSts.stsExpiry?.status, 'string');
    assert.equal(withSts.credentialPanel.activeSource, 'temporary-sts');
    clearRuntimeCredentials();
  });
});
