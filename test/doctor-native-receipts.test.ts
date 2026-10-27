import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseCoreSkillNames } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';
import { fixtureDir } from './fixture-dir.ts';
import { runDoctor, runInstall, realTree } from './doctor-helpers.ts';

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

// The DSH marketplace layout, as the postinstall really leaves it: no
// plugin dir, no CLI-written profile patch (the bundled patch DSH consumes
// never carries the CLI-managed block's markers), a receipt recording the
// package-root layout, and native copies the profile's postinstall placed.
// The staged package's core skill differs by one byte from the doctor CLI's
// own tree — the discriminating case: a comparator that reads the doctor's
// tree instead of the recorded package root would report divergence on a
// healthy install. Tampering a native copy must flip to the divergence
// warning with the marketplace remediation (update --target would refuse:
// there is no plugin dir to update).
test('doctor: DSH marketplace layout compares against the profile package, not the doctor CLI', () => {
  const home = fixtureDir('hwc-doctor-native-dsh-');
  const dshHome = fixtureDir('hwc-doctor-native-dshroot-');
  const pkg = fixtureDir('hwc-doctor-native-dshpkg-');
  const pkgSkills = join(pkg, 'plugins', 'huaweicloud-core', 'skills');
  cpSync(realTree, pkgSkills, { recursive: true });
  const doctored = `${readFileSync(join(pkgSkills, 'huaweicloud-core', 'SKILL.md'), 'utf8')}\n<!-- one byte older -->\n`;
  writeFileSync(join(pkgSkills, 'huaweicloud-core', 'SKILL.md'), doctored, 'utf8');
  const core = parseCoreSkillNames(readFileSync(join(pkgSkills, '.manifest.json'), 'utf8'));
  assert.ok(core, 'staged manifest core roster must parse');
  const nativeDir = join(dshHome, 'skills');
  for (const name of core) {
    cpSync(join(pkgSkills, name), join(nativeDir, name), { recursive: true });
  }
  writeFileSync(
    join(nativeDir, '.huaweicloud-devkit-native.json'),
    `${JSON.stringify(
      { names: [...core].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), layout: 'package-root', packageRoot: pkg },
      null,
      2,
    )}\n`,
  );
  const healthy = runDoctor(home, { DSH_HOME: dshHome });
  assert.ok(
    !healthy.includes('Native core skills') && !healthy.includes('stale native skill cop'),
    `a healthy marketplace install must raise no native warnings, got:\n${healthy}`,
  );

  writeFileSync(join(nativeDir, 'huaweicloud-safety', 'SKILL.md'), 'tampered\n', 'utf8');
  const tampered = runDoctor(home, { DSH_HOME: dshHome });
  assert.ok(
    tampered.includes('huaweicloud-safety diverges from the installed payload'),
    `missing divergence warn:\n${tampered}`,
  );
  assert.ok(
    tampered.includes('upgrade the huaweicloud-devkit package inside the DSH profile'),
    `the marketplace remediation must name the package upgrade, not update --target:\n${tampered}`,
  );
});

// Version skew: the payload's own manifest is the freshness roster, so a
// doctor CLI whose manifest knows a core skill the installed payload never
// claimed does not demand it per-agent. The native copy is removed too —
// with the copy present, a regressed roster (the CLI's own) would also stay
// silent, and the test would pass with the fix deleted.
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
  rmSync(join(home, '.config', 'opencode', 'skills', 'huaweicloud-safety'), { recursive: true, force: true });
  const stdout = runDoctor(home);
  assert.ok(!stdout.includes('Native core skills'), `unexpected native warning under skew:\n${stdout}`);
});

// Receipts whose maintainer this run cannot resolve — layout-less (written
// before the layout field existed) or a marketplace receipt whose root was
// dropped as malformed — get the hedge: the marketplace is named as a
// possible owner, scoped to the DSH row (the postinstall only ever writes
// ~/.dsh/skills; for every other row a layout-less receipt can only be a
// plugin-dir install and the precise remediation is correct). A corrupt
// receipt suppresses the orphan branch entirely — the corrupt-receipt
// warning carries the remediation, and for the DSH dir that warning names
// both remediations.
test('doctor: unresolved-layout receipts hedge on the dsh row only; corrupt receipts stay silent', () => {
  const core = parseCoreSkillNames(readFileSync(join(realTree, '.manifest.json'), 'utf8'));
  assert.ok(core, 'manifest core roster must parse');
  const sortedNames = [...core].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const mkNative = (fixture: string, receiptBody: string): string => {
    const h = fixtureDir(fixture);
    const dshHome = fixtureDir(`${fixture}-root-`);
    const nativeDir = join(dshHome, 'skills');
    for (const name of core) {
      cpSync(join(realTree, name), join(nativeDir, name), { recursive: true });
    }
    writeFileSync(join(nativeDir, '.huaweicloud-devkit-native.json'), receiptBody);
    return runDoctor(h, { DSH_HOME: dshHome });
  };

  const v1Out = mkNative('hwc-doctor-native-v1-', `${JSON.stringify({ names: sortedNames }, null, 2)}\n`);
  assert.ok(v1Out.includes('no resolvable layout'), `layout-less receipt must hedge:\n${v1Out}`);
  assert.ok(v1Out.includes('DSH profile'), `the hedge must name the marketplace owner:\n${v1Out}`);
  assert.ok(
    !v1Out.includes('present without an installed MCP server — re-run'),
    `the layout-converting remediation must not be the sole advice:\n${v1Out}`,
  );

  // A marketplace receipt whose packageRoot was dropped (relative here)
  // must hedge at least as strongly as the layout-less one.
  const rootlessOut = mkNative(
    'hwc-doctor-native-rootless-',
    JSON.stringify({ names: sortedNames, layout: 'package-root', packageRoot: 'relative/pkg' }),
  );
  assert.ok(rootlessOut.includes('no resolvable layout'), `rootless marketplace receipt must hedge:\n${rootlessOut}`);

  // A non-DSH row with a layout-less receipt: only the CLI ever wrote
  // there — the precise orphan message is correct, the DSH hedge is wrong.
  const home2 = fixtureDir('hwc-doctor-native-v1oc-');
  const ocNative = join(home2, '.config', 'opencode', 'skills');
  for (const name of core) {
    cpSync(join(realTree, name), join(ocNative, name), { recursive: true });
  }
  writeFileSync(
    join(ocNative, '.huaweicloud-devkit-native.json'),
    `${JSON.stringify({ names: sortedNames }, null, 2)}\n`,
  );
  const ocOut = runDoctor(home2);
  assert.ok(
    ocOut.includes(
      'Native core skills (OpenCode) present without an installed MCP server — re-run: npx huaweicloud-devkit install --target opencode',
    ),
    `the non-DSH row keeps the precise remediation:\n${ocOut}`,
  );
  assert.ok(!ocOut.includes('DSH profile'), `the DSH hedge must not fire for an OpenCode dir:\n${ocOut}`);

  const corruptOut = mkNative('hwc-doctor-native-cx-', '{"names": [torn');
  assert.ok(corruptOut.includes('unreadable native receipt'), `corrupt warning expected:\n${corruptOut}`);
  assert.ok(
    corruptOut.includes("re-run the DSH profile's package install or npx huaweicloud-devkit install"),
    `the corrupt warning on the DSH dir must name both remediations:\n${corruptOut}`,
  );
  assert.ok(
    !corruptOut.includes('present without an installed MCP server'),
    `a corrupt receipt must not orphan a marketplace install it cannot see:\n${corruptOut}`,
  );
});

// A torn or shape-broken receipt is visible: doctor warns instead of
// silently demoting the dir to residue treatment. The boundary is the
// shared module's — both broken shapes classify as corrupt.
test('doctor: unreadable native receipts warn, torn and shape-broken alike', () => {
  const home = fixtureDir('hwc-doctor-native-corrupt-');
  runInstall(home);
  const receiptPath = join(home, '.config', 'opencode', 'skills', '.huaweicloud-devkit-native.json');
  for (const shape of ['{"names": [torn', '{"names": null}']) {
    writeFileSync(receiptPath, shape);
    const stdout = runDoctor(home);
    assert.ok(stdout.includes('unreadable native receipt'), `missing corrupt-receipt warn for ${shape}:\n${stdout}`);
  }
});

// An installed payload whose plugin dir has dist/ but no skills/ (the
// interrupted-copyServerPayload crash shape): the global skills-tree check
// is a some() across candidates, so a healthy target masks the broken one —
// the per-target freshness pass must name it instead of silently skipping.
test('doctor: an installed payload without a skills tree warns per target', () => {
  const home = fixtureDir('hwc-doctor-native-brokenpayload-');
  runInstall(home);
  const wbPlugins = join(home, '.workbuddy', 'huaweicloud-plugins');
  const wbNative = join(home, '.workbuddy', 'skills');
  mkdirSync(join(wbPlugins, 'dist'), { recursive: true });
  writeFileSync(join(wbPlugins, 'dist', 'mcp-server.js'), 'x', 'utf8');
  const core = parseCoreSkillNames(readFileSync(join(realTree, '.manifest.json'), 'utf8'));
  assert.ok(core, 'manifest core roster must parse');
  for (const name of core) {
    cpSync(join(realTree, name), join(wbNative, name), { recursive: true });
  }
  writeFileSync(
    join(wbNative, '.huaweicloud-devkit-native.json'),
    `${JSON.stringify({ names: [...core].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }, null, 2)}\n`,
  );
  const stdout = runDoctor(home);
  assert.ok(stdout.includes('the installed payload has no skills tree'), `missing broken-payload warn:\n${stdout}`);
});

// A package without a skills tree: the skills-tree check FAILs and the
// native block warns — the diagnostic run must complete, not crash
// mid-stream at the core-roster read.
