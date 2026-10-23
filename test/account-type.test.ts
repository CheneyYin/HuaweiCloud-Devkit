import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCallerIdentity,
  parseAuthDomains,
  judgeAccountType,
  checkAccountType,
} from '../plugins/huaweicloud-core/src/auth/account-type.ts';

// Real captured outputs from six live credentials (2026-10-19, issue #954):
// primary accounts keco_1919aa / hid_vlibzrkg26pz1mx, sub-users dingchunlei / zhangranran.
const IDENTITY_PRIMARY = `{
  "account_id": "63e30bd9d2924de6a750e428757181d7",
  "principal_urn": "iam::63e30bd9d2924de6a750e428757181d7:user:keco_1919aa",
  "principal_id": "238dc86558884141b3f739b65c944b93"
}`;
const IDENTITY_SUB = `{
  "account_id": "01a0472044487ddfa660f3203b2dfbaf",
  "principal_urn": "iam::01a0472044487ddfa660f3203b2dfbaf:user:dingchunlei",
  "principal_id": "01a0f03f15d573c3bfa71d62ca9dcd2b"
}`;
const IDENTITY_PRIMARY_HID = `{
  "account_id": "6c55c919e87a44deb5c4cb3f84e4466d",
  "principal_urn": "iam::6c55c919e87a44deb5c4cb3f84e4466d:user:hid_vlibzrkg26pz1mx",
  "principal_id": "5a5feed9f566417c9820c194f4eb839c"
}`;
const IDENTITY_SUB_ZHANG = `{
  "account_id": "019dd22c0e187ece844aa25a025fd36c",
  "principal_urn": "iam::019dd22c0e187ece844aa25a025fd36c:user:zhangranran",
  "principal_id": "019dd360e3d37763a871272cb0725e31"
}`;
const IDENTITY_AGENCY = `{
  "account_id": "6c55c919e87a44deb5c4cb3f84e4466d",
  "principal_urn": "sts::6c55c919e87a44deb5c4cb3f84e4466d::assumed-agency:myagency/session",
  "principal_id": "session"
}`;
const DOMAINS_PRIMARY = `{"domains":[{"id":"63e30bd9d2924de6a750e428757181d7","name":"keco_1919aa","enabled":true}]}`;
const DOMAINS_SUB = `{"domains":[{"id":"01a0472044487ddfa660f3203b2dfbaf","name":"es_hwcddbdt_OpenCapability_team","enabled":true}]}`;
const DOMAINS_PRIMARY_HID = `{"domains":[{"id":"6c55c919e87a44deb5c4cb3f84e4466d","name":"hid_vlibzrkg26pz1mx","enabled":true}]}`;
const DOMAINS_SUB_ZHANG = `{"domains":[{"id":"019dd22c0e187ece844aa25a025fd36c","name":"hwstaff_blue_dev","enabled":true}]}`;

test('parseCallerIdentity extracts username from user URNs and types agency URNs (#954)', () => {
  const identity = parseCallerIdentity(IDENTITY_SUB);
  assert.equal(identity.ok, true);
  if (identity.ok) {
    assert.equal(identity.urnType, 'user');
    assert.equal(identity.username, 'dingchunlei');
    assert.equal(identity.accountId, '01a0472044487ddfa660f3203b2dfbaf');
  }

  const agency = parseCallerIdentity(IDENTITY_AGENCY);
  assert.equal(agency.ok, true);
  if (agency.ok) {
    assert.equal(agency.urnType, 'agency');
    assert.equal(agency.username, undefined);
  }

  assert.equal(parseCallerIdentity('not json').ok, false);
  assert.equal(parseCallerIdentity('{"foo":1}').ok, false);
});

test('parseAuthDomains parses domains and rejects empty lists (#954)', () => {
  const domains = parseAuthDomains(DOMAINS_SUB);
  assert.equal(domains.ok, true);
  if (domains.ok) {
    assert.equal(domains.domains[0]!.name, 'es_hwcddbdt_OpenCapability_team');
  }

  assert.equal(parseAuthDomains('{"domains":[]}').ok, false);
  assert.equal(parseAuthDomains('garbage').ok, false);
});

test('judgeAccountType: username == domainName -> primary account (validated samples, #954)', () => {
  for (const [identityOut, domainsOut] of [
    [IDENTITY_PRIMARY, DOMAINS_PRIMARY],
    [IDENTITY_PRIMARY_HID, DOMAINS_PRIMARY_HID],
  ] as const) {
    const identity = parseCallerIdentity(identityOut);
    const domains = parseAuthDomains(domainsOut);
    assert.equal(identity.ok, true);
    assert.equal(domains.ok, true);
    if (!identity.ok || !domains.ok) continue;
    const result = judgeAccountType(identity, domains);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.applicable, true);
      assert.equal(result.isPrimaryAccount, true);
      assert.match(result.evidence ?? '', /username == domainName/);
    }
  }
});

test('judgeAccountType: username != domainName -> IAM sub-user (validated samples, #954)', () => {
  for (const [identityOut, domainsOut] of [
    [IDENTITY_SUB, DOMAINS_SUB],
    [IDENTITY_SUB_ZHANG, DOMAINS_SUB_ZHANG],
  ] as const) {
    const identity = parseCallerIdentity(identityOut);
    const domains = parseAuthDomains(domainsOut);
    assert.equal(identity.ok, true);
    assert.equal(domains.ok, true);
    if (!identity.ok || !domains.ok) continue;
    const result = judgeAccountType(identity, domains);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.applicable, true);
      assert.equal(result.isPrimaryAccount, false);
      assert.equal(typeof result.username, 'string');
      assert.equal(typeof result.domainName, 'string');
    }
  }
});

test('judgeAccountType: agency session credentials are not applicable (#954)', () => {
  const identity = parseCallerIdentity(IDENTITY_AGENCY);
  const domains = parseAuthDomains(DOMAINS_PRIMARY_HID);
  assert.equal(identity.ok, true);
  assert.equal(domains.ok, true);
  if (!identity.ok || !domains.ok) return;
  const result = judgeAccountType(identity, domains);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.applicable, false);
    assert.equal(result.isPrimaryAccount, undefined);
    assert.match(result.reason ?? '', /agency session/i);
  }
});

test('judgeAccountType: account_id not present in domains -> inconsistent error (#954)', () => {
  const identity = parseCallerIdentity(IDENTITY_SUB);
  const domains = parseAuthDomains(DOMAINS_PRIMARY);
  assert.equal(identity.ok, true);
  assert.equal(domains.ok, true);
  if (!identity.ok || !domains.ok) return;
  const result = judgeAccountType(identity, domains);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Inconsistent identity response/);
  }
});

test('checkAccountType orchestrates the two read-only calls end to end (#954)', async () => {
  // Drive through runHcloud's executable override — the fake-hcloud doctrine
  // the version-check tests use. The fake emits the two captured payloads.
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fixtureDir } = await import('./fixture-dir.ts');
  const dir = fixtureDir('account-type-orchestrator-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(
    script,
    `const args = process.argv.slice(2);
const op = args[1];
if (op === 'GetCallerIdentity') {
  console.log(${JSON.stringify(IDENTITY_SUB)});
} else if (op === 'KeystoneListAuthDomains') {
  console.log(${JSON.stringify(DOMAINS_SUB)});
} else {
  console.error('unexpected op: ' + op);
  process.exit(1);
}
`,
    'utf8',
  );
  // Set HCLOUD_BIN-style resolution via runHcloud's executable override —
  // checkAccountType calls runHcloud directly, so patch the probe chain via
  // the resolution seam the CLI exposes (executable/executableArgs ride the
  // resolveHcloudCommand chain).
  const { runHcloud } = await import('../plugins/huaweicloud-core/src/hcloud-cli.ts');
  const realRunHcloud = runHcloud;
  const mod = await import('../plugins/huaweicloud-core/src/auth/account-type.ts');
  // Monkey-patching a module export is brittle; instead drive via the same
  // seam runHcloud honors: HCLOUD_BIN pointing at a wrapper script.
  const wrapper = join(dir, 'hcloud-wrapper.mjs');
  writeFileSync(
    wrapper,
    `import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, [${JSON.stringify(script)}, ...process.argv.slice(2)], {
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
});
process.stdout.write(r.stdout ?? '');
process.exit(r.status ?? 1);
`,
    'utf8',
  );
  process.env.HCLOUD_BIN = process.execPath;
  process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([wrapper]);
  try {
    const result = (await mod.checkAccountType({})) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.applicable, true);
    assert.equal(result.isPrimaryAccount, false, 'dingchunlei is a sub-user');
    assert.equal(result.username, 'dingchunlei');
    assert.equal(result.domainName, 'es_hwcddbdt_OpenCapability_team');
    assert.match(String(result.evidence), /IAM user under the domain/);
  } finally {
    delete process.env.HCLOUD_BIN;
    delete process.env.HCLOUD_BIN_ARGS_JSON;
    void realRunHcloud;
  }
});
