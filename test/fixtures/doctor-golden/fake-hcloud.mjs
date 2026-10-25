#!/usr/bin/env node
// Deterministic hcloud stand-in for the doctor golden harness. The doctor
// probe resolves the binary through HCLOUD_BIN + HCLOUD_BIN_ARGS_JSON (the
// node-launch convention), so the golden env points HCLOUD_BIN at node and
// this file at args[0]: probeHcloud runs `node fake-hcloud.mjs version`.
// The version mirrors package.json's kooCliVersion so the paired-version
// mismatch warning stays silent; a kooCliVersion bump moves the (normalized)
// Version line only. Any other invocation fails loudly — a silent wrong
// answer would corrupt the golden.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '..', '..', '..', 'package.json'), 'utf8'));
const version = typeof pkg.kooCliVersion === 'string' && pkg.kooCliVersion ? pkg.kooCliVersion : '7.3.12';

if (process.argv[2] === 'version') {
  console.log(`Current version: ${version}`);
  process.exit(0);
}
console.error(`fake-hcloud: unsupported arguments: ${process.argv.slice(2).join(' ')}`);
process.exit(1);
