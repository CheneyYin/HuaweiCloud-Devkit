import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import {
  provisionDependencies,
  uninstallDependency,
  uninstallPlacedDependency,
} from '../plugins/huaweicloud-core/src/dep/provision.ts';
import {
  cannotStageEacces,
  collector,
  emptyPathEnv,
  exeSuffix,
  gatewayReceiptWithTier,
  hcloudReceiptAt,
  noTargets,
  runDep,
  runInstall,
  runSetupCli,
  tempHome,
  writeExecutable,
} from './dep-provision-harness.ts';
import { readReceipt, writeReceipt } from '../plugins/huaweicloud-core/src/dep/receipts.ts';
import type { DepUninstallTargets } from '../plugins/huaweicloud-core/src/dep/provision.ts';
import type { PackId } from '../plugins/huaweicloud-core/src/lib/pack-types.ts';

test('provisioning: hcloud present skips with an INFO line, no installer call', async () => {
  const out = collector();
  let installerCalls = 0;
  await provisionDependencies(['hcloud'], {
    log: out.log,
    probeHcloud: () => ({ status: 'ok', installed: true, installedVersion: '7.3.12' }),
    installKooCli: async () => {
      installerCalls += 1;
      return true;
    },
  });
  assert.equal(installerCalls, 0);
  assert.match(out.text(), /hcloud: present \(7\.3\.12\), skipping install/);
});

test('provisioning: a version mismatch still counts as present (doctor owns that warning)', async () => {
  const out = collector();
  await provisionDependencies(['hcloud'], {
    log: out.log,
    probeHcloud: () => ({ status: 'version_mismatch', installed: true, installedVersion: '7.0.0' }),
  });
  assert.match(out.text(), /hcloud: present \(7\.0\.0\), skipping install/);
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

test('uninstall hcloud with a receipt deletes exactly the receipt path', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  const placed = join(home, '.local', 'bin', 'hcloud');
  const userOwned = join(home, 'usr-local', 'hcloud');
  writeExecutable(placed);
  writeExecutable(userOwned);
  writeReceipt(hcloudReceiptAt(placed), dir);
  const result = uninstallDependency(
    'hcloud',
    noTargets,
    // A second hcloud resolves elsewhere; the receipt's path is the only
    // file devkit may touch.
    { receiptsDir: dir, env: { ...emptyPathEnv(home), HCLOUD_BIN: userOwned } },
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(existsSync(placed), false, 'the devkit-placed binary is removed');
  assert.equal(existsSync(userOwned), true, 'a binary outside the receipt path is untouched');
  assert.equal(readReceipt('hcloud', dir), null, 'the receipt is removed with the binary');
  assert.ok(result.message.includes(`Removed the devkit-installed hcloud binary: ${placed}`), result.message);
  assert.match(result.detail?.[0] ?? '', /~\/\.hcloud credentials and config were not touched/);
});

test('uninstall hcloud when the receipt path is already gone clears the stale receipt', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  writeReceipt(hcloudReceiptAt(join(home, '.local', 'bin', 'hcloud')), dir);
  const result = uninstallDependency('hcloud', noTargets, { receiptsDir: dir, env: emptyPathEnv(home) });
  assert.equal(result.ok, true);
  assert.match(result.message, /hcloud was already gone/);
  assert.match(result.message, /removed the stale receipt/);
  assert.equal(readReceipt('hcloud', dir), null);
});

test(
  'uninstall hcloud escalates to sudo -n rm through the runCommand seam when rmSync fails',
  { skip: cannotStageEacces },
  () => {
    const home = tempHome();
    const dir = join(home, 'deps');
    // The receipt path must be a known installer landing site before sudo is
    // allowed near it: ~/.local/bin/hcloud is the catalog's first unix
    // candidate. The directory is made non-writable so rmSync fails EACCES,
    // exactly how a permissions-restricted install location behaves.
    const placed = join(home, '.local', 'bin', 'hcloud');
    writeExecutable(placed);
    writeReceipt(hcloudReceiptAt(placed), dir);
    chmodSync(join(home, '.local', 'bin'), 0o555);
    try {
      const calls: Array<{ command: string; args: readonly string[] }> = [];
      const result = uninstallDependency('hcloud', noTargets, {
        receiptsDir: dir,
        env: emptyPathEnv(home),
        runCommand: (command, args) => {
          calls.push({ command, args });
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(calls, [{ command: 'sudo', args: ['-n', 'rm', placed] }]);
      assert.ok(
        result.message.includes(`Removed the devkit-installed hcloud binary: ${placed} (via sudo -n rm)`),
        result.message,
      );
      assert.equal(readReceipt('hcloud', dir), null, 'the receipt is cleared once sudo withdraws the binary');
    } finally {
      chmodSync(join(home, '.local', 'bin'), 0o755);
    }
  },
);

test(
  'uninstall hcloud reports the manual sudo rm line when sudo -n cannot withdraw the binary',
  { skip: cannotStageEacces },
  () => {
    const home = tempHome();
    const dir = join(home, 'deps');
    const placed = join(home, '.local', 'bin', 'hcloud');
    writeExecutable(placed);
    writeReceipt(hcloudReceiptAt(placed), dir);
    chmodSync(join(home, '.local', 'bin'), 0o555);
    try {
      const result = uninstallDependency('hcloud', noTargets, {
        receiptsDir: dir,
        env: emptyPathEnv(home),
        runCommand: () => ({ status: 1, stdout: '', stderr: 'sudo: a password is required' }),
      });
      assert.equal(result.ok, false);
      assert.ok(result.message.includes(`Failed to remove ${placed}:`), result.message);
      assert.ok(
        result.message.includes(
          `Remove it manually (sudo rm ${placed}), then re-run dep uninstall hcloud to clear the receipt.`,
        ),
        result.message,
      );
      assert.equal(existsSync(placed), true, 'the binary is left in place');
      assert.ok(readReceipt('hcloud', dir), 'the receipt stays until the user resolves the standoff');
    } finally {
      chmodSync(join(home, '.local', 'bin'), 0o755);
    }
  },
);

test('uninstall hcloud with a pathless receipt never deletes the user\u2019s HCLOUD_BIN override', () => {
  const dir = fixtureDir('dep-uninstall-');
  const userOwned = join(dir, 'my-hcloud');
  writeExecutable(userOwned);
  writeReceipt({ binary: 'hcloud', provisioner: 'devkit', installedAt: '2026-10-08T00:00:00.000Z' }, dir);
  const result = uninstallDependency('hcloud', noTargets, {
    receiptsDir: dir,
    env: { ...emptyPathEnv(dir), HCLOUD_BIN: userOwned },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /user's HCLOUD_BIN override/);
  assert.equal(existsSync(userOwned), true);
  assert.ok(readReceipt('hcloud', dir), 'the receipt stays until the user resolves the standoff');
});

test('the forced uninstall shape skips the pack-requirement gate the gated shape enforces', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  writeReceipt(gatewayReceiptWithTier('uv'), dir);
  writeExecutable(join(home, '.local', 'bin', `uv${exeSuffix}`));
  const requiring: DepUninstallTargets = {
    enabledPacks: new Set<PackId>(['huaweicloud-open-mcp']),
    carriers: [{ label: 'OpenCode', packs: new Set<PackId>(['huaweicloud-open-mcp']) }],
  };
  const gated = uninstallDependency('open-mcp-gateway', requiring, {
    receiptsDir: dir,
    env: emptyPathEnv(home),
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(gated.ok, false);
  assert.match(gated.message, /required by enabled pack\(s\) huaweicloud-open-mcp/);
  assert.ok(readReceipt('open-mcp-gateway', dir), 'the gated refusal keeps the receipt');
  const forced = uninstallPlacedDependency('open-mcp-gateway', {
    receiptsDir: dir,
    env: emptyPathEnv(home),
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(forced.ok, true, forced.message);
  assert.equal(readReceipt('open-mcp-gateway', dir), null, 'the forced shape clears the receipt');
});

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

test('install provisions pack binaries after the per-target loop', () => {
  const res = runInstall(['install', '--target', 'opencode']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Provisioning pack binaries \(enabled packs: \d+\)/);
  assert.match(res.stdout, /devbridge: sandbox-resident/);
});

test('dep uninstall with a bogus id errors and names the valid ids', () => {
  const res = runDep(['uninstall', 'bogus']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Unknown dependency id: bogus/);
  assert.match(res.stderr, /Valid dependency ids: hcloud, open-mcp-gateway, devbridge/);
});

test('dep uninstall hcloud with a receipt removes exactly the placed binary', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  const placed = join(home, '.local', 'bin', 'hcloud');
  writeExecutable(placed);
  writeReceipt(hcloudReceiptAt(placed), join(home, '.config', 'huaweicloud', 'deps'));
  const res = runSetupCli(['dep', 'uninstall', 'hcloud'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes(`Removed the devkit-installed hcloud binary: ${placed}`), res.stdout);
  assert.match(res.stdout, /~\/\.hcloud credentials and config were not touched/);
  assert.equal(existsSync(placed), false);
  assert.equal(readReceipt('hcloud', join(home, '.config', 'huaweicloud', 'deps')), null);
});

test('uninstall --clean-kocli clears the devkit hcloud receipt with the binary', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  const placed = join(home, '.local', 'bin', 'hcloud');
  writeExecutable(placed);
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  writeReceipt(hcloudReceiptAt(placed), depsDir);
  const res = runSetupCli(['uninstall', '--target', 'all', '--clean-kocli'], home, {
    PATH: emptyPath,
    HUAWEICLOUD_HOME: home,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes(`KooCLI removed: ${placed}`), res.stdout);
  assert.ok(res.stdout.includes('Cleared the devkit hcloud install receipt.'), res.stdout);
  assert.equal(existsSync(placed), false, 'the binary is removed');
  assert.equal(readReceipt('hcloud', depsDir), null, 'the receipt does not outlive the binary');
});

test('uninstall --clean-kocli keeps the receipt when the attributed binary survives the pass', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  // The macOS shape: the receipt names /usr/local/bin/hcloud, which
  // removeKooCli never touches (it only removes ~/.local/bin/hcloud,
  // ~/hcloud/hcloud[.exe], and ~/.hcloud). Burning the receipt here would
  // defeat `dep uninstall hcloud` forever while the binary lives.
  const placed = join(home, 'usr-local', 'hcloud');
  writeExecutable(placed);
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  writeReceipt(hcloudReceiptAt(placed), depsDir);
  const res = runSetupCli(['uninstall', '--target', 'all', '--clean-kocli'], home, {
    PATH: emptyPath,
    HUAWEICLOUD_HOME: home,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(placed), true, 'the binary outside removeKooCli\u2019s scope survives');
  assert.ok(readReceipt('hcloud', depsDir), 'the receipt survives with the binary');
  assert.ok(
    res.stdout.includes(`Kept the devkit hcloud install receipt: the recorded binary (${placed}) still exists`),
    res.stdout,
  );
  assert.ok(res.stdout.includes('`dep uninstall hcloud` can still remove it'), res.stdout);
  assert.ok(!res.stdout.includes('Cleared the devkit hcloud install receipt.'), res.stdout);
});
