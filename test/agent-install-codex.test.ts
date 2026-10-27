import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { getCodexPluginName, getMarketplaceName } from '../plugins/huaweicloud-core/src/codex-probe.ts';
import {
  assertServerPayload,
  codexCacheStrayDir,
  countSkills,
  escapeRegExp,
  fakeCodexEnv,
  pkg,
  pluginVersion,
  run,
} from './agent-install-harness.ts';

test('codex-desktop install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('codex-desktop', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[Codex Desktop\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, 'plugins', 'huaweicloud-devkit', 'skills')) >= 6);
    const pd = join(home, 'plugins', 'huaweicloud-devkit');
    assertServerPayload(pd);
    assert.equal(pluginVersion(pd), pkg.version);
    // The status section this target lacked for months: both surfaces it
    // owns (plugin dir payload + marketplace registration) must report in.
    const status = run('codex-desktop', home, cwd, 'status');
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /\[Codex Desktop\]/);
    assert.match(status.stdout, /MCP Server:.*Installed/);
    assert.match(status.stdout, /Marketplace:.*Registered/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex-desktop uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('codex-desktop', home, cwd, 'install').status, 0);
    const res = run('codex-desktop', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, 'plugins', 'huaweicloud-devkit', 'skills')), 0);
    assert.ok(!existsSync(join(home, 'plugins', 'huaweicloud-devkit')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex target does not crash without Codex CLI', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const emptyPath = join(cwd, 'empty-path');
    mkdirSync(emptyPath, { recursive: true });
    const res = run('codex', home, cwd, 'install', { PATH: emptyPath });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /Codex CLI not found/);
    assert.doesNotMatch(res.stdout, /Installation complete/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex install uses DevKit plugin id and skips OpenCode marker', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const env = fakeCodexEnv(cwd);
    const res = run('codex', home, cwd, 'install', env);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /@huaweicloud-devkit/);
    assert.match(res.stdout, /Installation complete/);

    const log = readFileSync(env.logPath, 'utf8');
    assert.match(log, /"plugin","add","huaweicloud-devkit@huaweicloud-devkit"/);
    assert.doesNotMatch(log, /huaweicloud-core@huaweicloud-devkit/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex install fails fast when plugin add fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const env = fakeCodexEnv(cwd, { failPluginAdd: true });
    const res = run('codex', home, cwd, 'install', env);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /Codex plugin installation failed/);
    assert.match(res.stdout, /Installation failed for: codex/);
    assert.doesNotMatch(res.stdout, /Installation complete/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex install sweep: heals provably-ours and empty strays, leaves foreign content warned', () => {
  // The sweep's three branches, table-driven (the repo's repeated
  // home/cwd/try heads are a baselined clone family — one instance here
  // reuses that fingerprint instead of adding new twin fragments):
  // - allowlisted stamps and an EMPTY dir are provably ours and healed. The
  //   empty case is the crash-convergence pin: an empty stray poisons
  //   codex's version-dir scan exactly like a full one, and is the shape a
  //   killed prior sweep leaves behind (rmSync deleting entries, then dying
  //   before the dir) — requiring non-emptiness would permanently disable
  //   the healing for that cache.
  // - Foreign content is not provably ours, so it stays — but the warning
  //   must say WHY that matters (codex cannot load the plugin) and how to
  //   remediate, because the install itself still exits green around the
  //   poison.
  const branches = [
    { title: 'allowlisted stamps healed', files: ['install-counter', 'dau-stamp'], healed: true },
    { title: 'empty stray healed', files: [] as string[], healed: true },
    { title: 'foreign file left with consequence-named warning', files: ['user-notes.txt'], healed: false },
  ];
  for (const { title, files, healed } of branches) {
    const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
    try {
      const stray = codexCacheStrayDir(home);
      mkdirSync(stray, { recursive: true });
      for (const file of files) writeFileSync(join(stray, file), 'x');
      const env = fakeCodexEnv(cwd);
      const res = run('codex', home, cwd, 'install', env);
      assert.equal(res.status, 0, `${title}: ${res.stderr}`);
      assert.match(res.stdout, /Installation complete/);
      if (healed) {
        assert.match(res.stdout, /Healed pre-fix telemetry sibling/);
        assert.ok(!existsSync(stray), `${title}: the stray must be removed`);
      } else {
        assert.match(res.stdout, /codex cannot load the plugin while it exists/);
        assert.match(res.stdout, new RegExp(`rm -rf .*${escapeRegExp(stray)}`));
        assert.ok(existsSync(stray), `${title}: unrecognized content must be left untouched`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('codex install re-registers a same-name marketplace from a different source', () => {
  // npm-cache → local-checkout transitions: codex refuses the add with the
  // pinned 0.162.1 conflict wording; the installer must remove the stale
  // plugin + marketplace registrations and retry the add once.
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const env = fakeCodexEnv(cwd, { conflictOnce: true });
    const res = run('codex', home, cwd, 'install', env);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Marketplace already registered from a different source; re-registering/);
    assert.match(res.stdout, /Installation complete/);

    const calls = readFileSync(env.logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    // `plugin list` (the post-install status probe) is read-only and not
    // part of the sequence under test; the five mutation calls are.
    const pluginCalls = calls.filter((a) => a[0] === 'plugin' && a[1] !== 'list');
    const op = (a: string[]) => (a[1] === 'marketplace' ? `marketplace ${a[2]}` : a[1]);
    assert.deepEqual(
      pluginCalls.map((a) => op(a)),
      [
        'marketplace add', // conflicts (one-shot knob)
        'remove', // stale plugin registration, best-effort
        'marketplace remove', // the load-bearing step
        'marketplace add', // retry succeeds
        'add', // the payload install
      ],
    );
    // Identity-bearing calls carry the exact pluginId / marketplace name.
    assert.deepEqual(pluginCalls[1], ['plugin', 'remove', `${getCodexPluginName()}@${getMarketplaceName()}`]);
    assert.deepEqual(pluginCalls[2], ['plugin', 'marketplace', 'remove', getMarketplaceName()]);
    assert.deepEqual(pluginCalls[4], ['plugin', 'add', `${getCodexPluginName()}@${getMarketplaceName()}`]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex status parses plugin list JSON (name match, not path substring)', () => {
  // Installed plugin by name → Installed
  {
    const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
    try {
      const env = fakeCodexEnv(cwd, {
        listJson: JSON.stringify({
          installed: [{ name: 'huaweicloud-devkit', pluginId: 'huaweicloud-devkit@personal' }],
        }),
      });
      const res = run('codex', home, cwd, 'status', env);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Plugin:.*Installed/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  // Legacy name huaweicloud-core in a PATH is no longer treated as installed (#501).
  {
    const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
    try {
      const env = fakeCodexEnv(cwd, {
        listJson: JSON.stringify({
          installed: [
            { name: 'documents', pluginId: 'documents@x', source: { path: 'C:/pkg/plugins/huaweicloud-core' } },
          ],
        }),
      });
      const res = run('codex', home, cwd, 'status', env);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Plugin:.*Not installed/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('codex uninstall removes current and legacy plugin ids', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const env = fakeCodexEnv(cwd);
    const res = run('codex', home, cwd, 'uninstall', env);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Removing Codex plugin: huaweicloud-devkit@huaweicloud-devkit/);
    assert.match(res.stdout, /Removing Codex plugin: huaweicloud-core@huaweicloud-devkit/);

    const log = readFileSync(env.logPath, 'utf8');
    assert.match(log, /"plugin","remove","huaweicloud-devkit@huaweicloud-devkit"/);
    assert.match(log, /"plugin","remove","huaweicloud-core@huaweicloud-devkit"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex uninstall keeps the plugin cache when marketplace remove fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('codex', home, cwd, 'install', fakeCodexEnv(cwd)).status, 0);
    // Seed the marketplace-keyed cache shell `codex plugin remove` leaves
    // behind (live-verified on codex-cli 0.162.1).
    const cacheDir = join(home, '.codex', 'plugins', 'cache', getMarketplaceName());
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'marker'), 'x');

    const res = run('codex', home, cwd, 'uninstall', fakeCodexEnv(cwd, { failMarketplaceRemove: true }));
    assert.equal(res.status, 0, res.stderr);
    // The safety gate: a failed `codex plugin marketplace remove` leaves the
    // registration potentially live, so its cache must survive the uninstall
    // (deleting it would break a still-registered plugin).
    assert.ok(existsSync(join(cacheDir, 'marker')), 'failed marketplace remove must keep the plugin cache');

    // Positive twin: a successful marketplace remove opens the gate and
    // cleans the cache (the fake-CLI pin; real-agents covers the real CLI).
    const again = run('codex', home, cwd, 'uninstall', fakeCodexEnv(cwd));
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!existsSync(join(cacheDir, 'marker')), 'successful marketplace remove must clean the plugin cache');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
