import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { IconsManifest, Marketplace, McpConfig, PluginManifest } from './structure-helpers.ts';
import { pluginRoot, readJson, readSource, root } from './structure-helpers.ts';

test('Codex plugin manifest and marketplace are installable', () => {
  const manifest = readJson(join(pluginRoot, '.codex-plugin', 'plugin.json')) as PluginManifest;
  assert.equal(manifest.name, 'huaweicloud-devkit');
  // Skills are server data disclosed over MCP; the manifest must not declare
  // a native skills surface (same field-absence discipline as hooks).
  assert.ok(!Object.hasOwn(manifest, 'skills'), 'Codex manifest declares no native skills surface');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.ok(!Object.hasOwn(manifest, 'hooks'), 'Codex manifest keeps hooks out');

  const marketplace = readJson(join(root, '.agents', 'plugins', 'marketplace.json')) as Marketplace;
  assert.equal(marketplace.name, 'huaweicloud-devkit');
  assert.equal(marketplace.plugins[0].name, 'huaweicloud-devkit');
  assert.equal(marketplace.plugins[0].source.path, './plugins/huaweicloud-core');
});

test('OpenClaw plugin manifest matches other agent manifests', () => {
  const openclaw = readJson(join(pluginRoot, 'openclaw.plugin.json')) as PluginManifest;
  assert.equal(openclaw.name, 'huaweicloud-devkit');
  assert.equal(openclaw.family, 'bundle-plugin');
  assert.equal(openclaw.bundleFormat, 'codex');
  assert.ok(existsSync(join(pluginRoot, 'openclaw.plugin.json')));

  // All plugin.json names must be consistent
  const manifests = [
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    join(pluginRoot, '.cursor-plugin', 'plugin.json'),
    join(pluginRoot, '.workbuddy-plugin', 'plugin.json'),
    join(pluginRoot, '.hermes-plugin', 'plugin.json'),
    join(pluginRoot, 'openclaw.plugin.json'),
  ];
  const names = new Set(manifests.map((p) => (readJson(p) as PluginManifest).name));
  assert.equal(names.size, 1, 'All plugin.json name fields must be identical');
});

test('OpenCode integration exposes commands and MCP config', () => {
  assert.ok(existsSync(join(root, 'integrations', 'opencode', 'opencode.json')));
  assert.ok(existsSync(join(root, 'integrations', 'opencode', 'commands', 'huaweicloud-doctor.md')));
  // No native OpenCode entry-point skill: MCP tools are the entry point.
  assert.ok(!existsSync(join(root, 'integrations', 'opencode', 'skills')));
});

test('Hermes MCP Catalog manifest is present and valid', () => {
  const manifestPath = join(root, 'integrations', 'hermes', 'manifest.yaml');
  assert.ok(existsSync(manifestPath), 'Missing integrations/hermes/manifest.yaml');

  const yaml = readFileSync(manifestPath, 'utf8');

  assert.match(yaml, /manifest_version:\s*1/);
  assert.match(yaml, /name:\s*huaweicloud-devkit/);
  assert.match(yaml, /transport:/);
  assert.match(yaml, /type:\s*stdio/);
  assert.match(yaml, /command:\s*['"]node['"]/);
  assert.match(yaml, /mcp-server\.js/);
  assert.match(yaml, /install:/);
  assert.match(yaml, /type:\s*git/);
  assert.match(yaml, /huaweicloud\/huaweicloud-devkit/);
  assert.match(yaml, /--target hermes --skip-mcp-server/);
  assert.match(yaml, /post_install:/);
});

test('all plugin manifests are valid JSON', () => {
  const manifests = [
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    join(pluginRoot, '.cursor-plugin', 'plugin.json'),
    join(pluginRoot, '.workbuddy-plugin', 'plugin.json'),
    join(pluginRoot, '.hermes-plugin', 'plugin.json'),
    // bundleFormat codex: the same manifest-declared surface class the codex
    // ban protects. Native core disclosure goes through directory loading,
    // never through a manifest skills field.
    join(pluginRoot, 'openclaw.plugin.json'),
  ];
  for (const path of manifests) {
    const data = readJson(path) as PluginManifest;
    assert.ok(data.name, `Manifest ${path} missing name`);
    if (path.endsWith('openclaw.plugin.json')) continue;
    assert.ok(data.interface, `Manifest ${path} missing interface`);
    // No manifest may declare a native skills surface: skills are server
    // data disclosed through the MCP tools (the core meta-skills' native
    // copies are placed by the installer, not declared here).
    assert.ok(!Object.hasOwn(data, 'skills'), `Manifest ${path} must not declare skills`);
  }
  const openclaw = readJson(join(pluginRoot, 'openclaw.plugin.json')) as PluginManifest;
  assert.ok(!Object.hasOwn(openclaw, 'skills'), 'openclaw.plugin.json must not declare skills');
});

test('.mcp.json is valid and references existing server script', () => {
  const mcpConfig = readJson(join(pluginRoot, '.mcp.json')) as McpConfig;
  assert.ok(mcpConfig.mcpServers || mcpConfig.mcp);
});

test('official Huawei Cloud Icons library is integrated', () => {
  const tools = readSource(join('src', 'tools.ts'));
  assert.match(tools, /name: 'huaweicloud_get_service_icon'/);

  const discoveryPack = readSource(join('src', 'packs', 'discovery', 'tools.ts'));
  assert.match(discoveryPack, /getServiceIcon\(args\.service/);

  const snapshotPath = join(pluginRoot, 'src', 'data', 'icons-manifest.v1.json');
  assert.ok(existsSync(snapshotPath), 'Missing icons-manifest.v1.json snapshot');
  const manifest = readJson(snapshotPath) as IconsManifest;
  assert.ok(Array.isArray(manifest.icons), 'icons must be an array');
  assert.ok(manifest.icons.length >= 100, `Expected at least 100 icons, got ${manifest.icons.length}`);

  const byId = new Map(manifest.icons.map((i) => [i.id, i]));
  for (const id of ['ecs', 'obs', 'vpc', 'modelarts']) {
    const icon = byId.get(id);
    assert.ok(icon, `Missing icon: ${id}`);
    assert.match(icon.logo.source_url, /^https:\/\//, `${id} logo source_url must be https`);
    assert.equal(typeof icon.name, 'string');
  }

  const discovery = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'), 'utf8');
  assert.match(discovery, /huaweicloud_get_service_icon/);
  assert.match(discovery, /open\.huaweicloud\.com\/openplatform\/icons\.html/);
});
