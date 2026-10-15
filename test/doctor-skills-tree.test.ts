import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { parseCoreSkillNames } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';
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

// A minimal fake-HOME env for doctor. Payload candidates resolve through
// os.homedir(), which reads USERPROFILE on Windows and HOME on POSIX — both
// must be redirected or the negative tests pass vacuously on Windows (the
// payload lands where doctor never looks). HERMES_HOME is the
// highest-priority override for the hermes payload dir and must be cleared
// or an ambient value leaks a real install into the candidates.
function doctorEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    // keep OfficeAce detection hermetic in automated environments (#654)
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
    ...extra,
  };
  delete env.ATOMCODE_HOME;
  delete env.HUAWEICLOUD_HOME;
  delete env.OFFICE_CLAW_CONFIG_ROOT;
  delete env.HERMES_HOME;
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
  // wraps them in color escapes). The escape is built from fromCharCode —
  // same idiom as dep-provision's stripAnsi — because eslint's
  // no-control-regex (rightly) flags control characters in regex literals.
  return (run.stdout ?? '').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

// A real install into the fake home, so the native freshness checks see an
// installed payload with receipt-managed native copies.
function runInstall(home: string): void {
  const run = spawnSync(process.execPath, [setupCli, 'install', '--target', 'opencode'], {
    encoding: 'utf8',
    env: doctorEnv(home),
    timeout: 180_000,
  });
  assert.ok(run.status === 0, `install failed: ${run.stderr}\n${run.stdout}`);
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

// A hollow claimed dir (name present, SKILL.md absent — the interrupted-copy
// / AV-quarantine shape) is a missing skill to the boot guard's listing, so
// doctor must reject it too: doctor's listing is the same shared predicate.
test('doctor: a payload with a hollow claimed dir fails the skills tree check', () => {
  const home = fixtureDir('hwc-doctor-hollow-');
  const payloadSkills = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills');
  mkdirSync(payloadSkills, { recursive: true });
  writePayloadTree(payloadSkills, allSkills);
  rmSync(join(payloadSkills, 'huawei-ecs', 'SKILL.md'));
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('[FAIL] Skills tree'), `expected the hollow dir to fail, got:\n${stdout}`);
});

// A symlinked stray dir with a SKILL.md is listable by the boot guard (which
// counts symlinks) and would be served ungated — doctor must see it too.
test(
  'doctor: a payload with a symlinked stray skill dir fails the skills tree check',
  { skip: process.platform === 'win32' },
  () => {
    const home = fixtureDir('hwc-doctor-link-');
    const payloadSkills = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills');
    const external = join(home, 'external', 'huawei-not-claimed');
    mkdirSync(payloadSkills, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'SKILL.md'), '---\nname: huawei-not-claimed\n---\n', 'utf8');
    writePayloadTree(payloadSkills, allSkills);
    symlinkSync(external, join(payloadSkills, 'huawei-not-claimed'));
    const stdout = runDoctor(home);
    assert.ok(stdout.includes('[FAIL] Skills tree'), `expected the symlinked stray to fail, got:\n${stdout}`);
  },
);

// --- Native core-skill disclosure checks ---

// A healthy install carries receipt-managed native copies equal to its
// payload: no native warning may appear.
test('doctor: healthy install raises no native core-skill warnings', () => {
  const home = fixtureDir('hwc-doctor-native-ok-');
  runInstall(home);
  const stdout = runDoctor(home);
  assert.ok(!stdout.includes('Native core skills'), `unexpected native warning:\n${stdout}`);
  assert.ok(!stdout.includes('stale native skill cop'), `unexpected stale warning:\n${stdout}`);
});

// Divergence and missing are the two drift shapes the freshness check
// exists for: an edited native copy and a deleted one both warn with the
// per-skill name and the remediation.
test('doctor: divergent and missing native core copies warn', () => {
  const home = fixtureDir('hwc-doctor-native-drift-');
  runInstall(home);
  const nativeDir = join(home, '.config', 'opencode', 'skills');
  writeFileSync(join(nativeDir, 'huaweicloud-core', 'SKILL.md'), 'stale\n', 'utf8');
  rmSync(join(nativeDir, 'huaweicloud-safety'), { recursive: true, force: true });
  const stdout = runDoctor(home);
  assert.ok(
    stdout.includes('huaweicloud-core diverges from the installed payload'),
    `missing divergence warn:\n${stdout}`,
  );
  assert.ok(stdout.includes('huaweicloud-safety missing'), `missing-copy warn:\n${stdout}`);
});

// Receipt-managed native copies with no installed server behind them are
// orphaned disclosure: content pointing at MCP tools nothing serves.
test('doctor: native copies without an installed server warn as orphans', () => {
  const home = fixtureDir('hwc-doctor-native-orphan-');
  runInstall(home);
  rmSync(join(home, '.config', 'opencode', 'huaweicloud-plugins'), { recursive: true, force: true });
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('without an installed MCP server'), `missing orphan warn:\n${stdout}`);
});

// officeace's dir is never a sync target: owned names there are foreign no
// matter what receipt a hand-crafted one claims, and warn as stale.
test('doctor: owned names in officeace native dir warn as stale', () => {
  const home = fixtureDir('hwc-doctor-native-officeace-');
  runInstall(home);
  const officeaceDir = join(home, '.office-claw', 'skills');
  mkdirSync(join(officeaceDir, 'huawei-ecs'), { recursive: true });
  writeFileSync(join(officeaceDir, 'huawei-ecs', 'SKILL.md'), '---\nname: huawei-ecs\n---\n', 'utf8');
  writeFileSync(join(officeaceDir, '.huaweicloud-devkit-native.json'), '{"names":["huawei-ecs"]}');
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('stale native skill cop'), `missing officeace stale warn:\n${stdout}`);
});

// --- Native core-skill disclosure checks (layout, skew, robustness) ---

// The DSH npm-in-profile layout: no plugin dir, payload served from the
// package root, native copies + receipt maintained by postinstall. Doctor
// must treat the patch configuration as installed-ness — a healthy
// marketplace install raises no orphan and no drift warning.
test('doctor: DSH package-root layout raises no native warnings', () => {
  const home = fixtureDir('hwc-doctor-native-dsh-');
  const dshHome = fixtureDir('hwc-doctor-native-dshroot-');
  const profileDir = join(dshHome, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
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
  const core = parseCoreSkillNames(readFileSync(join(realTree, '.manifest.json'), 'utf8'));
  assert.ok(core, 'manifest core roster must parse');
  const nativeDir = join(dshHome, 'skills');
  for (const name of core) {
    cpSync(join(realTree, name), join(nativeDir, name), { recursive: true });
  }
  writeFileSync(
    join(nativeDir, '.huaweicloud-devkit-native.json'),
    JSON.stringify({ names: [...core].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }, null, 2) + '\n',
  );
  const stdout = runDoctor(home, { DSH_HOME: dshHome });
  assert.ok(
    !stdout.includes('Native core skills'),
    `marketplace layout must not raise native warnings, got:\n${stdout}`,
  );
  assert.ok(!stdout.includes('stale native skill cop'), `unexpected stale warning:\n${stdout}`);
});

// Version skew: the payload's own manifest is the freshness roster, so a
// doctor CLI whose manifest knows a core skill the installed payload never
// claimed does not demand it per-agent — the payload's tree governs what
// its own disclosure should carry.
test('doctor: freshness roster comes from the payload manifest, not the CLI', () => {
  const home = fixtureDir('hwc-doctor-native-skew-');
  runInstall(home);
  const payloadManifest = JSON.parse(
    readFileSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills', '.manifest.json'), 'utf8'),
  );
  delete payloadManifest.packOf['huaweicloud-safety'];
  writeFileSync(
    join(home, '.config', 'opencode', 'huaweicloud-plugins', 'skills', '.manifest.json'),
    JSON.stringify(payloadManifest, null, 2),
  );
  const stdout = runDoctor(home);
  assert.ok(!stdout.includes('Native core skills'), `unexpected native warning under skew:\n${stdout}`);
});

// A torn receipt write is visible: doctor warns instead of silently
// demoting the dir to residue treatment.
test('doctor: an unreadable native receipt warns', () => {
  const home = fixtureDir('hwc-doctor-native-corrupt-');
  runInstall(home);
  writeFileSync(join(home, '.config', 'opencode', 'skills', '.huaweicloud-devkit-native.json'), '{"names": [torn');
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('unreadable native receipt'), `missing corrupt-receipt warn:\n${stdout}`);
});

// A package without a skills tree: the skills-tree check FAILs and the
// native block warns — the diagnostic run must complete, not crash
// mid-stream at the core-roster read.
test('doctor: missing skills tree fails the check without aborting the run', () => {
  const stage = fixtureDir('hwc-doctor-notree-pkg-');
  mkdirSync(join(stage, 'bin'), { recursive: true });
  cpSync(join(root, 'bin', 'setup.cjs'), join(stage, 'bin', 'setup.cjs'));
  cpSync(join(root, 'package.json'), join(stage, 'package.json'));
  cpSync(join(root, 'plugins', 'huaweicloud-core', 'dist'), join(stage, 'plugins', 'huaweicloud-core', 'dist'), {
    recursive: true,
  });
  // safety/ is read at module load (redactSecrets), so the staged package
  // must carry it; skills/ is the one deliberately absent dir.
  cpSync(join(root, 'plugins', 'huaweicloud-core', 'safety'), join(stage, 'plugins', 'huaweicloud-core', 'safety'), {
    recursive: true,
  });
  const home = fixtureDir('hwc-doctor-notree-home-');
  const run = spawnSync(process.execPath, [join(stage, 'bin', 'setup.cjs'), 'doctor'], {
    encoding: 'utf8',
    env: doctorEnv(home),
    timeout: 60_000,
  });
  assert.ok(run.status === 0 || run.status === 1, `doctor crashed: ${run.stderr}`);
  const stdout = (run.stdout ?? '').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  assert.ok(stdout.includes('[FAIL] Skills tree'), 'the skills-tree check must FAIL');
  assert.ok(stdout.includes('lacks usable core-pack info'), 'the native block must warn instead of aborting the run');
  assert.ok(!stdout.includes('skills tree missing at'), `the throw leaked into output:\n${stdout}`);
});
