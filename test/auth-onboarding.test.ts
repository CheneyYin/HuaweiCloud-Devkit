import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  clearRuntimeCredentials,
  isCodeArtsContext,
  setRuntimeCredentials,
  resolveCredentials,
  writeGlobalCredentials,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { withCodeArtsHome, withTempHome } from './auth-credentials-harness.ts';
import { getAuthStatus, computeOnboarding } from '../plugins/huaweicloud-core/src/auth/service.ts';
import { buildOnboardingSteps } from '../plugins/huaweicloud-core/src/auth/error-table.ts';

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

test('43 getAuthStatus onboarding scenario1: S1 only, no env → use S1', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'OB_AK_1', sk: 'OB_SK_1', region: 'cn-north-4' });
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.scenario, 1);
    assert.equal(onboarding.reason, 's1-only');
    assert.equal(onboarding.needsSetup, true);
    assert.equal(onboarding.steps.length, 2);
    assert.equal(onboarding.steps[0].action, 'use-s1');
  });
});

test('44 getAuthStatus onboarding scenario2: conflict S1 vs env', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'OB_AK_2', sk: 'OB_SK_2', region: 'cn-north-4' });
    process.env.HW_ACCESS_KEY = 'OB_ENV_AK';
    process.env.HW_SECRET_KEY = 'OB_ENV_SK';
    // no token → env creds, not platform triplet → scenario 2 conflict
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.scenario, 2);
    assert.equal(onboarding.reason, 'conflict');
    assert.equal(onboarding.needsSetup, true);
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
  });
});

test('45 getAuthStatus onboarding scenario3: nothing configured → auth-init/import steps', () => {
  withTempHome(() => {
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.scenario, 3);
    assert.equal(onboarding.reason, 's1-missing');
    assert.equal(onboarding.needsSetup, true);
    assert.ok(onboarding.steps.length >= 2);
    assert.equal(onboarding.steps[0].action, 'obtain-aksk');
  });
});

test('46 getAuthStatus onboarding scenario4: no S1 but env creds present → import', () => {
  withTempHome(() => {
    process.env.HW_ACCESS_KEY = 'OB_ENV_AK';
    process.env.HW_SECRET_KEY = 'OB_ENV_SK';
    delete process.env.HW_SECURITY_TOKEN;
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.scenario, 4);
    assert.equal(onboarding.reason, 'import-injected');
    assert.equal(onboarding.needsSetup, true);
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
  });
});

test('47 getAuthStatus onboarding: platform triplet + no S1 → needsSetup=false', () => {
  withTempHome(() => {
    process.env.HW_ACCESS_KEY = 'OB_PLATFORM_AK';
    process.env.HW_SECRET_KEY = 'OB_PLATFORM_SK';
    process.env.HW_SECURITY_TOKEN = 'OB_PLATFORM_TOKEN';
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.needsSetup, false);
    assert.equal(onboarding.scenario, 0);
    assert.equal(onboarding.reason, 'platform-injected');
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;
  });
});

test('48 getAuthStatus onboarding runtime active → needsSetup=false, no leak', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    setRuntimeCredentials('OB_RT_AK', 'OB_RT_SK');
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.needsSetup, false);
    assert.equal(onboarding.scenario, 0);
    assert.equal(onboarding.reason, 'runtime-active');
    assert.equal(onboarding.accountHint, null);
    assert.doesNotMatch(JSON.stringify(onboarding), /OB_RT_AK|OB_RT_SK/);
    clearRuntimeCredentials();
  });
});

test('49 huaweicloud_auth_status onboarding does not leak AK (fingerprint only)', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'OB_SECRET_AK', sk: 'OB_SECRET_SK', region: 'cn-north-4' });
    const status = getAuthStatus('all');
    assert.doesNotMatch(JSON.stringify(status), /OB_SECRET_AK|OB_SECRET_SK/);
    assert.match(status.onboarding.accountHint ?? '', /^[0-9a-f]{8}$/);
  });
});

test('50 onboarding scenario1: S1 exists + platform triplet → use S1 (not s1-missing)', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'OB_S1_AK', sk: 'OB_S1_SK', region: 'cn-north-4' });
    process.env.HW_ACCESS_KEY = 'OB_PLATFORM_AK';
    process.env.HW_SECRET_KEY = 'OB_PLATFORM_SK';
    process.env.HW_SECURITY_TOKEN = 'OB_PLATFORM_TOKEN';
    const { onboarding } = getAuthStatus('all');
    assert.equal(onboarding.scenario, 1, JSON.stringify(onboarding));
    assert.equal(onboarding.needsSetup, true);
    assert.equal(onboarding.steps[0].action, 'use-s1');
    assert.notEqual(onboarding.reason, 's1-missing');
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;
  });
});

test('auth_status reports mcpSettingsConfigured and mcp-settings-injected onboarding', () => {
  withTempHome(() => {
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    delete process.env.HW_SECURITY_TOKEN;
    withCodeArtsHome((home) => {
      const workDir = join(home, '.codearts', 'mcp');
      mkdirSync(workDir, { recursive: true });
      writeFileSync(
        join(workDir, 'mcp_settings.json'),
        JSON.stringify({
          mcp: {
            'huaweicloud-devkit_1': {
              environment: { HW_ACCESS_KEY: 'S4_AK', HW_SECRET_KEY: 'S4_SK', HW_SECURITY_TOKEN: 'S4_TOKEN' },
            },
          },
        }),
        'utf8',
      );
      const status = getAuthStatus('all');
      assert.equal(status.credentialsConfigured, false);
      assert.equal(status.mcpSettingsConfigured, true);
      assert.equal(status.onboarding.reason, 'mcp-settings-injected');
      assert.equal(status.onboarding.needsSetup, false);
    });
  });
});

test('#900: failure-path onboarding steps come from the shared guidance builder (scenario 3)', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    const thrown = resolveCredentialsThrowing();
    assert.equal(thrown.code, 'HDKIT_CRED_MISSING');
    assert.ok(thrown.onboarding);
    assert.equal(thrown.onboarding.scenario, 3);
    // THE guard: same steps as the pure builder. The codearts flag is derived
    // from the same context detector the failure path uses.
    assert.deepEqual(
      thrown.onboarding.steps,
      buildOnboardingSteps(3, { codearts: isCodeArtsContext() }),
      'failure path must use the single steps builder',
    );
  });
});

test('#900: failure-path error carries unified shape (messageZh Chinese + executable action)', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    const thrown = resolveCredentialsThrowing();
    assert.equal(thrown.code, 'HDKIT_CRED_MISSING');
    assert.match(thrown.message, /[\u4e00-\u9fff]/, 'top-level message must be Chinese');
    assert.ok(!/Huawei Cloud credentials are not configured/.test(thrown.message));
    assert.equal(thrown.messageZh, thrown.message);
    assert.equal(thrown.action, 'npx huaweicloud-devkit auth init');
    assert.equal(thrown.nextStep, thrown.action);
  });
});

// #900 cross-path drift guard — both paths consume the same builder
// (buildOnboardingSteps in error-table.ts): the failure path inside
// resolveCredentials and the status path inside computeOnboarding. This was
// the exact drift #900 reported (the status path hand-built a different step
// vocabulary than the failure path); the deepEqual below asserts they stay
// identical.

test('#900: failure-path steps equal status-path steps for scenario 3 (same source)', () => {
  withTempHome(() => {
    clearRuntimeCredentials();
    const thrown = resolveCredentialsThrowing();
    assert.equal(thrown.code, 'HDKIT_CRED_MISSING');
    const status = computeOnboarding({ credentials: null, reconciled: { hasRuntime: false } });
    assert.equal(status.scenario, 3);
    assert.deepEqual(thrown.onboarding?.steps, status.steps, 'failure path and status path must be identical');
  });
});

// The codearts axis of the #900 drift guard: both paths must select the SAME
// builder variant when the CodeArts marker dir exists — a regression that
// pins codearts:false on either path passes the plain-env drift test above.

test('#900: failure-path steps equal status-path steps for scenario 3 in CodeArts context', () => {
  withCodeArtsHome((artsHome) => {
    mkdirSync(join(artsHome, '.codeartsdoer'), { recursive: true });
    withTempHome(() => {
      clearRuntimeCredentials();
      assert.equal(isCodeArtsContext(), true, 'precondition: the marker dir must select the codearts variant');
      const thrown = resolveCredentialsThrowing();
      assert.equal(thrown.code, 'HDKIT_CRED_MISSING');
      assert.equal(thrown.onboarding?.scenario, 3);
      const status = computeOnboarding({ credentials: null, reconciled: { hasRuntime: false } });
      assert.equal(status.scenario, 3);
      assert.deepEqual(thrown.onboarding?.steps, status.steps, 'codearts variants must stay identical too');
      // And the variant is genuinely the codearts one (write-import present).
      assert.ok(thrown.onboarding?.steps.some((s) => (s as { action?: string }).action === 'write-import'));
    });
  });
});
