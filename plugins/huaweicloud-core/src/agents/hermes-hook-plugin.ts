// The Hermes Python safety-hook plugin family, split out of
// agents/hermes-hooks.ts for the complex-file bar: the plugin.yaml +
// __init__.py writer (the v0.9.0+ enforcement path that loads
// huaweicloud-safety.py through importlib) and its remover. The config.yaml
// hooks block and allowlist live in agents/hermes-hooks.ts; the
// deploy/uninstall/status lifecycle stays in agents/hermes.ts.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hermesPluginsDir, hermesPythonPluginsDir, hermesSafetyPluginDir } from '../targets.ts';
import { pkgVersion } from '../install-payload.ts';

function hermesHookPluginInit(): string {
  const script = join(hermesPluginsDir(), 'hooks', 'huaweicloud-safety.py').replace(/\\/g, '/');
  return [
    'import importlib.util',
    '',
    `SAFETY_SCRIPT = ${JSON.stringify(script)}`,
    '',
    '',
    'def _load_safety():',
    '    spec = importlib.util.spec_from_file_location("huaweicloud_safety_hook", SAFETY_SCRIPT)',
    '    module = importlib.util.module_from_spec(spec)',
    '    spec.loader.exec_module(module)',
    '    return module',
    '',
    '',
    '_safety = _load_safety()',
    '',
    '',
    'def register(ctx):',
    '    ctx.register_hook("pre_tool_call", _check)',
    '',
    '',
    'def _check(tool_name=None, args=None, **kwargs):',
    '    if tool_name != "terminal":',
    '        return None',
    '    if not (isinstance(args, dict) and "command" in args):',
    '        return None',
    '    reason = _safety.evaluate(tool_name, args)',
    '    if reason:',
    '        return {"action": "block", "message": _safety.DENY_PREFIX + reason}',
    '    return None',
    '',
  ].join('\n');
}

export function ensureHermesHookPlugin(): boolean {
  const pluginDir = hermesSafetyPluginDir();
  const manifestPath = join(pluginDir, 'plugin.yaml');
  const initPath = join(pluginDir, '__init__.py');

  const manifest = [
    'name: huaweicloud-safety',
    `version: "${pkgVersion}"`,
    'description: Huawei Cloud safety pre_tool_call hook',
    'author: HuaweiCloud Mate',
    'provides_hooks:',
    '  - pre_tool_call',
    '',
  ].join('\n');
  const init = hermesHookPluginInit();

  const manifestCurrent = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  const initCurrent = existsSync(initPath) ? readFileSync(initPath, 'utf8') : '';
  if (manifestCurrent === manifest && initCurrent === init) {
    console.log(`  Hook plugin unchanged: ${pluginDir}`);
    return false;
  }

  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(manifestPath, manifest);
  writeFileSync(initPath, init);
  console.log(`  Hook plugin installed: ${pluginDir}`);
  return true;
}

export function removeHermesHookPlugin(): boolean {
  const pluginDir = hermesSafetyPluginDir();
  if (!existsSync(pluginDir)) return false;
  rmSync(pluginDir, { recursive: true, force: true });
  console.log(`  Removed hook plugin: ${pluginDir}`);
  const parent = hermesPythonPluginsDir();
  try {
    if (existsSync(parent) && readdirSync(parent).length === 0) {
      rmSync(parent, { recursive: true, force: true });
    }
  } catch {
    // best-effort cleanup: an empty parent dir left behind is harmless
  }
  return true;
}

export function hermesHookPluginInstalled(): boolean {
  return (
    existsSync(join(hermesSafetyPluginDir(), 'plugin.yaml')) && existsSync(join(hermesSafetyPluginDir(), '__init__.py'))
  );
}
