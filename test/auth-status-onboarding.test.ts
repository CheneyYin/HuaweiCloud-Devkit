import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import {
  backupGlobalCredentials,
  resolveCredentials,
  globalCredentialsPath,
  obsConfigPath,
  readGlobalCredentials,
  readLastSync,
  restoreGlobalCredentialsBackup,
  writeGlobalCredentials,
  writeLastSync,
  writeObsConfig,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { FAKE_HCLOUD, withTempHome } from './auth-credentials-harness.ts';
import { getAuthStatus, syncAuth } from '../plugins/huaweicloud-core/src/auth/service.ts';

interface ThrownCredentialError extends Error {
  code?: string;
  messageZh?: string;
  action?: string;
  nextStep?: string;
  onboarding?: { scenario: number; reason: string; message: string; steps: unknown[] };
}

function resolveCredentialsThrowing(): ThrownCredentialError {
  try {
    resolveCredentials();
  } catch (error) {
    return error as ThrownCredentialError;
  }
  throw new Error('expected resolveCredentials to throw HDKIT_CRED_MISSING');
}

test('global credentials round-trip with secure file path', () => {
  withTempHome((home) => {
    const path = writeGlobalCredentials({ ak: 'AK123', sk: 'SK456', region: 'cn-north-4' });
    assert.equal(path, globalCredentialsPath());
    assert.equal(readGlobalCredentials()?.ak, 'AK123');
    assert.equal(readGlobalCredentials()?.sk, 'SK456');
    assert.equal(readGlobalCredentials()?.region, 'cn-north-4');
    assert.ok(globalCredentialsPath().startsWith(home));
  });
});

test('writeObsConfig creates obsutilconfig content from vault', () => {
  withTempHome(() => {
    const result = writeObsConfig({ ak: 'OBS_AK', sk: 'OBS_SK', region: 'cn-north-4' });
    assert.equal(result.endpoint, 'https://obs.cn-north-4.myhuaweicloud.com');
    const content = readFileSync(obsConfigPath(), 'utf8');
    assert.match(content, /ak=OBS_AK/);
    assert.match(content, /sk=OBS_SK/);
    assert.match(content, /endpoint=https:\/\/obs\.cn-north-4\.myhuaweicloud\.com/);
  });
});

test('auth sync writes OBS and reports all agent registration targets', () => {
  withTempHome((home) => {
    process.env.HCLOUD_BIN = process.execPath;
    process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([FAKE_HCLOUD]);
    process.env.HCLOUD_FAKE_LOG = join(home, 'hcloud.log');
    mkdirSync(join(home, '.hcloud'), { recursive: true });
    writeFileSync(
      join(home, '.hcloud', 'config.json'),
      JSON.stringify({
        current: 'deploy',
        profiles: [
          { name: 'deploy', accessKeyId: 'SYNC_OLD_AK', secretAccessKey: 'SYNC_OLD_SK', region: 'cn-north-4' },
        ],
      }),
      'utf8',
    );
    writeGlobalCredentials({ ak: 'SYNC_AK', sk: 'SYNC_SK', region: 'cn-north-4' });
    const sync = syncAuth('all');
    assert.equal(sync.ok, true);
    assert.equal(sync.profile, 'deploy');
    assert.equal(sync.obs.configured, true);
    assert.ok(sync.agents.opencode !== undefined);
    assert.ok(sync.agents.codex !== undefined);
    assert.ok(sync.agents['codex-desktop'] !== undefined);
    assert.ok(sync.agents.codearts !== undefined);
    assert.ok(sync.agents['codearts-work'] !== undefined);
    assert.ok(sync.agents.workbuddy !== undefined);
    assert.ok(sync.agents.dsh !== undefined);
  });
});

test('auth status is redacted and reflects vault/OBS state', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'STATUS_AK', sk: 'STATUS_SK', region: 'cn-north-4' });
    writeObsConfig({ ak: 'STATUS_AK', sk: 'STATUS_SK', region: 'cn-north-4' });
    const status = getAuthStatus('all');
    assert.equal(status.credentialsConfigured, true);
    assert.equal(status.obsConfigured, true);
    assert.ok(status.agents.opencode !== undefined);
    assert.ok(status.agents.dsh !== undefined);
    assert.doesNotMatch(JSON.stringify(status), /STATUS_AK|STATUS_SK/);
  });
});

test('last_sync write/read round-trip', () => {
  withTempHome((_home) => {
    assert.equal(readLastSync(), null);
    writeLastSync({ kooCliProfile: 'deploy', s1Fingerprint: 'fp123456' });
    const sync = readLastSync();
    assert.ok(sync && typeof sync.ts === 'number');
    assert.equal(sync.kooCliProfile, 'deploy');
    assert.equal(sync.s1Fingerprint, 'fp123456');
    assert.ok(Date.now() - sync.ts < 5000);
  });
});

test('last_sync old timestamp-only format remains readable', () => {
  withTempHome((_home) => {
    mkdirSync(join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud'), { recursive: true });
    writeFileSync(join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', '.last_sync'), '{"ts":12345}', 'utf8');
    assert.deepEqual(readLastSync(), { ts: 12345 });
  });
});

test('writeGlobalCredentials persists configuredBySession flag', () => {
  withTempHome((_home) => {
    writeGlobalCredentials({ ak: 'AK1', sk: 'SK1', configuredBySession: true });
    assert.equal(readGlobalCredentials()!.configuredBySession, true);
    writeGlobalCredentials({ ak: 'AK1', sk: 'SK1' });
    assert.equal(readGlobalCredentials()!.configuredBySession, undefined);
  });
});

test('getAuthStatus reports reconciliation inconsistencies', () => {
  withTempHome((_home) => {
    writeGlobalCredentials({ ak: 'AK1', sk: 'SK1', region: 'cn-north-4' });
    const status = getAuthStatus('all');
    assert.ok('reconciled' in status);
    assert.equal(typeof status.reconciled.inconsistent, 'boolean');
    assert.equal(status.reconciled.runtimeActive, false);
  });
});

test('backup and restore global credentials', () => {
  withTempHome((_home) => {
    writeGlobalCredentials({ ak: 'AK_ORIG', sk: 'SK_ORIG', region: 'cn-north-4' });
    const bak = backupGlobalCredentials();
    assert.ok(bak && bak.endsWith('credentials.json.bak'));
    writeGlobalCredentials({ ak: 'AK_NEW', sk: 'SK_NEW' });
    assert.equal(readGlobalCredentials()?.ak, 'AK_NEW');
    assert.equal(restoreGlobalCredentialsBackup(), true);
    assert.equal(readGlobalCredentials()?.ak, 'AK_ORIG');
  });
});
