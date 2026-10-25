// The permanent doctor golden pin: regenerates `doctor` output into a temp
// HOME under the same deterministic environment as scripts/doctor-golden.mjs
// (the harness in scripts/lib/doctor-golden.mjs is the single source of that
// env) and compares byte-for-byte against the committed goldens in
// test/fixtures/doctor-golden/. Any diff is a behavior change — either a
// defect, or a deliberate output change that regenerates the goldens via
// `node scripts/doctor-golden.mjs --regen` (the normalization list lives in
// the harness; a pkgVersion bump is already absorbed by it).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import {
  captureEmptyHome,
  captureHermesOfficeace,
  captureOpencodeInstall,
  goldenFixturesDir,
  goldenNames,
  root,
} from '../scripts/lib/doctor-golden.mjs';

// Doctor needs the built CLI and the generated tree; one guided precondition
// instead of raw failures.
assert.ok(
  existsSync(join(root, 'plugins', 'huaweicloud-core', 'dist', 'setup-cli.js')) &&
    existsSync(join(root, 'plugins', 'huaweicloud-core', 'skills')),
  'dist/ and skills/ missing — run: npm run build',
);

function expectGolden(name: string, actual: string): void {
  const expected = readFileSync(join(goldenFixturesDir, name), 'utf8');
  if (actual === expected) return;
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const firstDiff = actualLines.findIndex((line, i) => line !== expectedLines[i]);
  assert.fail(
    `doctor output diverged from the golden ${name} at line ${firstDiff + 1}:\n` +
      `  golden: ${JSON.stringify(expectedLines[firstDiff] ?? '<eof>')}\n` +
      `  actual: ${JSON.stringify(actualLines[firstDiff] ?? '<eof>')}\n` +
      '(defect, or deliberate output change — regenerate with node scripts/doctor-golden.mjs --regen)',
  );
}

// (a) The empty-HOME shape: every payload/config check FAILs, the hcloud
// block passes through the deterministic shim, the vault prints the env-tier
// PASS, and the packs section stays silent (no installed targets).
test('doctor golden: empty fake HOME', () => {
  const home = fixtureDir('hwc-golden-a-');
  expectGolden(goldenNames.empty, captureEmptyHome(home));
});

// (b) The healthy-install shape: a real `install --target opencode` (network
// for undici, the 240s class), then doctor — payload triple PASS, the seam
// check PASS (SEAM=on at both install and doctor time), no native warnings,
// the OpenCode packs INFO, the gateway not-found WARN, and the restart box.
test('doctor golden: fake HOME after install --target opencode', () => {
  const home = fixtureDir('hwc-golden-b-');
  expectGolden(goldenNames.opencodeInstall, captureOpencodeInstall(home));
});

// (c) The hermes + officeace markers shape: the officeace candidate wins the
// MCP-configured chain, the officeace payload row reads as installed (the
// dist marker) so the sqlite DEVKIT_PACKS read fires ("Packs (OfficeAce)"),
// the secrets-pack WARN (env-tier vault initialized, seed trimmed) fires,
// and the Hermes SDK check FAILs deterministically (python3 unreachable on
// the pinned PATH).
test('doctor golden: hermes + officeace markers staged', () => {
  const home = fixtureDir('hwc-golden-c-');
  expectGolden(goldenNames.hermesOfficeace, captureHermesOfficeace(home));
});
