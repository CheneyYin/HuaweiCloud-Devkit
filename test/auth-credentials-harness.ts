// The env-isolation harness for the auth credential tests, extracted from
// auth-credentials.test.ts: CodeArts project/home isolation and the shared
// temp-home env snapshot/restore.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  backupGlobalCredentials,
  clearRuntimeCredentials,
  getParentCwd,
  globalCredentialsPath,
  isCodeArtsContext,
  obsConfigPath,
  parseStsExpiry,
  pickDevkitMcpServer,
  readGlobalCredentials,
  readLastSync,
  resolveCredentials,
  resolveCredentialsWithRuntime,
  restoreGlobalCredentialsBackup,
  setRuntimeCredentials,
  writeGlobalCredentials,
  writeLastSync,
  writeObsConfig,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { getAgentRegistrationStatuses } from '../plugins/huaweicloud-core/src/auth/agent-registration.ts';
import { getAuthStatus, syncAuth, computeOnboarding } from '../plugins/huaweicloud-core/src/auth/service.ts';
import { buildOnboardingSteps } from '../plugins/huaweicloud-core/src/auth/error-table.ts';

export const isWin = process.platform === 'win32';

export const FAKE_HCLOUD = fileURLToPath(new URL('./fixtures/fake-hcloud.ts', import.meta.url));

// CodeArts project isolation. isCodeArtsContext() detects CodeArts by a
// .codeartsdoer marker under process.cwd(), and readCodeArtsCredentials()
// searches CODEARTS_PROJECT_DIR / parent cwd / cwd / homedir — so a test
// writing the marker into the repo root leaks it into every parallel test
// process (cred-reconcile-e2e "clear" then resolves CodeArts creds instead of
// throwing). These tests run from a temp project dir with CODEARTS_PROJECT_DIR
// pointing at it, which exercises the same lookup without the shared-state
// leak.
export function withCodeArtsProject(fn: (projectDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-codearts-'));
  const prevCwd = process.cwd();
  const prevProjectDir = process.env.CODEARTS_PROJECT_DIR;
  process.env.CODEARTS_PROJECT_DIR = dir;
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(prevCwd);
    if (prevProjectDir === undefined) delete process.env.CODEARTS_PROJECT_DIR;
    else process.env.CODEARTS_PROJECT_DIR = prevProjectDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Home-marker isolation for the ~/.codearts and ~/.codeartswork layout tests.
// The CodeArts markers live under os.homedir(), which every parallel test
// process shares — writing them into the real home makes isCodeArtsContext()
// true everywhere for the write window, and readCodeArtsCredentials() then
// resolves the injected S4 credentials in unrelated tests (cred-reconcile-e2e
// "clear", hcloud-cli "no STS injection"). os.homedir() reads $HOME at call
// time on POSIX and $USERPROFILE on Windows, so BOTH must be redirected or
// the isolation is a no-op on Windows (every sibling spawned-CLI test mirrors
// the same trio).
export function withCodeArtsHome(fn: (home: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-codearts-home-'));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.HOMEDRIVE = dir.slice(0, 2);
  process.env.HOMEPATH = dir.slice(2);
  try {
    return fn(dir);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

export function withTempHome(fn: (home: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-auth-'));
  const previous = {
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HCLOUD_CONFIG_PATH: process.env.HCLOUD_CONFIG_PATH,
    HCLOUD_OBS_CONFIG_PATH: process.env.HCLOUD_OBS_CONFIG_PATH,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
    HW_REGION: process.env.HW_REGION,
    HUAWEICLOUD_REGION: process.env.HUAWEICLOUD_REGION,
    DSH_HOME: process.env.DSH_HOME,
    HCLOUD_BIN: process.env.HCLOUD_BIN,
    HCLOUD_BIN_ARGS_JSON: process.env.HCLOUD_BIN_ARGS_JSON,
    HCLOUD_FAKE_LOG: process.env.HCLOUD_FAKE_LOG,
  };
  process.env.HUAWEICLOUD_HOME = dir;
  process.env.HCLOUD_CONFIG_PATH = join(dir, '.hcloud', 'config.json');
  process.env.HCLOUD_OBS_CONFIG_PATH = join(dir, '.obsutilconfig');
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  delete process.env.HW_REGION;
  delete process.env.HUAWEICLOUD_REGION;
  delete process.env.DSH_HOME;
  delete process.env.HCLOUD_BIN;
  delete process.env.HCLOUD_BIN_ARGS_JSON;
  delete process.env.HCLOUD_FAKE_LOG;
  try {
    return fn(dir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
