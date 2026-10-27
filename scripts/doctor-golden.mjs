#!/usr/bin/env node
// Capture / regenerate / diff the doctor goldens under
// test/fixtures/doctor-golden/. Usage:
//
//   node scripts/doctor-golden.mjs           capture into temp homes and diff
//                                           against the committed goldens
//   node scripts/doctor-golden.mjs --regen   re-capture and overwrite the
//                                           committed golden files
//
// The goldens pin `doctor` output byte-for-byte (after the documented
// normalization list in scripts/lib/doctor-golden.mjs) for three fixtures:
// (a) an empty fake HOME, (b) a fake HOME after a real
// `install --target opencode`, and (c) a fake HOME with hermes + officeace
// markers staged. Any unexplained diff is a behavior change; regenerating is
// only legitimate for a deliberate output change (or a pkgVersion bump, which
// the banner normalization already absorbs).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureEmptyHome,
  captureHermesOfficeace,
  captureOpencodeInstall,
  goldenFixturesDir,
  goldenNames,
} from './lib/doctor-golden.mjs';

const regen = process.argv.includes('--regen');

const fixtures = [
  { name: goldenNames.empty, capture: captureEmptyHome, label: 'a: empty fake HOME' },
  { name: goldenNames.opencodeInstall, capture: captureOpencodeInstall, label: 'b: opencode install' },
  { name: goldenNames.hermesOfficeace, capture: captureHermesOfficeace, label: 'c: hermes + officeace markers' },
];

let failures = 0;
for (const fixture of fixtures) {
  const home = mkdtempSync(join(tmpdir(), 'doctor-golden-'));
  let output;
  try {
    output = fixture.capture(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const goldenPath = join(goldenFixturesDir, fixture.name);
  if (regen) {
    writeFileSync(goldenPath, output, 'utf8');
    console.log(`[regen] ${fixture.label} -> ${goldenPath}`);
    continue;
  }
  let expected;
  try {
    expected = readFileSync(goldenPath, 'utf8');
  } catch {
    console.error(`[missing] ${fixture.label}: no golden at ${goldenPath} (run with --regen)`);
    failures++;
    continue;
  }
  if (output === expected) {
    console.log(`[ok] ${fixture.label} matches the golden`);
  } else {
    failures++;
    console.error(`[diff] ${fixture.label} diverges from the golden:`);
    const actualLines = output.split('\n');
    const expectedLines = expected.split('\n');
    for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i++) {
      if (actualLines[i] !== expectedLines[i]) {
        console.error(`  line ${i + 1}:`);
        console.error(`    golden: ${JSON.stringify(expectedLines[i])}`);
        console.error(`    actual: ${JSON.stringify(actualLines[i])}`);
      }
    }
  }
}
process.exit(failures > 0 ? 1 : 0);
