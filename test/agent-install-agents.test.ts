import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertNativeCoreDisclosure,
  assertServerPayload,
  coreRoster,
  countSkills,
  pkg,
  pluginVersion,
  run,
} from './agent-install-harness.ts';
import type { HermesAllowlist } from './agent-install-harness.ts';

test('forged receipt cannot delete user content in the officeace dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const officeaceDir = join(home, '.office-claw', 'skills');
    mkdirSync(join(officeaceDir, 'huawei-ecs'), { recursive: true });
    writeFileSync(join(officeaceDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\n', 'utf8');
    mkdirSync(join(officeaceDir, 'huaweicloud-user-notes'), { recursive: true });
    writeFileSync(join(officeaceDir, 'huaweicloud-user-notes', 'SKILL.md'), '---\nname: x\n---\nuser\n', 'utf8');
    writeFileSync(
      join(officeaceDir, '.huaweicloud-devkit-native.json'),
      JSON.stringify({ names: ['huawei-ecs', 'huaweicloud-user-notes'] }),
    );
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!existsSync(join(officeaceDir, 'huawei-ecs')), 'owned residue in a foreign dir still goes');
    assert.ok(
      existsSync(join(officeaceDir, 'huaweicloud-user-notes')),
      'receipt-remembered names must not earn delete rights in a foreign dir',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('forged receipt cannot exempt owned names in the officeace dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const officeaceDir = join(home, '.office-claw', 'skills');
    mkdirSync(join(officeaceDir, 'huawei-ecs'), { recursive: true });
    writeFileSync(join(officeaceDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\n', 'utf8');
    writeFileSync(join(officeaceDir, '.huaweicloud-devkit-native.json'), '{"names":["huawei-ecs"]}');
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      !existsSync(join(officeaceDir, 'huawei-ecs')),
      'officeace stays without native skill copies, receipt or not',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('uninstall --target dsh honors a live marketplace receipt', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const dshHome = join(home, '.dsh');
    const nativeDir = join(dshHome, 'skills');
    const liveRoot = join(home, 'staged-profile-pkg');
    const liveSkills = join(liveRoot, 'plugins', 'huaweicloud-core', 'skills');
    for (const name of coreRoster) {
      mkdirSync(join(nativeDir, name), { recursive: true });
      writeFileSync(join(nativeDir, name, 'SKILL.md'), '---\nname: stub\n---\n', 'utf8');
      mkdirSync(join(liveSkills, name), { recursive: true });
      writeFileSync(join(liveSkills, name, 'SKILL.md'), '---\nname: stub\n---\n', 'utf8');
    }
    writeFileSync(
      join(nativeDir, '.huaweicloud-devkit-native.json'),
      JSON.stringify({
        names: [...coreRoster].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        layout: 'package-root',
        packageRoot: liveRoot,
      }),
    );
    const agedTmp = join(nativeDir, '.huaweicloud-devkit-native.json.424242.tmp');
    writeFileSync(agedTmp, 'torn');
    const stale = new Date(Date.now() - 120_000);
    utimesSync(agedTmp, stale, stale);
    const res = run('dsh', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.match(res.stdout, /belong to the DSH profile's huaweicloud-devkit package/);
    assert.ok(existsSync(join(nativeDir, 'huaweicloud-core')), 'the marketplace dir is left for its maintainer');
    assert.ok(existsSync(join(nativeDir, '.huaweicloud-devkit-native.json')), 'the receipt stays with the copies');
    assert.ok(!existsSync(agedTmp), 'aged crash residue is swept even on the attribution path');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hermes install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('hermes', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[Hermes Agent\]/);
    assert.match(res.stdout, /Installation complete/);
    const pd = join(home, '.hermes', 'huaweicloud-plugins');
    assertNativeCoreDisclosure(join(home, '.hermes', 'skills'), pd);
    assertServerPayload(pd);
    assert.equal(pluginVersion(pd), pkg.version);
    const allowlistPath = join(home, '.hermes', 'shell-hooks-allowlist.json');
    assert.ok(existsSync(allowlistPath), 'shell hook allowlist must be written on install');
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as HermesAllowlist;
    const entry = (allowlist.approvals || []).find(
      (a) =>
        a &&
        a.event === 'pre_tool_call' &&
        typeof a.command === 'string' &&
        a.command.includes('huaweicloud-safety.py'),
    );
    assert.ok(entry, 'allowlist must pre-authorize the pre_tool_call safety hook');
    const pluginDir = join(home, '.hermes', 'plugins', 'huaweicloud-safety');
    assert.ok(existsSync(join(pluginDir, 'plugin.yaml')), 'hook plugin manifest must be installed');
    assert.ok(existsSync(join(pluginDir, '__init__.py')), 'hook plugin module must be installed');
    const init = readFileSync(join(pluginDir, '__init__.py'), 'utf8');
    assert.match(init, /def register\(ctx\)/);
    assert.match(init, /register_hook\("pre_tool_call"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hermes uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('hermes', home, cwd, 'install').status, 0);
    const res = run('hermes', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.hermes', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.hermes', 'huaweicloud-plugins')));
    const allowlistPath = join(home, '.hermes', 'shell-hooks-allowlist.json');
    if (existsSync(allowlistPath)) {
      const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as HermesAllowlist;
      const remains = (allowlist.approvals || []).some((a) => {
        const cmd = typeof a === 'string' ? a : a?.command;
        return typeof cmd === 'string' && cmd.includes('huaweicloud-safety.py');
      });
      assert.ok(!remains, 'uninstall must remove the safety hook approval from the allowlist');
    }
    assert.ok(
      !existsSync(join(home, '.hermes', 'plugins', 'huaweicloud-safety')),
      'uninstall must remove the safety hook plugin',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
