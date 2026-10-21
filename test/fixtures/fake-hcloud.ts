#!/usr/bin/env node
// Fake hcloud for E2E. Records EVERY invocation's argv to HCLOUD_FAKE_LOG
// (one JSON array per line — the assertion surface). Answers from
// HCLOUD_FAKE_SCRIPT (JSON: { responses: [{ argv, stdout, stderr, exitCode }],
// default? }, first element-wise-prefix hit wins) and otherwise falls back to
// the three hardcoded responses the auth/reconcile tests pin. A present but
// unparsable script fails loud (exit 2): that is a test-infra bug, not a
// case outcome. ESM.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const log = process.env.HCLOUD_FAKE_LOG || '/tmp/hcloud-fake.log';
const argv: string[] = process.argv.slice(2);

function record(args: string[]): void {
  const dir = dirname(resolve(log));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(log, JSON.stringify(args) + '\n');
}

record(argv);

interface FakeResponse {
  argv?: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

interface FakeScript {
  responses?: FakeResponse[];
  default?: FakeResponse;
}

function loadScript(): FakeScript | null {
  const scriptPath = process.env.HCLOUD_FAKE_SCRIPT;
  if (!scriptPath) return null;
  if (!existsSync(scriptPath)) {
    process.stderr.write(`HCLOUD_FAKE_SCRIPT not found: ${scriptPath}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(scriptPath, 'utf8')) as FakeScript;
  } catch (error) {
    process.stderr.write(`HCLOUD_FAKE_SCRIPT is not valid JSON: ${String(error)}\n`);
    process.exit(2);
  }
}

function prefixHit(prefix: string[] | undefined, candidate: string[]): boolean {
  return (
    Array.isArray(prefix) && prefix.length <= candidate.length && prefix.every((value, i) => value === candidate[i])
  );
}

const script = loadScript();
if (script && Array.isArray(script.responses)) {
  const hit = script.responses.find((r) => prefixHit(r.argv, argv));
  const chosen: FakeResponse | undefined = hit || script.default;
  if (chosen) {
    if (chosen.stderr) process.stderr.write(chosen.stderr);
    if (chosen.stdout) process.stdout.write(chosen.stdout);
    process.exit(typeof chosen.exitCode === 'number' ? chosen.exitCode : 0);
  }
}

// #920 test hook: simulate a KooCLI that reports "profile does not exist"
// on `configure delete` (nothing to clean) so tests can prove the persist
// path treats a missing profile as best-effort, not an error.
if (argv[0] === 'configure' && argv[1] === 'delete' && process.env.HCLOUD_FAKE_DELETE_ERROR === '1') {
  process.stderr.write('[USE_ERROR]: profile does not exist');
  process.exit(2);
}

// #920 semantics: implement `configure delete`/`configure set` against the
// REAL config path (HCLOUD_CONFIG_PATH, which the test harnesses point at the
// temp home) so tests can assert the END state of the profile purge, not just
// the call log. delete removes the named profile; set upserts the profile
// fields carried by the --cli-* flags. Field names mirror the fake config
// shape the reconcile tests already use (accessKeyId/secretAccessKey/…).
if (argv[0] === 'configure' && (argv[1] === 'delete' || argv[1] === 'set') && process.env.HCLOUD_CONFIG_PATH) {
  const configPath = process.env.HCLOUD_CONFIG_PATH;
  type FakeProfile = Record<string, string>;
  let raw: { current?: string; profiles?: FakeProfile[] };
  try {
    raw = existsSync(configPath)
      ? (JSON.parse(readFileSync(configPath, 'utf8')) as { current?: string; profiles?: FakeProfile[] })
      : {};
  } catch {
    raw = {};
  }
  const profiles: FakeProfile[] = Array.isArray(raw.profiles) ? raw.profiles : [];
  const flagMap: Record<string, string> = {
    '--cli-profile': 'name',
    '--cli-access-key': 'accessKeyId',
    '--cli-secret-key': 'secretAccessKey',
    '--cli-region': 'region',
    '--cli-project-id': 'projectId',
    '--cli-security-token': 'securityToken',
  };
  const fields: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    if (eq <= 0) continue;
    const flag = arg.slice(0, eq);
    const field = flagMap[flag];
    if (field) fields[field] = arg.slice(eq + 1);
  }
  const target = fields.name || raw.current || 'default';
  if (argv[1] === 'delete') {
    raw.profiles = profiles.filter((p) => p.name !== target);
  } else {
    const existing = profiles.find((p) => p.name === target);
    if (existing) Object.assign(existing, fields);
    else profiles.push({ name: target, ...fields });
    raw.profiles = profiles;
  }
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
  } catch {
    // config write is best-effort; the argv log above stays the fallback surface
  }
  process.exit(0);
}

if (argv[0] === 'version') {
  process.stdout.write(`KooCLI Fake ${process.env.HCLOUD_FAKE_VERSION || '7.2.12'}\n`);
  process.exit(0);
}
if (argv[0] === 'IAM' && argv[1] === 'KeystoneListProjects') {
  process.stdout.write(`${JSON.stringify({ projects: [{ id: 'proj-e2e-001', name: 'cn-north-4' }] })}\n`);
  process.exit(0);
}
process.exit(0);
