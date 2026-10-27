import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import { provisionDependencies, uninstallDependency } from '../plugins/huaweicloud-core/src/dep/provision.ts';
import {
  cannotStageEacces,
  collector,
  emptyPathEnv,
  exeSuffix,
  gatewayReceiptWithTier,
  hcloudReceiptAt,
  isWin,
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
  assert.match(prompts[0], /Install the Open MCP Gateway persistently \(uv tool install \/ pipx \/ pip\)\?/);
  assert.match(out.text(), /open-mcp-gateway: installed via uv/);
});

test('provisioning: hcloud absent in a TTY session auto-installs exactly once', async () => {
  const out = collector();
  let installerCalls = 0;
  await provisionDependencies(['hcloud'], {
    tty: true,
    log: out.log,
    probeHcloud: () => ({ status: 'not_found', installed: false }),
    installKooCli: async () => {
      installerCalls += 1;
      return true;
    },
  });
  assert.equal(installerCalls, 1, 'the TTY auto path must call the injected installer');
  assert.match(out.text(), /hcloud: installed/);
  assert.doesNotMatch(out.text(), /not found; auto-install needs an interactive session/);
});

test('uninstall hcloud without a receipt refuses and points at --clean-kocli', () => {
  const dir = fixtureDir('dep-uninstall-');
  const result = uninstallDependency('hcloud', noTargets, { receiptsDir: dir, env: emptyPathEnv(dir) });
  assert.equal(result.ok, false);
  assert.match(result.message, /Refusing to uninstall hcloud: no devkit install receipt/);
  assert.match(result.message, /uninstall --target all --clean-kocli/);
});

test('uninstall open-mcp-gateway without a receipt refuses and points at the manual uninstalls', () => {
  const dir = fixtureDir('dep-uninstall-');
  const result = uninstallDependency('open-mcp-gateway', noTargets, { receiptsDir: dir, env: emptyPathEnv(dir) });
  assert.equal(result.ok, false);
  assert.match(result.message, /Refusing to uninstall open-mcp-gateway: no devkit install receipt/);
  assert.match(result.message, /uv tool uninstall huaweicloud-open-mcp/);
  assert.match(result.message, /pipx uninstall huaweicloud-open-mcp/);
  assert.match(result.message, /pip3 uninstall -y huaweicloud-open-mcp/);
  assert.doesNotMatch(result.message, /pip3 uninstall --user/, 'pip rejects --user on uninstall');
});

test('uninstall refuses while the effective pack union still requires the id', () => {
  const dir = fixtureDir('dep-uninstall-');
  writeReceipt(hcloudReceiptAt('/gone-anyway'), dir);
  const targets: DepUninstallTargets = {
    enabledPacks: new Set<PackId>(['core', 'huaweicloud-cli', 'auth']),
    carriers: [
      { label: 'OpenCode', packs: new Set<PackId>(['core', 'huaweicloud-cli', 'auth']) },
      { label: 'Codex CLI', packs: new Set<PackId>(['core', 'voucher']) },
    ],
  };
  const result = uninstallDependency('hcloud', targets, { receiptsDir: dir });
  assert.equal(result.ok, false);
  assert.match(result.message, /Refusing to uninstall hcloud: required by enabled pack\(s\) auth, huaweicloud-cli/);
  assert.match(result.message, /installed targets: OpenCode/);
  assert.doesNotMatch(result.message, /Codex CLI/, 'a target not carrying the requiring packs is not named');
  // The requirement refusal fires before the receipt gate: even a receipt
  // does not unlock removing a binary the enabled surface still needs.
  assert.ok(readReceipt('hcloud', dir), 'the receipt is kept untouched');
});

test(
  'uninstall hcloud refuses sudo for a receipt path outside the known install locations',
  { skip: cannotStageEacces },
  () => {
    const home = tempHome();
    const dir = join(home, 'deps');
    // A forged receipt aiming sudo at an arbitrary file: present on disk,
    // EACCES-protected, but neither a platform candidate nor the installer's
    // computed binPath.
    const placed = join(home, 'usr-local', 'hcloud');
    writeExecutable(placed);
    writeReceipt(hcloudReceiptAt(placed), dir);
    chmodSync(join(home, 'usr-local'), 0o555);
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
      assert.equal(result.ok, false, result.message);
      assert.deepEqual(calls, [], 'sudo is never spawned for an untrusted receipt path');
      assert.match(result.message, /receipt path is not a known devkit install location/);
      assert.equal(existsSync(placed), true, 'the binary is left in place');
      assert.ok(readReceipt('hcloud', dir), 'the receipt is kept');
    } finally {
      chmodSync(join(home, 'usr-local'), 0o755);
    }
  },
);

test('dep install devbridge refuses with the in-sandbox pointer', () => {
  const res = runDep(['install', 'devbridge']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /devbridge ships inside the cloud sandbox; the host never installs or removes it\./);
});

test('install --skip-binaries suppresses the provisioning pass', () => {
  const res = runInstall(['install', '--target', 'opencode', '--skip-binaries']);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /Provisioning pack binaries/);
});

test('dep uninstall devbridge refuses with the in-sandbox pointer', () => {
  const res = runDep(['uninstall', 'devbridge']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /devbridge ships inside the cloud sandbox; the host never installs or removes it\./);
});

test('dep uninstall hcloud without a receipt refuses and points at --clean-kocli', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  const res = runSetupCli(['dep', 'uninstall', 'hcloud'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /Refusing to uninstall hcloud: no devkit install receipt/);
  assert.match(res.stderr, /uninstall --target all --clean-kocli/);
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  assert.equal(existsSync(join(depsDir, 'hcloud.json')), false, 'a refusal writes no receipt');
  assert.equal(existsSync(join(depsDir, 'lock')), false, 'the decision lock is released on refusal');
});

test('dep uninstall hcloud refuses while an installed target still requires it', () => {
  const home = tempHome();
  // Install with the real PATH (the installer needs npm); the uninstall run
  // then uses an empty PATH so codex detection cannot widen the union.
  const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'huaweicloud-cli'], home);
  assert.equal(installRes.status, 0, installRes.stderr);
  const emptyPath = fixtureDir('dep-provision-path-');
  // A receipt exists — the refusal must still fire because the installed
  // target's pack surface requires hcloud.
  writeReceipt(hcloudReceiptAt(join(home, '.local', 'bin', 'hcloud')), join(home, '.config', 'huaweicloud', 'deps'));
  const res = runSetupCli(['dep', 'uninstall', 'hcloud'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /Refusing to uninstall hcloud: required by enabled pack\(s\) huaweicloud-cli/);
  assert.match(res.stderr, /installed targets: OpenCode/);
  assert.match(res.stderr, /Remove or trim those targets first/);
});

test('dep uninstall open-mcp-gateway refuses while an installed target still requires it', () => {
  const home = tempHome();
  const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'huaweicloud-open-mcp'], home);
  assert.equal(installRes.status, 0, installRes.stderr);
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  writeReceipt(gatewayReceiptWithTier('uv'), depsDir);
  const emptyPath = fixtureDir('dep-provision-path-');
  const res = runSetupCli(['dep', 'uninstall', 'open-mcp-gateway'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 1, res.stderr);
  assert.match(
    res.stderr,
    /Refusing to uninstall open-mcp-gateway: required by enabled pack\(s\) huaweicloud-open-mcp/,
  );
  assert.match(res.stderr, /installed targets: OpenCode/);
  assert.ok(readReceipt('open-mcp-gateway', depsDir), 'the refusal keeps the receipt');
  assert.ok(existsSync(gatewayBin), 'the required gateway binary is kept');
});
