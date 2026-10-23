import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');

// Characterization pins for the targets whose install/update/uninstall
// lifecycle had no spawn-level coverage (workbuddy, openclaw, atomcode) and
// for the hermes update path. Each test drives the real CLI against a fake
// HOME the way a user would and asserts the observable end state: payload
// layout, MCP config registration, hook deployment, marker, and removal on
// uninstall. The install/update pair unification in setup-cli.ts must keep
// every one of these green without edits.

function makeEnv(home: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HERMES_HOME: join(home, '.hermes'),
    HUAWEICLOUD_HOME: home,
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
  };
  for (const key of [
    'ATOMCODE_HOME',
    'DSH_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
  ]) {
    delete env[key];
  }
  delete env.HCLOUD_BIN;
  return env;
}

function runCli(home: string, cwd: string, args: string[]) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd,
    env: makeEnv(home),
    encoding: 'utf8',
    timeout: 240000,
  });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function assertPayloadInstalled(pluginDir: string): void {
  assert.ok(existsSync(join(pluginDir, 'dist', 'mcp-server.js')), 'server bundle missing');
  assert.ok(existsSync(join(pluginDir, 'safety', 'policy.json')), 'safety policy missing');
  assert.ok(existsSync(join(pluginDir, 'skills', '.manifest.json')), 'skills manifest missing');
  assert.ok(existsSync(join(pluginDir, '.installed')), '.installed marker missing');
}

function assertMcpEntry(configPath: string, mapKey: 'mcpServers' | 'mcp'): void {
  const config = readJson(configPath);
  const entry = (config[mapKey] as Record<string, unknown> | undefined)?.['huaweicloud-devkit'];
  assert.ok(entry, `${configPath} has no huaweicloud-devkit entry`);
  const rendered = JSON.stringify(entry);
  assert.match(rendered, /dist\/mcp-server\.js/, `entry does not point at the server: ${rendered}`);
}

test('workbuddy lifecycle: install, update, uninstall', () => {
  const home = fixtureDir('wb-home-');
  const cwd = fixtureDir('wb-proj-');
  const pluginDir = join(home, '.workbuddy', 'huaweicloud-plugins');
  const configPath = join(home, '.workbuddy', 'mcp.json');

  const install = runCli(home, cwd, ['install', '--target', 'workbuddy']);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /\[WorkBuddy\]/);
  assertPayloadInstalled(pluginDir);
  assertMcpEntry(configPath, 'mcpServers');

  const update = runCli(home, cwd, ['update', '--target', 'workbuddy']);
  assert.equal(update.status, 0, update.stderr);
  assertPayloadInstalled(pluginDir);
  assertMcpEntry(configPath, 'mcpServers');

  const uninstall = runCli(home, cwd, ['uninstall', '--target', 'workbuddy']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.ok(!existsSync(pluginDir), 'plugin dir survived uninstall');
  if (existsSync(configPath)) {
    const config = readJson(configPath);
    assert.equal(
      (config.mcpServers as Record<string, unknown> | undefined)?.['huaweicloud-devkit'],
      undefined,
      'mcp.json entry survived uninstall',
    );
  }
});

test('openclaw lifecycle: install, update, uninstall', () => {
  const home = fixtureDir('oc-home-');
  const cwd = fixtureDir('oc-proj-');
  const pluginDir = join(home, '.agents', 'huaweicloud-plugins');
  const commandsDir = join(home, '.agents', 'commands');

  const install = runCli(home, cwd, ['install', '--target', 'openclaw']);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /\[OpenClaw\]/);
  assertPayloadInstalled(pluginDir);
  assertMcpEntry(join(pluginDir, '.mcp.json'), 'mcpServers');
  assert.ok(existsSync(join(pluginDir, '.codex-plugin')), 'codex plugin manifest missing');
  const commands = existsSync(commandsDir) ? readdirSync(commandsDir) : [];
  assert.ok(commands.includes('huaweicloud-doctor.md'), `commands missing: ${commands.join(',')}`);

  const update = runCli(home, cwd, ['update', '--target', 'openclaw']);
  assert.equal(update.status, 0, update.stderr);
  assertPayloadInstalled(pluginDir);
  assertMcpEntry(join(pluginDir, '.mcp.json'), 'mcpServers');

  const uninstall = runCli(home, cwd, ['uninstall', '--target', 'openclaw']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.ok(!existsSync(pluginDir), 'plugin dir survived uninstall');
  const remaining = existsSync(commandsDir) ? readdirSync(commandsDir) : [];
  assert.ok(
    !remaining.some((name) => name.startsWith('huawei')),
    `huawei* commands survived uninstall: ${remaining.join(',')}`,
  );
});

test('atomcode lifecycle: install, update, uninstall', () => {
  const home = fixtureDir('ac-home-');
  const cwd = fixtureDir('ac-proj-');
  const atomcodeHome = join(home, '.atomcode');
  const pluginDir = join(atomcodeHome, 'huaweicloud-plugins');
  const configPath = join(atomcodeHome, 'mcp.json');
  const hooksConfigPath = join(atomcodeHome, 'hooks.json');

  const install = runCli(home, cwd, ['install', '--target', 'atomcode']);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /\[AtomCode\]/);
  assertPayloadInstalled(pluginDir);
  assertMcpEntry(configPath, 'mcpServers');
  assert.ok(
    existsSync(join(pluginDir, 'hooks', 'huaweicloud-telemetry.js')),
    'telemetry hook script missing',
  );
  const hooks = readJson(hooksConfigPath);
  const hwTelemetry = (hooks.hooks as Record<string, unknown> | undefined)?.['hw-telemetry'];
  assert.equal((hwTelemetry as Record<string, unknown> | undefined)?.event, 'pre_tool_use');
  assert.equal(typeof (hwTelemetry as Record<string, unknown> | undefined)?.command, 'string');

  const update = runCli(home, cwd, ['update', '--target', 'atomcode']);
  assert.equal(update.status, 0, update.stderr);
  assertPayloadInstalled(pluginDir);
  assertMcpEntry(configPath, 'mcpServers');

  const uninstall = runCli(home, cwd, ['uninstall', '--target', 'atomcode']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.ok(!existsSync(pluginDir), 'plugin dir survived uninstall');
  if (existsSync(hooksConfigPath)) {
    const hooks = readJson(hooksConfigPath);
    assert.equal(
      (hooks.hooks as Record<string, unknown> | undefined)?.['hw-telemetry'],
      undefined,
      'hw-telemetry hook survived uninstall',
    );
  }
  if (existsSync(configPath)) {
    const config = readJson(configPath);
    assert.equal(
      (config.mcpServers as Record<string, unknown> | undefined)?.['huaweicloud-devkit'],
      undefined,
      'mcp.json entry survived uninstall',
    );
  }
});

test('hermes update refreshes payload, config, and hooks', () => {
  const home = fixtureDir('hm-home-');
  const cwd = fixtureDir('hm-proj-');
  const pluginDir = join(home, '.hermes', 'huaweicloud-plugins');
  const configPath = join(home, '.hermes', 'config.yaml');

  const install = runCli(home, cwd, ['install', '--target', 'hermes']);
  assert.equal(install.status, 0, install.stderr);

  const update = runCli(home, cwd, ['update', '--target', 'hermes']);
  assert.equal(update.status, 0, update.stderr);
  assertPayloadInstalled(pluginDir);
  const config = readFileSync(configPath, 'utf8');
  assert.match(config, /huaweicloud-devkit/);
  assert.match(config, /mcp-server\.js/);
  assert.ok(existsSync(join(pluginDir, 'hooks', 'huaweicloud-safety.mjs')), 'safety hook missing');
  assert.ok(
    existsSync(join(pluginDir, 'hooks', 'huaweicloud-telemetry.py')),
    'telemetry hook missing',
  );
});
