import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import test from 'node:test';

import { assertNativeCoreDisclosure, coreRoster, run } from './agent-install-harness.ts';
import { skillTreeEquals } from '../plugins/huaweicloud-core/src/lib/skill-tree.ts';

test('install reconciles native skill dirs: residue purged, core refreshed, user skills preserved', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const nativeDir = join(home, '.config', 'opencode', 'skills');
    mkdirSync(join(nativeDir, 'huawei-ecs'), { recursive: true });
    writeFileSync(join(nativeDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\nstale\n');
    mkdirSync(join(nativeDir, 'huaweicloud-core', 'references'), { recursive: true });
    writeFileSync(join(nativeDir, 'huaweicloud-core', 'SKILL.md'), '---\nname: huaweicloud-core\n---\nstale\n');
    writeFileSync(join(nativeDir, 'huaweicloud-core', 'references', 'retired-by-newer-tree.md'), 'orphan\n');
    mkdirSync(join(nativeDir, 'huawei-my-own-runbook'), { recursive: true });
    writeFileSync(
      join(nativeDir, 'huawei-my-own-runbook', 'SKILL.md'),
      '---\nname: huawei-my-own-runbook\n---\nuser\n',
    );
    // Residue on an agent this run does not install: owned names there are
    // stale regardless (no receipt, no replacement coming this run).
    const otherDir = join(home, '.workbuddy', 'skills');
    mkdirSync(join(otherDir, 'huawei-ecs'), { recursive: true });
    writeFileSync(join(otherDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\nstale\n');

    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!existsSync(join(nativeDir, 'huawei-ecs')), 'non-core owned copy must be purged');
    assert.ok(existsSync(join(nativeDir, 'huawei-my-own-runbook')), 'user skill sharing the prefix must survive');
    assert.ok(!existsSync(join(otherDir, 'huawei-ecs')), 'residue on a non-installed agent must be purged');
    const pd = join(home, '.config', 'opencode', 'huaweicloud-plugins');
    assert.ok(
      skillTreeEquals(join(nativeDir, 'huaweicloud-core'), join(pd, 'skills', 'huaweicloud-core')),
      'stale core copy must be refreshed byte-equal to the payload',
    );
    assert.ok(
      !existsSync(join(nativeDir, 'huaweicloud-core', 'references', 'retired-by-newer-tree.md')),
      'a file the newer tree retired must not survive the refresh',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install for one target keeps another managed agent core copies', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const workbuddyNative = join(home, '.workbuddy', 'skills');
    assert.ok(existsSync(join(workbuddyNative, '.huaweicloud-devkit-native.json')));
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      existsSync(join(workbuddyNative, 'huaweicloud-core')),
      'managed core copies of a non-installed-this-run agent must survive',
    );
    assertNativeCoreDisclosure(
      join(home, '.config', 'opencode', 'skills'),
      join(home, '.config', 'opencode', 'huaweicloud-plugins'),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('install warns and continues when the native skill dir cannot be created', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const nativeDir = join(home, '.config', 'opencode', 'skills');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(nativeDir, 'occupied by a file');
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /native core skills not synced/);
    assert.ok(existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('uninstall warns about possible leftovers when the receipt is corrupt', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const workbuddyNative = join(home, '.workbuddy', 'skills');
    mkdirSync(join(workbuddyNative, 'huaweicloud-retired-x'), { recursive: true });
    writeFileSync(join(workbuddyNative, 'huaweicloud-retired-x', 'SKILL.md'), '---\nname: x\n---\n', 'utf8');
    writeFileSync(join(workbuddyNative, '.huaweicloud-devkit-native.json'), '{"names": [torn');
    const res = run('workbuddy', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.match(
      res.stdout,
      /unreadable native receipt .*possible devkit leftover\(s\) left in place: huaweicloud-retired-x/,
    );
    assert.ok(
      existsSync(join(workbuddyNative, 'huaweicloud-retired-x')),
      'an unidentifiable name is never auto-deleted',
    );
    assert.ok(
      !existsSync(join(workbuddyNative, '.huaweicloud-devkit-native.json')),
      'the corrupt receipt is still removed',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('uninstall removes receipt-remembered retired names', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const nativeDir = join(home, '.config', 'opencode', 'skills');
    const receiptPath = join(nativeDir, '.huaweicloud-devkit-native.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { names: string[] };
    mkdirSync(join(nativeDir, 'huaweicloud-retired-example'), { recursive: true });
    writeFileSync(join(nativeDir, 'huaweicloud-retired-example', 'SKILL.md'), '---\nname: x\n---\n', 'utf8');
    writeFileSync(receiptPath, JSON.stringify({ names: [...receipt.names, 'huaweicloud-retired-example'] }));
    const res = run('opencode', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.ok(!existsSync(join(nativeDir, 'huaweicloud-retired-example')), 'retired name must not survive uninstall');
    assert.ok(!existsSync(receiptPath), 'receipt removed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('update restores divergent and missing native core copies', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const nativeDir = join(home, '.config', 'opencode', 'skills');
    writeFileSync(join(nativeDir, 'huaweicloud-core', 'SKILL.md'), 'stale\n', 'utf8');
    rmSync(join(nativeDir, 'huaweicloud-safety'), { recursive: true, force: true });
    const res = run('opencode', home, cwd, 'update');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Update complete/);
    assertNativeCoreDisclosure(nativeDir, join(home, '.config', 'opencode', 'huaweicloud-plugins'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('uninstall removes dead-maintainer copies and ignores foreign-dir package-root receipts', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    // Dead maintainer on the real dsh dir: the recorded package root is
    // gone — residue, not disclosure.
    const dshHome = join(home, '.dsh');
    const dshNative = join(dshHome, 'skills');
    const deadRoot = join(home, 'gone-profile-pkg');
    for (const name of coreRoster) {
      mkdirSync(join(dshNative, name), { recursive: true });
      writeFileSync(join(dshNative, name, 'SKILL.md'), '---\nname: stub\n---\n', 'utf8');
    }
    writeFileSync(
      join(dshNative, '.huaweicloud-devkit-native.json'),
      JSON.stringify({
        names: [...coreRoster].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        layout: 'package-root',
        packageRoot: deadRoot,
      }),
    );
    const dsh = run('dsh', home, cwd, 'uninstall');
    assert.match(dsh.stdout, /Uninstall complete/);
    assert.match(dsh.stdout, /recorded package maintainer is gone — removing them/);
    assert.ok(!existsSync(join(dshNative, 'huaweicloud-core')), 'dead-maintainer copies must go');

    // A LIVE package-root receipt on a foreign (workbuddy) dir: hand-copied
    // by construction — the postinstall only writes the dsh dir — so it
    // earns no attribution there.
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const wbNative = join(home, '.workbuddy', 'skills');
    const liveRoot = join(home, 'staged-profile-pkg');
    const liveSkills = join(liveRoot, 'plugins', 'huaweicloud-core', 'skills');
    for (const name of coreRoster) {
      mkdirSync(join(liveSkills, name), { recursive: true });
      writeFileSync(join(liveSkills, name, 'SKILL.md'), '---\nname: stub\n---\n', 'utf8');
    }
    writeFileSync(
      join(wbNative, '.huaweicloud-devkit-native.json'),
      JSON.stringify({
        names: [...coreRoster].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        layout: 'package-root',
        packageRoot: liveRoot,
      }),
    );
    const foreign = run('workbuddy', home, cwd, 'uninstall');
    assert.match(foreign.stdout, /Uninstall complete/);
    assert.ok(
      !foreign.stdout.includes('belong to the DSH profile'),
      'a foreign-dir package-root receipt earns no attribution',
    );
    assert.ok(!existsSync(join(wbNative, 'huaweicloud-core')), 'the copies go with the normal removal');
    assert.ok(!existsSync(join(wbNative, '.huaweicloud-devkit-native.json')), 'the receipt goes too');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('uninstall sweeps aged receipt tmp files and leaves young ones', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const nativeDir = join(home, '.workbuddy', 'skills');
    const agedTmp = join(nativeDir, '.huaweicloud-devkit-native.json.424242.tmp');
    const youngTmp = join(nativeDir, '.huaweicloud-devkit-native.json.999999.tmp');
    writeFileSync(agedTmp, 'torn');
    writeFileSync(youngTmp, 'in-flight');
    const stale = new Date(Date.now() - 120_000);
    utimesSync(agedTmp, stale, stale);
    const res = run('workbuddy', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.ok(!existsSync(agedTmp), 'the aged tmp file is swept');
    assert.ok(existsSync(youngTmp), 'a young tmp is never swept by the uninstall path');
    assert.deepEqual(
      readdirSync(nativeDir).filter((n) => n !== '.huaweicloud-devkit-native.json.999999.tmp'),
      [],
      'nothing else devkit-owned remains in the dir',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
