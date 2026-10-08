import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DEPENDENCIES } from '../plugins/huaweicloud-core/src/lib/dependency-model.ts';
import { resolveDependencyCommand } from '../plugins/huaweicloud-core/src/lib/dep-resolve.ts';
import { provisionDependencies } from '../plugins/huaweicloud-core/src/dep-provision.ts';
import { findHcloudBin } from '../plugins/huaweicloud-core/src/hcloud-probe.ts';

// Unit 2 (provision half) contracts, driven through the public functions and
// the real CLI: the resolution chain's tier order, the provisioning policy
// loop (with the installer/probe/resolution seams faked — no network, no
// real installs), the dep CLI surface, and findHcloudBin's delegation.

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const isWin = process.platform === 'win32';
const exeSuffix = isWin ? '.exe' : '';

const gatewayResolution = DEPENDENCIES['open-mcp-gateway'].resolution;

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dep-provision-home-'));
}

function writeExecutable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, isWin ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
  if (!isWin) chmodSync(path, 0o755);
}

// eslint's no-control-regex flags the \x1b escape, but stripping ANSI color
// codes is exactly what this helper exists for.
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI_COLOR, '');

function collector(): { lines: string[]; text(): string; log(_line: string): void } {
  const lines: string[] = [];
  return {
    lines,
    log: (line: string) => lines.push(line),
    text: () => stripAnsi(lines.join('\n')),
  };
}

// ---- dep-resolve: the one resolution chain, tier order pinned ----

test('dep-resolve: OPENMCP_BIN pointing at an existing file wins (env tier)', () => {
  const home = tempHome();
  const fixture = join(home, `gateway${exeSuffix}`);
  writeExecutable(fixture);
  const resolved = resolveDependencyCommand(gatewayResolution, {
    OPENMCP_BIN: fixture,
    HOME: '/nonexistent',
    PATH: '/usr/bin',
  });
  assert.deepEqual(resolved, { command: fixture, argsPrefix: [], tier: 'env' });
});

test('dep-resolve: a missing envBin falls through to the platform candidates', () => {
  const home = tempHome();
  const candidate = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(candidate);
  const resolved = resolveDependencyCommand(gatewayResolution, {
    OPENMCP_BIN: join(home, 'does-not-exist'),
    HOME: home,
    PATH: '/usr/bin',
  });
  assert.deepEqual(resolved, { command: candidate, argsPrefix: [], tier: 'candidate' });
});

test('dep-resolve: a persistent install under a fake HOME resolves as candidate', () => {
  const home = tempHome();
  const candidate = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(candidate);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: '/usr/bin' });
  assert.deepEqual(resolved, { command: candidate, argsPrefix: [], tier: 'candidate' });
});

test('dep-resolve: a PATH hit resolves as the path tier', { skip: isWin }, () => {
  const home = tempHome();
  const stubDir = mkdtempSync(join(tmpdir(), 'dep-provision-bin-'));
  const stub = join(stubDir, 'huaweicloud-open-mcp');
  writeExecutable(stub);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: `/usr/bin${delimiter}${stubDir}` });
  assert.deepEqual(resolved, { command: stub, argsPrefix: [], tier: 'path' });
});

test('dep-resolve: uvx resolves as the fallback tier with the package argsPrefix', { skip: isWin }, () => {
  const home = tempHome();
  const stubDir = mkdtempSync(join(tmpdir(), 'dep-provision-uvx-'));
  const uvx = join(stubDir, 'uvx');
  writeExecutable(uvx);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: `/usr/bin${delimiter}${stubDir}` });
  assert.deepEqual(resolved, { command: uvx, argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' });
});

test('dep-resolve: the fallback command is probed in ~/.local/bin before PATH', () => {
  const home = tempHome();
  const localUvx = join(home, '.local', 'bin', `uvx${exeSuffix}`);
  writeExecutable(localUvx);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: '/usr/bin' });
  assert.deepEqual(resolved, { command: localUvx, argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' });
});

test('dep-resolve: nothing anywhere resolves to null', () => {
  const home = tempHome();
  const emptyPath = mkdtempSync(join(tmpdir(), 'dep-provision-empty-'));
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: emptyPath });
  assert.equal(resolved, null);
});

// ---- provisionDependencies: the policy loop, seams faked ----

test('provisioning: hcloud absent in a non-TTY session prints the manual command, never installs', async () => {
  const out = collector();
  let installerCalls = 0;
  await provisionDependencies(['hcloud'], {
    tty: false,
    log: out.log,
    probeHcloud: () => ({ status: 'not_found', installed: false }),
    installKooCli: async () => {
      installerCalls += 1;
      return true;
    },
  });
  assert.equal(installerCalls, 0, 'non-TTY must not start a download');
  assert.match(out.text(), /hcloud: not found; auto-install needs an interactive session/);
  assert.match(
    out.text(),
    isWin
      ? /Manual: download .*huaweicloud-cli-windows-amd64\.zip/
      : /curl -LO ".*huaweicloud-cli-linux-(amd64|arm64)\.tar\.gz"/,
  );
});

test('provisioning: hcloud present skips with an INFO line, no installer call', async () => {
  const out = collector();
  let installerCalls = 0;
  await provisionDependencies(['hcloud'], {
    log: out.log,
    probeHcloud: () => ({ status: 'ok', installed: true, installedVersion: '7.2.12' }),
    installKooCli: async () => {
      installerCalls += 1;
      return true;
    },
  });
  assert.equal(installerCalls, 0);
  assert.match(out.text(), /hcloud: present \(7\.2\.12\), skipping install/);
});

test('provisioning: a version mismatch still counts as present (doctor owns that warning)', async () => {
  const out = collector();
  await provisionDependencies(['hcloud'], {
    log: out.log,
    probeHcloud: () => ({ status: 'version_mismatch', installed: true, installedVersion: '7.0.0' }),
  });
  assert.match(out.text(), /hcloud: present \(7\.0\.0\), skipping install/);
});

test('provisioning: a persistent gateway tier skips silently — no prompt fires', async () => {
  const out = collector();
  const calls = { confirm: 0, installGateway: 0 };
  await provisionDependencies(['open-mcp-gateway'], {
    log: out.log,
    resolveDependency: () => ({ command: '/opt/huaweicloud-open-mcp', argsPrefix: [], tier: 'path' }),
    confirm: async () => {
      calls.confirm += 1;
      return true;
    },
    installGateway: async () => {
      calls.installGateway += 1;
      return { ok: true, tier: 'uv' };
    },
  });
  assert.equal(calls.confirm, 0, 'a persistent install must not prompt');
  assert.equal(calls.installGateway, 0);
  assert.match(out.text(), /open-mcp-gateway: present \(path: \/opt\/huaweicloud-open-mcp\)/);
});

test('provisioning: a fallback-tier gateway in a non-TTY session prints the install hint', async () => {
  const out = collector();
  const calls = { confirm: 0, installGateway: 0 };
  await provisionDependencies(['open-mcp-gateway'], {
    tty: false,
    log: out.log,
    resolveDependency: () => ({ command: '/usr/bin/uvx', argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' }),
    confirm: async () => {
      calls.confirm += 1;
      return true;
    },
    installGateway: async () => {
      calls.installGateway += 1;
      return { ok: true, tier: 'uv' };
    },
  });
  assert.equal(calls.confirm, 0);
  assert.equal(calls.installGateway, 0);
  assert.match(out.text(), /open-mcp-gateway: running via uvx \(no persistent install\)/);
  assert.match(out.text(), /dep install open-mcp-gateway/);
});

test('provisioning: an unresolvable gateway in a non-TTY session prints the install hint', async () => {
  const out = collector();
  await provisionDependencies(['open-mcp-gateway'], {
    tty: false,
    log: out.log,
    resolveDependency: () => null,
  });
  assert.match(out.text(), /open-mcp-gateway: not found\./);
  assert.match(out.text(), /dep install open-mcp-gateway/);
});

test('provisioning: a fallback-tier gateway in a TTY session prompts, then installs once on y', async () => {
  const out = collector();
  const calls = { installGateway: 0 };
  const prompts: string[] = [];
  await provisionDependencies(['open-mcp-gateway'], {
    tty: true,
    log: out.log,
    resolveDependency: () => ({ command: '/usr/bin/uvx', argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' }),
    confirm: async (prompt) => {
      prompts.push(prompt);
      return true;
    },
    installGateway: async () => {
      calls.installGateway += 1;
      return { ok: true, tier: 'uv' };
    },
  });
  assert.equal(calls.installGateway, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Install the Open MCP Gateway persistently/);
  assert.match(out.text(), /open-mcp-gateway: installed via uv/);
});

test('provisioning: a declined prompt leaves the pack usable and prints the hint', async () => {
  const out = collector();
  const calls = { installGateway: 0 };
  await provisionDependencies(['open-mcp-gateway'], {
    tty: true,
    log: out.log,
    resolveDependency: () => ({ command: '/usr/bin/uvx', argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' }),
    confirm: async () => false,
    installGateway: async () => {
      calls.installGateway += 1;
      return { ok: true, tier: 'uv' };
    },
  });
  assert.equal(calls.installGateway, 0);
  assert.match(out.text(), /open-mcp-gateway: skipped\./);
  assert.match(out.text(), /uvx needs no install/);
});

test('provisioning: devbridge is one INFO line and invokes nothing', async () => {
  const out = collector();
  const calls = { probe: 0, installKooCli: 0, resolve: 0, installGateway: 0, confirm: 0 };
  await provisionDependencies(['devbridge'], {
    tty: true,
    log: out.log,
    probeHcloud: () => {
      calls.probe += 1;
      return { status: 'not_found', installed: false };
    },
    installKooCli: async () => {
      calls.installKooCli += 1;
      return true;
    },
    resolveDependency: () => {
      calls.resolve += 1;
      return null;
    },
    installGateway: async () => {
      calls.installGateway += 1;
      return { ok: true, tier: 'uv' };
    },
    confirm: async () => {
      calls.confirm += 1;
      return true;
    },
  });
  assert.deepEqual(calls, { probe: 0, installKooCli: 0, resolve: 0, installGateway: 0, confirm: 0 });
  assert.match(out.text(), /devbridge: sandbox-resident \(lives inside the cloud sandbox; the host never manages it\)/);
});

test('provisioning: a failing dependency is isolated and reported, the loop continues', async () => {
  const out = collector();
  await provisionDependencies(['hcloud', 'devbridge'], {
    log: out.log,
    probeHcloud: () => {
      throw new Error('probe exploded');
    },
  });
  assert.match(out.text(), /hcloud: provisioning failed: probe exploded/);
  assert.match(out.text(), /devbridge: sandbox-resident/);
});

// ---- dep CLI: status/install parsing through the real bin ----

function runDep(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [setupCli, 'dep', ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('dep install with a bogus id errors and names the valid ids', () => {
  const res = runDep(['install', 'bogus']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Unknown dependency id: bogus/);
  assert.match(res.stderr, /Valid dependency ids: hcloud, open-mcp-gateway, devbridge/);
});

test('dep install without an id errors with the missing-id message', () => {
  const res = runDep(['install']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Unknown dependency id: \(missing\)/);
});

test('dep install devbridge refuses with the in-sandbox pointer', () => {
  const res = runDep(['install', 'devbridge']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /devbridge ships inside the cloud sandbox; the host never installs or removes it\./);
});

test('dep without a subcommand prints usage', () => {
  const res = runDep([]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Usage: npx huaweicloud-devkit dep <status \| install <id>>/);
});

test('dep status with nothing installed requires no binaries', () => {
  const home = tempHome();
  const emptyPath = mkdtempSync(join(tmpdir(), 'dep-provision-path-'));
  const res = runDep(['status'], {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    PATH: emptyPath,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Dependency status \(effective packs: 0\)/);
  assert.match(res.stdout, /No pack binaries required\./);
});

// ---- install/update wiring through the real installer ----

function runInstall(args: string[]): ReturnType<typeof spawnSync> {
  const home = tempHome();
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd: mkdtempSync(join(tmpdir(), 'dep-provision-cwd-')),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: home.slice(0, 2),
      HOMEPATH: home.slice(2),
      HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
    },
    encoding: 'utf8',
    timeout: 120000,
  });
}

test('install provisions pack binaries after the per-target loop', () => {
  const res = runInstall(['install', '--target', 'opencode']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Provisioning pack binaries \(enabled packs: \d+\)/);
  assert.match(res.stdout, /devbridge: sandbox-resident/);
});

test('install --skip-binaries suppresses the provisioning pass', () => {
  const res = runInstall(['install', '--target', 'opencode', '--skip-binaries']);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /Provisioning pack binaries/);
});

// ---- findHcloudBin: delegation equivalence, env-injected ----

test('findHcloudBin returns the HCLOUD_BIN fixture when the file exists', () => {
  const fixture = join(tempHome(), `hcloud${exeSuffix}`);
  writeExecutable(fixture);
  const saved = process.env.HCLOUD_BIN;
  process.env.HCLOUD_BIN = fixture;
  try {
    assert.equal(findHcloudBin(), fixture);
  } finally {
    if (saved === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = saved;
  }
});

test(
  'findHcloudBin returns null when nothing resolves',
  {
    // /usr/local/bin/hcloud is a legal candidate and cannot be faked via env:
    // a machine with a system-wide install would fail the null expectation.
    skip: isWin || existsSync('/usr/local/bin/hcloud'),
  },
  () => {
    const home = tempHome();
    const emptyPath = mkdtempSync(join(tmpdir(), 'dep-provision-path-'));
    const savedBin = process.env.HCLOUD_BIN;
    const savedHome = process.env.HOME;
    const savedPath = process.env.PATH;
    delete process.env.HCLOUD_BIN;
    process.env.HOME = home;
    process.env.PATH = emptyPath;
    try {
      assert.equal(findHcloudBin(), null);
    } finally {
      if (savedBin === undefined) delete process.env.HCLOUD_BIN;
      else process.env.HCLOUD_BIN = savedBin;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      process.env.PATH = savedPath;
    }
  },
);
