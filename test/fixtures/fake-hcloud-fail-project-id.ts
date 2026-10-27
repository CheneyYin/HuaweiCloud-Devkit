#!/usr/bin/env node
// Fake hcloud whose `configure set` fails with a project_id-bearing stderr —
// the #900 HDKIT_PROJECT_ID_MISSING routing fixture (syncAuth's projectIdCause
// heuristic greps the stderr for /project[_\s-]?id/i). Still answers `version`
// so the probe passes and the failure lands in the configure step.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const log = process.env.HCLOUD_FAKE_LOG || '/tmp/hcloud-fake-project-id.log';
if (process.argv[2] === 'configure') {
  const dir = dirname(resolve(log));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\n');
  process.stderr.write('invalid project id for region cn-north-4\n');
  process.exit(1);
}
if (process.argv[2] === 'version') {
  console.log('KooCLI Fake 7.3.12');
  process.exit(0);
}
process.exit(0);
