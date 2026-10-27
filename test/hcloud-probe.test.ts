import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyHcloudProbe,
  hcloudProbeNextStep,
  hcloudProbeRaw,
} from '../plugins/huaweicloud-core/src/hcloud-probe.ts';
import { getKooCliVersion } from '../plugins/huaweicloud-core/src/koocli-version.ts';

test('hcloud probe classifies matching KooCLI version as ok', () => {
  const result = classifyHcloudProbe({ status: 0, stdout: `当前KooCLI版本:${getKooCliVersion()}`, stderr: '' });
  assert.equal(result.status, 'ok');
  assert.equal(result.installed, true);
  assert.equal(result.ok, true);
  assert.equal(result.versionMismatch, false);
});

test('hcloud probe classifies version mismatch separately from not installed', () => {
  const result = classifyHcloudProbe({ status: 0, stdout: '当前KooCLI版本:7.0.0', stderr: '' }, '7.2.12');
  assert.equal(result.status, 'version_mismatch');
  assert.equal(result.installed, true);
  assert.equal(result.ok, true);
  assert.equal(result.versionMismatch, true);
  // #900: top-level nextStep is an executable command; English detail only in raw.
  assert.match(hcloudProbeNextStep(result), /^npx /);
  assert.match(hcloudProbeRaw(result), /version mismatch/i);
});

test('hcloud probe classifies privacy agreement pending', () => {
  const result = classifyHcloudProbe({ status: 1, stdout: '', stderr: '请阅读并同意隐私声明' });
  assert.equal(result.status, 'privacy_pending');
  assert.equal(result.installed, true);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'HCLOUD_PRIVACY_PENDING');
  assert.match(hcloudProbeNextStep(result), /^npx /);
  assert.match(hcloudProbeRaw(result), /privacy/i);
});

test('hcloud probe classifies Codex Windows sandbox home failures', () => {
  const result = classifyHcloudProbe({ status: 1, stdout: '', stderr: '获取当前用户家目录失败' });
  assert.equal(result.status, 'sandbox_home_failure');
  assert.equal(result.installed, true);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'HCLOUD_SANDBOX_HOME_FAILURE');
  assert.match(hcloudProbeNextStep(result), /^npx /);
  assert.match(hcloudProbeRaw(result), /HCLOUD_BIN|Codex|sandbox/i);
});

test('hcloud probe classifies executable not found', () => {
  const result = classifyHcloudProbe({ error: { code: 'ENOENT' }, stdout: '', stderr: '' });
  assert.equal(result.status, 'not_found');
  assert.equal(result.installed, false);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'HCLOUD_NOT_FOUND');
  assert.match(hcloudProbeNextStep(result), /install-hcloud/i);
});

test('not_found nextStep is an executable command routed through ERROR_TABLE (#900)', () => {
  const result = classifyHcloudProbe({ error: { code: 'ENOENT' }, stdout: '', stderr: '' });
  const msg = hcloudProbeNextStep(result);
  // d11-41-nextstep-actionable: nextStep must start with npx/hcloud, not English prose.
  assert.match(msg, /^(npx |hcloud )/);
  assert.equal(msg, 'npx huaweicloud-devkit install-hcloud');
  assert.doesNotMatch(msg, /KooCLI is not installed/); // no English sentence at top level
  // Verbose English guidance lives only in the raw side-channel: background
  // auto-install may be running, fixed install dirs are picked up on the next
  // call (no restart), and the install log path is quoted for escalation.
  const raw = hcloudProbeRaw(result);
  assert.match(raw, /install-hcloud/i);
  assert.match(raw, /Background auto-install/);
  assert.match(raw, /no agent restart needed/);
  assert.match(raw, /koocli-install\.log/);
  assert.doesNotMatch(raw, /restart the agent/i);
});

test('ok probe nextStep is a directly callable tool name, not English prose (#900)', () => {
  const result = classifyHcloudProbe({ status: 0, stdout: `当前KooCLI版本:${getKooCliVersion()}`, stderr: '' });
  assert.equal(hcloudProbeNextStep(result), 'huaweicloud_show_profile_redacted');
  assert.match(hcloudProbeRaw(result), /huaweicloud_show_profile_redacted/);
});
