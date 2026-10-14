import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { fixtureDir } from './fixture-dir.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const distSetup = join(root, 'plugins', 'huaweicloud-core', 'dist', 'setup-cli.js');
const realTree = join(root, 'plugins', 'huaweicloud-core', 'skills');

const allSkills = [...new Set(PACKS.flatMap((pack) => pack.skills))];

// Doctor needs the built CLI and the generated tree (its roster of record is
// the shipped manifest); one guided precondition instead of raw failures.
assert.ok(existsSync(distSetup) && existsSync(realTree), 'dist/ and skills/ missing — run: npm run build');

// A minimal fake-HOME env for doctor: unlike the installer tests there is no
// Windows profile mirroring to do — doctor only resolves paths from HOME and
// DSH_HOME — so this stays deliberately narrower than agent-install's
// makeEnv and must not converge back onto it (the jscpd gate).
function doctorEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    // keep OfficeAce detection hermetic in automated environments (#654)
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
    ...extra,
  };
  delete env.ATOMCODE_HOME;
  delete env.HUAWEICLOUD_HOME;
  delete env.OFFICE_CLAW_CONFIG_ROOT;
  if (!('DSH_HOME' in extra)) delete env.DSH_HOME;
  return env;
}

function runDoctor(home: string, extra: Record<string, string> = {}): string {
  const run = spawnSync(process.execPath, [setupCli, 'doctor'], {
    encoding: 'utf8',
    env: doctorEnv(home, extra),
    timeout: 60_000,
  });
  // exit 1 is the healthy "some check failed" path (a fake HOME has no
  // installs); only a crash or timeout aborts the test.
  assert.ok(run.status === 0 || run.status === 1, `doctor crashed: ${run.stderr}`);
  // Strip ANSI so [PASS]/[FAIL] assertions see the plain markers (check()
  // wraps them in color escapes).
  return (run.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

// An installed payload's skills/ dir, as copyServerPayload would have laid
// it out: one directory per skill, each with a SKILL.md.
function writePayloadTree(payloadSkills: string, names: string[]): void {
  for (const name of names) {
    mkdirSync(join(payloadSkills, name), { recursive: true });
    writeFileSync(join(payloadSkills, name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
  }
}

// The DSH package-root candidate: serverSkillDirNames() appends 'skills' to
// its argument, so the pushed candidate must be PLUGIN_ROOT itself. The
// pre-fix shape pushed PLUGIN_ROOT/skills and probed PLUGIN_ROOT/skills/skills
// — the fallback was inert and a DSH-only healthy install false-FAILED.
test('doctor: DSH layout resolves the skills tree from the package root', () => {
  const home = fixtureDir('hwc-doctor-dsh-home-');
  const dshHome = fixtureDir('hwc-doctor-dsh-');
  const profileDir = join(dshHome, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  // dshPatchConfigured() matches on these markers.
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      'id: huaweicloud-devkit',
      "require: '@deepseek-ai/dsh-mcp-client'",
      'serverName: huaweicloud',
      'id: huaweicloud-hook',
      '',
    ].join('\n'),
    'utf8',
  );
  const stdout = runDoctor(home, { DSH_HOME: dshHome });
  assert.ok(stdout.includes('[PASS] Skills tree'), `expected the DSH candidate to pass, got:\n${stdout}`);
});

// Equality, not subset: an installed payload carrying an unclaimed extra dir
// must FAIL — the boot guard (verifySkillTree) rejects extras, so doctor must
// never pass a tree the server would refuse to start.
test('doctor: a payload with an extra skill dir fails the skills tree check', () => {
  const home = fixtureDir('hwc-doctor-extra-');
  const payloadSkills = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills');
  mkdirSync(payloadSkills, { recursive: true });
  writePayloadTree(payloadSkills, [...allSkills, 'huawei-not-claimed']);
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('[FAIL] Skills tree'), `expected the extra dir to fail, got:\n${stdout}`);
});

test('doctor: a payload missing a claimed skill fails the skills tree check', () => {
  const home = fixtureDir('hwc-doctor-missing-');
  const payloadSkills = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills');
  mkdirSync(payloadSkills, { recursive: true });
  writePayloadTree(payloadSkills, allSkills.slice(0, -1));
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('[FAIL] Skills tree'), `expected the missing skill to fail, got:\n${stdout}`);
});
