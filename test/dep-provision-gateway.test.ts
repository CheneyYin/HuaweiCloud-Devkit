import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import { provisionDependencies, uninstallDependency } from '../plugins/huaweicloud-core/src/dep/provision.ts';
import {
  collector,
  emptyPathEnv,
  exeSuffix,
  gatewayReceiptWithTier,
  isWin,
  noTargets,
  runSetupCli,
  tempHome,
  writeExecutable,
  writeFakeUv,
} from './dep-provision-harness.ts';
import { readReceipt, writeReceipt } from '../plugins/huaweicloud-core/src/dep/receipts.ts';

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

test('uninstall gateway falls back to the resolved binary when the tier tool is gone', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  writeReceipt(gatewayReceiptWithTier('uv'), dir);
  let runnerCalls = 0;
  const result = uninstallDependency('open-mcp-gateway', noTargets, {
    receiptsDir: dir,
    env: emptyPathEnv(home),
    runCommand: () => {
      runnerCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(runnerCalls, 0, 'no tier command runs when the tier tool is gone');
  assert.equal(existsSync(gatewayBin), false, 'the resolved candidate binary is removed directly');
  assert.match(result.message, /uv is no longer installed.*removed the gateway binary directly/);
  assert.equal(readReceipt('open-mcp-gateway', dir), null);
});

test('uninstall gateway treats a failed tier uninstall with no remaining binary as already gone', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  writeReceipt(gatewayReceiptWithTier('pipx'), dir);
  writeExecutable(join(home, '.local', 'bin', `pipx${exeSuffix}`));
  const result = uninstallDependency('open-mcp-gateway', noTargets, {
    receiptsDir: dir,
    env: emptyPathEnv(home),
    runCommand: () => ({ status: 1, stdout: '', stderr: 'Nothing to uninstall' }),
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /open-mcp-gateway was already gone/);
  assert.match(result.message, /pipx reported: Nothing to uninstall/);
  assert.equal(readReceipt('open-mcp-gateway', dir), null);
});

test('uninstall gateway keeps the receipt when the tier uninstall fails and a binary still resolves', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  writeReceipt(gatewayReceiptWithTier('pip3'), dir);
  writeExecutable(join(home, '.local', 'bin', `pip3${exeSuffix}`));
  const result = uninstallDependency('open-mcp-gateway', noTargets, {
    receiptsDir: dir,
    env: emptyPathEnv(home),
    runCommand: () => ({ status: 2, stdout: '', stderr: 'pip error' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /pip3 uninstall failed \(exit 2\): pip error/);
  assert.ok(readReceipt('open-mcp-gateway', dir), 'the receipt is kept for the retry');
  assert.equal(existsSync(gatewayBin), true, 'the still-resolving binary is not deleted on a failed tier uninstall');
});

test('uninstall gateway with no tier tool and no resolvable binary clears the stale receipt', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  writeReceipt(
    { binary: 'open-mcp-gateway', provisioner: 'devkit', tier: 'uv', installedAt: '2026-10-08T00:00:00.000Z' },
    dir,
  );
  const result = uninstallDependency('open-mcp-gateway', noTargets, { receiptsDir: dir, env: emptyPathEnv(home) });
  assert.equal(result.ok, true);
  assert.match(result.message, /open-mcp-gateway was already gone \(no persistent install resolves\)/);
  assert.equal(readReceipt('open-mcp-gateway', dir), null);
});

test(
  'uninstall --target all --clean-gateway removes the devkit-installed gateway via its tier',
  { skip: isWin },
  () => {
    const home = tempHome();
    const log = writeFakeUv(home);
    const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
    writeExecutable(gatewayBin);
    const depsDir = join(home, '.config', 'huaweicloud', 'deps');
    writeReceipt(gatewayReceiptWithTier('uv'), depsDir);
    const res = runSetupCli(['uninstall', '--target', 'all', '--clean-gateway'], home);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(log, 'utf8').trim(), 'tool uninstall huaweicloud-open-mcp');
    assert.equal(existsSync(gatewayBin), false, 'the gateway binary is removed');
    assert.equal(readReceipt('open-mcp-gateway', depsDir), null, 'the receipt is cleared');
  },
);

test('uninstall --target all --clean-gateway selects only the gateway', { skip: isWin }, () => {
  const home = tempHome();
  writeFakeUv(home);
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  writeExecutable(join(home, '.local', 'bin', 'hcloud'));
  writeFileSync(join(home, '.obsutilconfig'), 'ak=x\nsk=y\n', 'utf8');
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  writeReceipt(gatewayReceiptWithTier('uv'), depsDir);
  const res = runSetupCli(['uninstall', '--target', 'all', '--clean-gateway'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(gatewayBin), false, 'the gateway binary is removed');
  assert.ok(existsSync(join(home, '.local', 'bin', 'hcloud')), 'KooCLI is kept without its flag');
  assert.ok(existsSync(join(home, '.obsutilconfig')), 'OBS config is kept without its flag');
  assert.doesNotMatch(res.stdout, /已保留/, 'a partial selection prints no keep-all message');
});

test('uninstall --target all --clean-gateway with nothing devkit-placed is a calm no-op', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  const res = runSetupCli(['uninstall', '--target', 'all', '--clean-gateway'], home, { PATH: emptyPath });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /No devkit-managed Open MCP Gateway found \(nothing to remove\)\./);
  assert.doesNotMatch(res.stdout, /Refusing to uninstall open-mcp-gateway/);
});

test('uninstall --target all --clean-gateway with a user-managed binary warns and keeps it', () => {
  const home = tempHome();
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  const res = runSetupCli(['uninstall', '--target', 'all', '--clean-gateway'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Refusing to uninstall open-mcp-gateway: no devkit install receipt/);
  assert.match(res.stdout, /uv tool uninstall huaweicloud-open-mcp/);
  assert.ok(existsSync(gatewayBin), 'a user-managed gateway is never removed');
});

test('uninstall --target all --clean-global is idempotent for the gateway', { skip: isWin }, () => {
  const home = tempHome();
  writeFakeUv(home);
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  writeReceipt(gatewayReceiptWithTier('uv'), depsDir);
  // A near-empty PATH: the runner's PATH could carry an ambient
  // huaweicloud-open-mcp, which would make run 2 resolve persistent and
  // refuse instead of staying a no-op, while a fully empty PATH would leave
  // the fake uv without rm in run 1. /usr/bin and /bin split the difference.
  const stubPath = fixtureDir('dep-provision-path-');
  const envPath = `${stubPath}${delimiter}/usr/bin${delimiter}/bin`;
  const first = runSetupCli(['uninstall', '--target', 'all', '--clean-global'], home, { PATH: envPath });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(existsSync(gatewayBin), false, 'the first run removes the gateway');
  const second = runSetupCli(['uninstall', '--target', 'all', '--clean-global'], home, { PATH: envPath });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /No devkit-managed Open MCP Gateway found \(nothing to remove\)\./);
  assert.doesNotMatch(second.stdout, /Refusing to uninstall open-mcp-gateway/);
});
