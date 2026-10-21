#!/usr/bin/env node
// Fake hcloud whose `version` exits 1 with the privacy-agreement stderr —
// probeHcloud classifies privacy_pending (not ok), so syncAuth takes the
// !hcloud.ok branch and getAuthStatus surfaces kooCliRaw.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const log = process.env.HCLOUD_FAKE_LOG || '/tmp/hcloud-fake-privacy.log';
const dir = dirname(resolve(log));
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\n');
if (process.argv[2] === 'version') {
  process.stderr.write('请阅读并同意隐私声明\n');
  process.exit(1);
}
process.exit(0);
