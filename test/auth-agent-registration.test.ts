import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { isWin, withTempHome } from './auth-credentials-harness.ts';
import { getAgentRegistrationStatuses } from '../plugins/huaweicloud-core/src/auth/agent-registration.ts';

test('agent registration detects OpenCode MCP config', () => {
  withAgentHome((home) => {
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'opencode.jsonc'),
      JSON.stringify({ mcp: { 'huaweicloud-devkit': { enabled: true } } }),
      'utf8',
    );
    const status = getAgentRegistrationStatuses('opencode');
    assert.equal(status.agents.opencode.configured, true);
  });
});

test('agent registration detects DSH cordis patch config', () => {
  withAgentHome((home) => {
    const profileDir = join(home, '.dsh', 'profiles', 'web');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'cordis.patch.yml'),
      [
        '- insert:',
        '    - id: mcp-huaweicloud', // legacy id written by older releases
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: huaweicloud',
        '',
      ].join('\n'),
      'utf8',
    );
    const status = getAgentRegistrationStatuses('dsh');
    assert.equal(status.agents.dsh.configured, true);
  });
});

test('agent registration ignores HUAWEICLOUD_HOME for agent-owned configs', () => {
  withAgentHome(() => {
    const devkitHome = mkdtempSync(join(tmpdir(), 'huaweicloud-devkit-home-'));
    const cfgDir = join(devkitHome, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({ mcp: { 'huaweicloud-devkit': { enabled: true } } }),
      'utf8',
    );
    const saved = process.env.HUAWEICLOUD_HOME;
    try {
      process.env.HUAWEICLOUD_HOME = devkitHome;
      const status = getAgentRegistrationStatuses('opencode');
      assert.equal(status.agents.opencode.configured, false);
    } finally {
      if (saved === undefined) delete process.env.HUAWEICLOUD_HOME;
      else process.env.HUAWEICLOUD_HOME = saved;
      rmSync(devkitHome, { recursive: true, force: true });
    }
  });
});

test('agent registration detects DSH_HOME cordis patch config', () => {
  withTempHome((home) => {
    const previousDshHome = process.env.DSH_HOME;
    const dshHome = join(home, 'custom-dsh');
    try {
      process.env.DSH_HOME = dshHome;
      const profileDir = join(dshHome, 'profiles', 'web');
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(
        join(profileDir, 'cordis.patch.yml'),
        "id: huaweicloud-devkit\nname: '@deepseek-ai/dsh-mcp-client'\nserverName: huaweicloud\n",
        'utf8',
      );
      const status = getAgentRegistrationStatuses('dsh');
      assert.equal(status.agents.dsh.configured, true);
    } finally {
      if (previousDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousDshHome;
    }
  });
});

test('agent registration reads codex plugin state from JSON, not the table substring', { skip: isWin }, () => {
  withTempHome((home) => {
    const binDir = join(home, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    const scriptPath = join(home, 'fake-codex.mjs');
    writeFileSync(
      scriptPath,
      `
const args = process.argv.slice(2);
if (args[0] === 'plugin' && args[1] === 'list' && args.includes('--json')) {
  console.log(process.env.FAKE_CODEX_LIST_JSON || '{"installed":[]}');
}
process.exit(0);
`,
      'utf8',
    );
    const commandPath = join(binDir, 'codex');
    writeFileSync(commandPath, `#!/usr/bin/env sh\n"${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
    chmodSync(commandPath, 0o755);
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}${delimiter}${savedPath || ''}`;
      // The legacy table format carries the source directory
      // (plugins/huaweicloud-core) in its SOURCE column; the old substring
      // check read that as "installed" even with no installed row.
      process.env.FAKE_CODEX_LIST_JSON =
        'NAME                SOURCE\nhuaweicloud-devkit  /repo/plugins/huaweicloud-core';
      assert.equal(getAgentRegistrationStatuses('codex').agents.codex.configured, false);
      process.env.FAKE_CODEX_LIST_JSON = JSON.stringify({ installed: [] });
      assert.equal(getAgentRegistrationStatuses('codex').agents.codex.configured, false);
      process.env.FAKE_CODEX_LIST_JSON = JSON.stringify({ installed: [{ name: 'huaweicloud-devkit' }] });
      assert.equal(getAgentRegistrationStatuses('codex').agents.codex.configured, true);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      delete process.env.FAKE_CODEX_LIST_JSON;
    }
  });
});

// Home isolation for probes that resolve through os.homedir() (codex-desktop
// payload dir, hermes layout). os.homedir() reads $HOME at call time, so
// pointing HOME at a temp dir keeps these process-private; USERPROFILE is
// redirected alongside it for Windows runs. XDG_CONFIG_HOME must be scrubbed
// too: the opencode probe's xdgConfigHome() resolver prefers an absolute
// XDG_CONFIG_HOME over $HOME/.config, so an ambient value (e.g. a CI env)
// silently splits the probe's read root away from the HOME this helper
// redirects — the same hardening agent-install.test.ts applies for child
// processes.
function withAgentHome(fn: (home: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-agent-home-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevXdgConfig = process.env.XDG_CONFIG_HOME;
  process.env.HOME = dir;
  if (prevProfile !== undefined) process.env.USERPROFILE = dir;
  delete process.env.XDG_CONFIG_HOME;
  try {
    return fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile !== undefined) process.env.USERPROFILE = prevProfile;
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('agent registration detects current-era codex-desktop install', () => {
  withAgentHome((home) => {
    const distDir = join(home, 'plugins', 'huaweicloud-devkit', 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'mcp-server.js'), '// fake server\n', 'utf8');
    const status = getAgentRegistrationStatuses('codex-desktop');
    assert.equal(status.agents['codex-desktop'].configured, true);
  });
});

test('agent registration still detects legacy codex-desktop config.toml', () => {
  withAgentHome((home) => {
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'config.toml'), '[mcp_servers.huaweicloud-devkit]\ncommand = "node"\n', 'utf8');
    const status = getAgentRegistrationStatuses('codex-desktop');
    assert.equal(status.agents['codex-desktop'].configured, true);
  });
});

test('agent registration detects hermes config under the installer layout', () => {
  withAgentHome((home) => {
    const hermesDir = join(home, '.hermes');
    mkdirSync(hermesDir, { recursive: true });
    writeFileSync(join(hermesDir, 'config.yaml'), 'mcp_servers:\n  huaweicloud-devkit:\n    command: node\n', 'utf8');
    const status = getAgentRegistrationStatuses('hermes');
    assert.equal(status.agents.hermes.configured, true);
  });
});

test('agent registration reads hermes from the real home, not HUAWEICLOUD_HOME', () => {
  withAgentHome((home) => {
    const devkitOnly = mkdtempSync(join(tmpdir(), 'huaweicloud-devkit-only-'));
    const hermesDir = join(home, '.hermes');
    mkdirSync(hermesDir, { recursive: true });
    writeFileSync(join(hermesDir, 'config.yaml'), 'mcp_servers:\n  huaweicloud-devkit:\n    command: node\n', 'utf8');
    const saved = process.env.HUAWEICLOUD_HOME;
    try {
      process.env.HUAWEICLOUD_HOME = devkitOnly;
      const status = getAgentRegistrationStatuses('hermes');
      assert.equal(status.agents.hermes.configured, true);
    } finally {
      if (saved === undefined) delete process.env.HUAWEICLOUD_HOME;
      else process.env.HUAWEICLOUD_HOME = saved;
      rmSync(devkitOnly, { recursive: true, force: true });
    }
  });
});
