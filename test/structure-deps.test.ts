import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEPENDENCIES,
  DEPENDENCY_IDS,
  PACK_DEPENDENCIES,
  PACK_REQUIRES,
  PACK_USES,
  closeEnablement,
  parseDevkitPacks,
  requiredDependencies,
} from '../plugins/huaweicloud-core/src/lib/dependency-model.ts';
import { PACK_IDS } from '../plugins/huaweicloud-core/src/lib/pack-types.ts';
import { readSource } from './structure-helpers.ts';

test('auth/error-table is a zod-free, IO-free, sibling-free leaf (#900)', () => {
  const leaf = readSource(join('src', 'auth', 'error-table.ts'));
  // The leaf must import node builtins ONLY — it compiles into both the
  // zod-free setup-cli graph and the zod-bearing mcp-server graph.
  const imports = leaf.split('\n').filter((line) => line.startsWith('import '));
  assert.ok(imports.length >= 1, 'expected the node: builtin imports');
  for (const line of imports) {
    assert.match(line, /from 'node:/, `error-table.ts must import node builtins only: ${line}`);
  }
  // No relative imports of ANY depth (the leaf contract), no zod, no IO of any
  // kind (denylist widened past the obvious fs/spawn/fetch calls).
  assert.doesNotMatch(leaf, /from '\.\.?\//, 'error-table.ts must not import auth/ siblings');
  assert.doesNotMatch(leaf, /from 'zod'/);
  assert.doesNotMatch(
    leaf,
    /\b(readFileSync|writeFileSync|appendFileSync|existsSync|spawnSync|execSync|fetch|netConnect|readdirSync|statSync|rmSync|readFile|writeFile)\(/,
  );
});

test('auth init implements the #920 gates: shared purge seam, identity verification, exit codes', () => {
  const reconcile = readSource(join('src', 'auth', 'reconcile.ts'));
  const libCredentials = readSource(join('src', 'lib', 'credentials.ts'));
  // The auth CLI family moved out of setup-cli: the init flow lives in
  // auth/init-cli.ts, the profile helpers in auth/hcloud-profile.ts.
  const initCli = readSource(join('src', 'auth', 'init-cli.ts'));
  const hcloudProfile = readSource(join('src', 'auth', 'hcloud-profile.ts'));

  // The purge is ONE implementation in the shared module; both write paths
  // call it (auth init + the auth_switch persist tool path).
  assert.match(reconcile, /export function runHcloudProfileDelete\(profile: string\)/);
  assert.match(initCli, /import \{[^}]*runHcloudProfileDelete[^}]*\} from '\.\/reconcile\.ts'/);
  assert.match(libCredentials, /import \{[^}]*runHcloudProfileDelete[^}]*\} from '\.\.\/auth\/reconcile\.ts'/);

  // cmdAuthInit: purge before configure when no token; identity verification
  // (STS GetCallerIdentity + the APIGW.0301 output scan) gates the
  // "Credentials synchronized" claim; failure sets exitCode 1 and suppresses
  // the Next steps block; project-id failure escalates to ERROR.
  assert.match(initCli, /if \(!securityToken\) \{/);
  assert.match(hcloudProfile, /function verifyHcloudIdentity\(region: string\)/);
  assert.match(hcloudProfile, /\['STS', 'GetCallerIdentity'\]/);
  assert.match(hcloudProfile, /APIGW\\.0301\|Incorrect IAM authentication/);
  assert.match(initCli, /if \(identity\.ok\) \{\s*\n\s*console\.log\('\\nCredentials synchronized\.'\)/);
  assert.match(initCli, /process\.exitCode = 1;/);
  assert.match(initCli, /if \(process\.exitCode !== 1\) \{/);
  assert.match(initCli, /ERROR: Project ID not auto-set/);

  // The tool-side persist re-applies project-id after the purge wiped every
  // profile setting (the round-1 critical: rotation must not break
  // region-scoped calls).
  assert.match(
    libCredentials,
    /resolveAndApplyProjectId\(\{ region, profile: profile \?\? undefined \}\);/,
    'persistCredentials must re-apply project-id after the purge',
  );
});

test('ERROR_TABLE carries the #900 code set with executable actions', () => {
  const leaf = readSource(join('src', 'auth', 'error-table.ts'));
  for (const code of [
    'HDKIT_CRED_MISSING',
    'HDKIT_CRED_INVALID',
    'HDKIT_CRED_FORBIDDEN',
    'HDKIT_CRED_REGION_MISSING',
    'HDKIT_KOOCLI_NOT_READY',
    'HDKIT_PROJECT_ID_MISSING',
    'HDKIT_SYNC_SKIPPED_RUNTIME',
    'HDKIT_CRED_UNEXPECTED',
  ]) {
    assert.match(leaf, new RegExp(`^  ${code}: \\{`, 'm'), `${code} must be a table key`);
  }
  // CREDENTIAL_EXPIRED is the hcloud runner's result code for expired
  // platform-injected STS, NOT an onboarding/table state — it must stay out.
  assert.doesNotMatch(leaf, /CREDENTIAL_EXPIRED:\s*\{/);
  // Every action is a directly executable command, not English prose.
  for (const action of [
    'npx huaweicloud-devkit auth init',
    'npx huaweicloud-devkit auth status',
    'hcloud IAM KeystoneListProjects --cli-region=<region>',
    'hcloud configure set --cli-region=<region>',
    'npx huaweicloud-devkit install-hcloud',
    'hcloud configure set --cli-project-id=<id>',
    'huaweicloud_auth_switch action=clear',
    'hcloud <Service> <Op> --cli-debug=true',
  ]) {
    assert.ok(leaf.includes(`action: '${action}'`), `action must stay executable: ${action}`);
  }
});

test('doctor renders the pack-binary section from the dependency model', () => {
  const setupCli = readSource(join('src', 'setup-cli.ts'));
  // The pack-binary section moved with the packs family to
  // packs-cli/doctor.ts; the shell keeps the section call.
  const packsDoctor = readSource(join('src', 'packs-cli', 'doctor.ts'));
  assert.doesNotMatch(setupCli, /PACK_BINARIES|PackBinary/, 'doctor must not read the deleted binaries table');
  assert.match(
    packsDoctor,
    /requiredDependencies\(enabledPacksUnion\)/,
    'the section iterates requiredDependencies over the enabled union',
  );
  assert.match(packsDoctor, /sandbox-resident, not probed host-side/);
  assert.match(
    packsDoctor,
    /dep install \$\{id\}/,
    'the gateway WARNs point at dep install for the missing dependency',
  );
  assert.match(packsDoctor, /Object\.entries\(PACK_USES\)/, 'PACK_USES soft edges warn in the same section');
  assert.match(
    setupCli,
    /renderPacksDoctorSection\(ctx, packUnionReport\(\)\)/,
    'the doctor shell calls the packs section with the shared union derivation',
  );
  // The dedicated hcloud block stays the explicit plugin-level rule, never
  // derived from the dependency graph (see the section's comment).
  assert.match(setupCli, /check\('hcloud CLI installed'/, 'the dedicated hcloud check is untouched');
  // #900: the executable table action must never travel alone in the CLI
  // surfaces — the state-correct verbose guidance (hcloudProbeRaw) rides
  // alongside in doctor's FAIL/WARN blocks and the install banner. This
  // wiring was dropped once; a source pin keeps it from regressing again.
  assert.ok(
    (setupCli.match(/hcloudProbeRaw\(hcloudProbe\)/g) ?? []).length >= 5,
    'doctor + install banner must print hcloudProbeRaw next to every not-ready action',
  );
});

test('dependency model: catalog keyed by id, kinds pin the process model', () => {
  assert.deepEqual(
    Object.keys(DEPENDENCIES).sort((a, b) => a.localeCompare(b)),
    [...DEPENDENCY_IDS].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(DEPENDENCIES.devbridge.kind, 'sandbox-resident');
  assert.ok(!('resolution' in DEPENDENCIES.devbridge), 'sandbox-resident carries no host resolution');
  assert.ok(!('installPolicy' in DEPENDENCIES.devbridge), 'sandbox-resident carries no install policy');
  assert.equal(DEPENDENCIES.hcloud.kind, 'cli');
  assert.equal(DEPENDENCIES.hcloud.installPolicy, 'auto');
  assert.equal(DEPENDENCIES['open-mcp-gateway'].kind, 'managed-child');
  assert.equal(DEPENDENCIES['open-mcp-gateway'].installPolicy, 'prompt');
  assert.deepEqual(DEPENDENCIES['open-mcp-gateway'].supervision, {
    owner: 'mcp-server',
    spawn: 'lazy-on-first-call',
    lifetime: 'parent-stdin-pipe',
    escalation: 'sigterm-sigkill-3s',
    respawn: 'on-next-call',
  });
});

test('dependency model: pack edges are legal, core owns none, hcloud attributed to its consumers', () => {
  assert.deepEqual(
    Object.keys(PACK_DEPENDENCIES).sort((a, b) => a.localeCompare(b)),
    [...PACK_IDS].sort((a, b) => a.localeCompare(b)),
  );
  const used = new Set<string>();
  for (const [packId, deps] of Object.entries(PACK_DEPENDENCIES)) {
    for (const dep of deps) {
      assert.ok(
        (DEPENDENCY_IDS as readonly string[]).includes(dep),
        `${packId} -> ${dep} must be a declared dependency id`,
      );
      used.add(dep);
    }
  }
  assert.deepEqual(
    [...used].sort((a, b) => a.localeCompare(b)),
    [...DEPENDENCY_IDS].sort((a, b) => a.localeCompare(b)),
    'every dependency is required by at least one pack',
  );
  assert.deepEqual(
    PACK_DEPENDENCIES.core,
    [],
    'core owns no binary dependency: a core edge would auto-provision hcloud for CLI-less trims and block receipt-gated uninstall',
  );
  const hcloudConsumers = Object.entries(PACK_DEPENDENCIES)
    .filter(([, deps]) => (deps as readonly string[]).includes('hcloud'))
    .map(([packId]) => packId)
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(hcloudConsumers, ['auth', 'huaweicloud-cli', 'obs']);
});

test('dependency model: requires/uses edges are legal and requires is acyclic', () => {
  for (const table of [PACK_REQUIRES, PACK_USES]) {
    for (const [packId, deps] of Object.entries(table)) {
      for (const dep of deps as readonly string[]) {
        assert.ok((PACK_IDS as readonly string[]).includes(dep), `${packId} -> ${dep} must be a pack id`);
        assert.notEqual(dep, packId, 'no self edges');
      }
    }
  }
  const seen = new Set<string>();
  const stack = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (stack.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    stack.add(id);
    const edges = (PACK_REQUIRES as Record<string, readonly string[]>)[id] ?? [];
    const cyclic = edges.some((edge) => hasCycle(edge));
    stack.delete(id);
    return cyclic;
  };
  assert.ok(!(PACK_IDS as readonly string[]).some((id) => hasCycle(id)), 'PACK_REQUIRES must be acyclic');
  assert.deepEqual(PACK_USES.sandbox, ['discovery', 'obs']);
});

test('closeEnablement closes transitively and reports pulledBy', () => {
  const closure = closeEnablement(['obs'], (id) =>
    id === 'obs' ? ['auth', 'voucher'] : id === 'auth' ? ['discovery'] : [],
  );
  assert.deepEqual(
    [...closure.enabled].sort((a, b) => a.localeCompare(b)),
    ['auth', 'discovery', 'obs', 'voucher'],
  );
  assert.deepEqual(closure.pulledBy.get('auth'), ['obs']);
  assert.deepEqual(closure.pulledBy.get('voucher'), ['obs']);
  assert.deepEqual(closure.pulledBy.get('discovery'), ['auth']);
  assert.equal(closure.pulledBy.has('obs'), false);
  const cyclic = closeEnablement(['auth'], (id) => (id === 'auth' ? ['voucher'] : id === 'voucher' ? ['auth'] : []));
  assert.deepEqual(
    [...cyclic.enabled].sort((a, b) => a.localeCompare(b)),
    ['auth', 'voucher'],
  );
});

test('parseDevkitPacks is tolerant and defaults blank to the full surface', () => {
  for (const blank of [null, undefined, '', '   ']) {
    const parsed = parseDevkitPacks(blank);
    assert.equal(parsed.enabled.size, PACK_IDS.length);
    assert.deepEqual(parsed.unknown, []);
  }
  const parsed = parseDevkitPacks(' sandbox , bogus ');
  assert.deepEqual(parsed.unknown, ['bogus']);
  assert.deepEqual(
    [...parsed.enabled].sort((a, b) => a.localeCompare(b)),
    ['core', 'sandbox'],
  );
});

test('requiredDependencies unions pack edges; core alone requires nothing', () => {
  assert.deepEqual([...requiredDependencies(new Set(['core']))], []);
  assert.deepEqual(
    [...requiredDependencies(new Set(['huaweicloud-cli', 'auth', 'obs']))].sort((a, b) => a.localeCompare(b)),
    ['hcloud'],
  );
  assert.deepEqual([...requiredDependencies(new Set(['sandbox']))], ['devbridge']);
  assert.deepEqual([...requiredDependencies(new Set(['huaweicloud-open-mcp']))], ['open-mcp-gateway']);
});
