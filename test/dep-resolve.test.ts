import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { resolveDependencyCommand } from '../plugins/huaweicloud-core/src/lib/dep-resolve.ts';
import { installGatewayTool } from '../plugins/huaweicloud-core/src/dep/installers/gateway.ts';
import { installerFor } from '../plugins/huaweicloud-core/src/dep/installers/table.ts';
import { provisionDependencies } from '../plugins/huaweicloud-core/src/dep/provision.ts';
import { fixtureDir } from './fixture-dir.ts';
import { readReceipt } from '../plugins/huaweicloud-core/src/dep/receipts.ts';
import { root, setupCli } from './agent-install-harness.ts';
import { collector, exeSuffix, gatewayResolution, isWin, tempHome, writeExecutable } from './dep-provision-harness.ts';
import { DEPENDENCIES, DEPENDENCY_IDS } from '../plugins/huaweicloud-core/src/lib/dependency-model.ts';

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
    USERPROFILE: home,
    PATH: '/usr/bin',
  });
  assert.deepEqual(resolved, { command: candidate, argsPrefix: [], tier: 'candidate' });
});

test('dep-resolve: a persistent install under a fake HOME resolves as candidate', () => {
  const home = tempHome();
  const candidate = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(candidate);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, USERPROFILE: home, PATH: '/usr/bin' });
  assert.deepEqual(resolved, { command: candidate, argsPrefix: [], tier: 'candidate' });
});

test('dep-resolve: a PATH hit resolves as the path tier', { skip: isWin }, () => {
  const home = tempHome();
  const stubDir = fixtureDir('dep-provision-bin-');
  const stub = join(stubDir, 'huaweicloud-open-mcp');
  writeExecutable(stub);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: `/usr/bin${delimiter}${stubDir}` });
  assert.deepEqual(resolved, { command: stub, argsPrefix: [], tier: 'path' });
});

test('dep-resolve: uvx resolves as the fallback tier with the package argsPrefix', { skip: isWin }, () => {
  const home = tempHome();
  const stubDir = fixtureDir('dep-provision-uvx-');
  const uvx = join(stubDir, 'uvx');
  writeExecutable(uvx);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: `/usr/bin${delimiter}${stubDir}` });
  assert.deepEqual(resolved, { command: uvx, argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' });
});

test('dep-resolve: the fallback command is probed in ~/.local/bin before PATH', () => {
  const home = tempHome();
  const localUvx = join(home, '.local', 'bin', `uvx${exeSuffix}`);
  writeExecutable(localUvx);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, USERPROFILE: home, PATH: '/usr/bin' });
  assert.deepEqual(resolved, { command: localUvx, argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' });
});

test('dep-resolve: nothing anywhere resolves to null', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-empty-');
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, USERPROFILE: home, PATH: emptyPath });
  assert.equal(resolved, null);
});

test('installers: every installable dependency has a kind-matching installer, sandbox-resident none', () => {
  for (const id of DEPENDENCY_IDS) {
    const installer = installerFor(id);
    const kind = DEPENDENCIES[id].kind;
    if (kind === 'sandbox-resident') {
      assert.equal(installer, null, `${id} is sandbox-resident: the host never manages it`);
      continue;
    }
    assert.ok(installer, `${id} must have an installer in DEP_INSTALLERS`);
    assert.equal(installer.kind, kind, `${id}'s installer kind must match the catalog`);
    assert.ok(installer.escapeHatch.length > 0, `${id}'s no-receipt refusal names an escape hatch`);
  }
});

test('installers: a successful gateway install records its tier in a receipt', { skip: isWin }, async () => {
  const home = tempHome();
  const savedHome = process.env.HOME;
  const savedReceiptHome = process.env.HUAWEICLOUD_HOME;
  const savedPath = process.env.PATH;
  try {
    process.env.HOME = home;
    process.env.HUAWEICLOUD_HOME = home;
    writeExecutable(join(home, '.local', 'bin', 'uv'));
    process.env.PATH = `/usr/bin${delimiter}${join(home, '.local', 'bin')}`;
    const result = await installGatewayTool();
    assert.deepEqual(result, { ok: true, tier: 'uv' });
    const receipt = readReceipt('open-mcp-gateway');
    assert.equal(receipt?.binary, 'open-mcp-gateway');
    assert.equal(receipt?.provisioner, 'devkit');
    assert.equal(receipt?.tier, 'uv');
    assert.ok(!Number.isNaN(Date.parse(receipt?.installedAt ?? '')), 'installedAt is a real ISO timestamp');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedReceiptHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = savedReceiptHome;
    process.env.PATH = savedPath;
  }
});

test('installers: installKooCli writes an hcloud receipt after a verified install', { skip: isWin }, () => {
  const home = tempHome();
  const fakeBin = fixtureDir('dep-provision-fakebin-');
  // Fake curl writes the "tarball"; fake tar "extracts" an hcloud binary
  // into the scratch dir installKooCli passes via -C; the real mv then
  // places it under the fake HOME.
  writeFileSync(join(fakeBin, 'curl'), '#!/bin/sh\necho fake-tarball > "$4"\n');
  chmodSync(join(fakeBin, 'curl'), 0o755);
  writeFileSync(
    join(fakeBin, 'tar'),
    '#!/bin/sh\ndir="$4"\nmkdir -p "$dir"\nprintf \'#!/bin/sh\\n\' > "$dir/hcloud"\nchmod +x "$dir/hcloud"\n',
  );
  chmodSync(join(fakeBin, 'tar'), 0o755);
  const res = spawnSync(process.execPath, [setupCli, 'dep', 'install', 'hcloud'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      HUAWEICLOUD_HOME: home,
      PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin`,
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Install complete/);
  const placed = join(home, '.local', 'bin', 'hcloud');
  assert.ok(existsSync(placed), 'the fake install placed the binary');
  const receipt = readReceipt('hcloud', join(home, '.config', 'huaweicloud', 'deps'));
  assert.ok(receipt, 'the verified install wrote a receipt');
  assert.equal(receipt?.path, placed);
  assert.equal(receipt?.provisioner, 'devkit');
});

test('installers: an already-present binary writes no receipt', async () => {
  const home = tempHome();
  const savedReceiptHome = process.env.HUAWEICLOUD_HOME;
  const out = collector();
  try {
    process.env.HUAWEICLOUD_HOME = home;
    await provisionDependencies(['hcloud'], {
      log: out.log,
      probeHcloud: () => ({ status: 'ok', installed: true, installedVersion: '7.3.12' }),
      installKooCli: async () => true,
    });
    assert.match(out.text(), /hcloud: present \(7\.3\.12\), skipping install/);
    // The skip path never reaches an installer, so no receipt can appear.
    assert.equal(readReceipt('hcloud'), null);
  } finally {
    if (savedReceiptHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = savedReceiptHome;
  }
});
