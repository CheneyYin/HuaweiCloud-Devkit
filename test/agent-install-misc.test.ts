import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { makeEnv, run, setupCli } from './agent-install-harness.ts';

test('corrupt receipt keeps managed core copies and warns', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const workbuddyNative = join(home, '.workbuddy', 'skills');
    writeFileSync(join(workbuddyNative, '.huaweicloud-devkit-native.json'), '{"names": [torn');
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /unreadable native receipt .*\.workbuddy.*rewrites it/);
    assert.ok(
      existsSync(join(workbuddyNative, 'huaweicloud-core')),
      'a torn receipt must not cost a managed agent its core copies',
    );

    writeFileSync(join(workbuddyNative, '.huaweicloud-devkit-native.json'), '{"names": null}');
    const shapeBroken = run('opencode', home, cwd, 'install');
    assert.equal(shapeBroken.status, 0, shapeBroken.stderr);
    assert.match(
      shapeBroken.stdout,
      /unreadable native receipt .*\.workbuddy/,
      'a shape-broken receipt is corrupt, not ok-empty',
    );
    assert.ok(existsSync(join(workbuddyNative, 'huaweicloud-core')), 'core copies kept');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli help lists supported agent targets', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = spawnSync(process.execPath, [setupCli, 'help'], {
      cwd,
      env: makeEnv(home),
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.match(res.stdout, /install --target workbuddy/);
    assert.match(res.stdout, /install --target dsh/);
    assert.match(res.stdout, /install --target codearts/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
