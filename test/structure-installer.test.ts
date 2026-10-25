import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { SUPPORTED_AGENT_TARGETS } from '../plugins/huaweicloud-core/src/auth/agent-registration.ts';
import { readSource } from './structure-helpers.ts';

test('agents/codearts.ts supports the codearts target end to end', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const targets = readSource(join('src', 'targets.ts'));
  const codearts = readSource(join('src', 'agents', 'codearts.ts'));
  // parseTarget accepts codearts
  assert.match(setup, /'codearts'/);
  // deploy (install+update) / uninstall / status functions exist
  assert.match(codearts, /async function deployCodeArts\(mode: DeployMode\)/);
  assert.match(codearts, /function uninstallCodeArts\(removeOwnedSkills: \(dir: string\) => number\)/);
  assert.match(codearts, /function codeartsStatus\(\)/);
  // path helpers for user-level and project-level codearts dirs
  assert.match(targets, /function codeartsSkillsDir\(\)/);
  assert.match(targets, /function codeartsMcpSettingsFile\(\)/);
  assert.match(targets, /function codeartsProjectSkillsDir\(\)/);
  assert.match(targets, /function codeartsProjectMcpSettingsFile\(\)/);
  assert.match(targets, /function codeartsPluginsDir\(\)/);
  // deploy ships the server payload (dist + safety + skills server data)
  // into the codearts plugin dir and registers both MCP configs
  assert.match(codearts, /async function deployCodeArts\(mode: DeployMode\): Promise<void> \{\s*\n\s*const pluginSrc/);
  assert.match(codearts, /copyServerPayload\(pluginDest\)/);
  assert.match(codearts, /registerCodeartsMcp\(codeartsMcpSettingsFile\(\)\)/);
  assert.match(codearts, /registerCodeartsMcp\(codeartsProjectMcpSettingsFile\(\)\)/);
  // MCP registration writes an enabled server with local mode env; the
  // ensureMcpServersConfig writer lives in mcp-config-io.ts (setup-cli calls
  // it through registerCodeartsMcp with enabledByDefault).
  const mcpConfigIo = readSource(join('src', 'mcp-config-io.ts'));
  assert.match(readSource(join('src', 'mcp-agent-config.ts')), /config\.mcpServers\['huaweicloud-devkit'\] = \{/);
  assert.match(codearts, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local'/);
  assert.match(mcpConfigIo, /entry\.enabled = true;/);
  // command dispatch covers codearts for install / uninstall / status
  const branches = setup.match(/target === 'codearts' \|\| target === 'all'/g);
  const installDispatch = setup.match(/shouldInstall\('codearts'\)/g);
  assert.ok(
    (branches?.length ?? 0) + (installDispatch?.length ?? 0) >= 3,
    `codearts dispatch branches: ${(branches?.length ?? 0) + (installDispatch?.length ?? 0)}`,
  );
  // .installed marker goes to the codearts plugins dir:
  // installMarkerDirForTarget is a PAYLOAD_TARGETS lookup (its own test pins
  // the derivation, every non-codex row, and codex's natural null).
  assert.match(setup, /function installMarkerDirForTarget\(target: string\)/);
  // The .installed marker is written at payload placement, inside
  // copyServerPayload — and only when the server itself shipped (skipDist
  // writes no marker: nothing will run from that dir to consume one).
  const payloadModuleMarker = readSource(join('src', 'install-payload.ts'));
  assert.match(
    payloadModuleMarker,
    /if \(!opts\.skipDist\) \{\s*\n\s*writeFileSync\(join\(pluginDest, '\.installed'\)/,
  );
  // doctor checks the skills tree inside installed plugin dirs, and native
  // skill dirs only for stale-copy detection. The tree check is set
  // equality against the shipped manifest (both directions — an extra dir
  // is as disqualifying as a missing one), and doctor's listing is the
  // shared SKILL.md-aware predicate from src/lib/skill-tree.ts — the same
  // membership the boot guard uses, so hollow claimed dirs count as
  // missing. The DSH package-root candidate is PLUGIN_ROOT itself because
  // serverSkillDirNames() appends 'skills' (bound by the dsh row's doctor
  // section in agents/dsh-patch.ts).
  const payloadModule = readSource(join('src', 'install-payload.ts'));
  const doctorPayloadModule = readSource(join('src', 'doctor-payload.ts'));
  assert.match(payloadModule, /return listSkillDirs\(join\(pluginDir, 'skills'\)\);/);
  assert.match(setup, /expectedSkills: shippedSkillRoster\(\)/);
  assert.match(doctorPayloadModule, /present\.size === expectedSkills\.length/);
  assert.match(doctorPayloadModule, /expectedSkills\.every\(\(name\) => present\.has\(name\)\)/);
  assert.match(
    readSource(join('src', 'agents', 'dsh-patch.ts')),
    /skillsTreeMatches\(PLUGIN_ROOT, shared\.expectedSkills\)/,
    'the DSH package-root candidate stays bound in the dsh row section',
  );
  assert.doesNotMatch(setup, /serverSkillCount\(dir\) >= 6/, 'count-floor doctor check must be gone');
  // doctor's native-dir check is the receipt-gated one: core names warn only
  // outside a dir a sync row manages, and a manifest without pack info warns
  // instead of crashing the diagnostic run.
  assert.match(payloadModule, /function tryCoreSkillNames\(\)/);
  assert.match(setup, /corePack: tryCoreSkillNames\(\)/);
  assert.match(readSource(join('src', 'doctor-native.ts')), /managedHere && corePack\.has\(entry\.name\)/);
  // The byte-equality comparator lives in the shared zod-free lib (doctor
  // and the install tests import the same one), not as a setup-cli local.
  assert.match(
    readSource(join('src', 'doctor-native.ts')),
    /import \{ skillTreeEquals \} from '\.\/lib\/skill-tree\.ts';/,
  );
  const skillTreeSrc = readSource(join('src', 'lib', 'skill-tree.ts'));
  assert.match(skillTreeSrc, /export function skillTreeEquals\(a: string, b: string\): boolean/);
  // help text documents the target
  assert.match(
    setup,
    /--target <opencode\|codex\|codearts\|codearts-work\|workbuddy\|dsh\|officeace\|hermes\|openclaw\|atomcode\|all>/,
  );
  assert.match(setup, /install --target codearts/);
});

// The native-disclosure wiring must stay table-driven: the cleanup/doctor
// scan list derives from the PAYLOAD_TARGETS nativeSkills rows (no second
// hand-maintained dir list), officeace stays the one explicit foreign
// detector, and the two deliberately native-copy-free rows keep absent
// nativeSkills fields.

test('nativeSkillDirs derives from PAYLOAD_TARGETS plus the officeace exception', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const payloadModule = readSource(join('src', 'install-payload.ts'));
  // The table binding stays in setup-cli (PAYLOAD_TARGETS lives there); the
  // derivation itself lives in the payload module, which takes the rows as
  // a parameter.
  const listBody = setup.match(/function nativeSkillDirs\(\): string\[\] \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(listBody.length > 0, 'nativeSkillDirs must exist');
  assert.match(listBody, /PAYLOAD_TARGETS/, 'the scan list binds to the table');
  assert.match(listBody, /officeaceSkillsDir\(\)/, 'officeace stays the explicit foreign detector');
  assert.doesNotMatch(listBody, /opencodeSkillsDir\(\)/, 'no hand-listed row dirs remain');
  const moduleBody = payloadModule.match(
    /export function nativeSkillDirs\(rows: readonly NativeSyncRow\[\], foreignScanDirs: readonly string\[\]\): string\[\] \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(moduleBody, 'the payload module owns the derivation');
  assert.match(moduleBody!, /rows\.flatMap/, 'the derivation walks the rows');
  assert.match(moduleBody!, /foreignScanDirs/, 'the foreign scan dirs join the walk');
  const officeaceRow = setup.match(/\{\s*id: 'officeace',[\s\S]*?\n {2}\},/)?.[0] ?? '';
  assert.ok(officeaceRow.length > 0, 'officeace row found');
  assert.doesNotMatch(officeaceRow, /nativeSkills/, 'officeace stays without native skill copies');
  const codexDesktopRow = setup.match(/\{\s*id: 'codex-desktop',[\s\S]*?\n {2}\},/)?.[0] ?? '';
  assert.ok(codexDesktopRow.length > 0, 'codex-desktop row found');
  assert.doesNotMatch(codexDesktopRow, /nativeSkills/, 'codex-desktop stays without native skill copies');
});

// opencode reads its config from XDG_CONFIG_HOME (default ~/.config). The
// installer's write root, the registration read, and the agent-presence
// probe must all derive from ONE shared resolver — three independent
// derivations is how "install green, agent blind" under a non-default
// XDG_CONFIG_HOME happened (each seam fixed separately drifted back).

test('opencode config root is XDG-aware through one shared resolver', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const targets = readSource(join('src', 'targets.ts'));
  const registration = readSource(join('src', 'auth', 'agent-registration.ts'));
  assert.match(
    registration,
    /export function xdgConfigHome\(\): string/,
    'the shared XDG root resolver must live in agent-registration.ts',
  );
  // The resolver honors absolute XDG_CONFIG_HOME only (spec: relative ignored).
  const resolverBody = registration.match(/export function xdgConfigHome\(\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(resolverBody.length > 0, 'xdgConfigHome body found');
  assert.match(resolverBody, /isAbsolute/);
  // Registration detection reads the shared root, not its own derivation.
  const registrationConfigFile =
    registration.match(/function opencodeConfigFile\(\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(registrationConfigFile.length > 0, 'agent-registration opencodeConfigFile found');
  assert.match(registrationConfigFile, /xdgConfigHome\(\)/);
  assert.doesNotMatch(registrationConfigFile, /homedir\(\)/, 'detection must not re-derive the default root');
  // The installer's configRoot delegates instead of re-deriving ~/.config.
  const configRootBody = targets.match(/function configRoot\(target = 'opencode'\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(configRootBody.length > 0, 'configRoot body found');
  assert.match(configRootBody, /xdgConfigHome\(\)/);
  assert.doesNotMatch(
    configRootBody,
    /homedir\(\)|'\.config'/,
    'configRoot must not re-derive the default root inline',
  );
  // Agent-presence detection probes the same root the installer writes.
  assert.match(
    readSource(join('src', 'install-plan.ts')),
    /\['opencode', \(\) => existsSync\(configRoot\('opencode'\)\)\]/,
    'detectAgents must probe the shared opencode config root',
  );
});

// Every supported target must have a cmdStatus section row — codex-desktop
// shipped for months as "install target exists, cmdStatus does not cover
// it" (the release smoke had to skip its status check), which is exactly
// the drift this invariant makes impossible for the next target.

test('cmdStatus covers every supported agent target', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const sectionsBody =
    setup.match(
      /const sections: Array<\{ name: string; run: \(\) => void; on: \(_target: string\) => boolean \}> = \[([\s\S]*?)\n {2}\];/,
    )?.[1] ?? '';
  assert.ok(sectionsBody.length > 0, 'cmdStatus sections array found');
  for (const id of SUPPORTED_AGENT_TARGETS) {
    assert.match(
      sectionsBody,
      new RegExp(`target === '${id}' \\|\\| target === 'all'`),
      `status must cover the ${id} target`,
    );
  }
});

test('tools.ts resolves skills from the server-relative tree only (dsh fallback removed)', () => {
  const tools = readSource(join('src', 'tools.ts'));
  // No DSH (or any agent) dir probing survives in the server: skills are
  // server data resolved next to dist/.
  assert.doesNotMatch(tools, /function dshSkillsDir\(\)/, 'dsh dir probe must be gone');
  assert.match(tools, /const SKILLS_ROOT = join\(__dirname, '\.\.', 'skills'\);/);
  // The agent-target list moved to the zod schema descriptions when the
  // JSON-Schema registry was replaced, and into the auth pack when the
  // schemas were materialized per pack (src/packs/auth/tools.ts).
  const authPack = readSource(join('src', 'packs', 'auth', 'tools.ts'));
  assert.match(
    authPack,
    /opencode, codex, codex-desktop, codearts, codearts-work, workbuddy, dsh, officeace, hermes, openclaw, atomcode, or all/,
  );
});

test('agents/officeace.ts keeps officeace capability cleanup (no native skill registration)', () => {
  const officeace = readSource(join('src', 'agents', 'officeace.ts'));
  assert.match(officeace, /function removeOfficeaceSkillCapabilities\(\)/);
  assert.match(readSource(join('src', 'officeace-paths.ts')), /export function officeaceSkillsDir\(\)/);
});

test('agents/officeace.ts supports the officeace target end to end', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  // The officeace module family: the capabilities-root path family lives in
  // officeace-paths.ts (the shared leaf), the sqlite module surface + readers
  // in agents/officeace-sqlite.ts, the connector-row write/remove in
  // agents/officeace-registry.ts, the lifecycle in agents/officeace.ts.
  const officeace = readSource(join('src', 'agents', 'officeace.ts'));
  const officeacePaths = readSource(join('src', 'officeace-paths.ts'));
  const officeaceSqlite = readSource(join('src', 'agents', 'officeace-sqlite.ts'));
  const officeaceRegistry = readSource(join('src', 'agents', 'officeace-registry.ts'));
  assert.match(setup, /'officeace'/);
  assert.match(officeace, /async function installOfficeAce\(\)/);
  assert.match(officeace, /function uninstallOfficeAce\(removeOwnedSkills: \(dir: string\) => number\)/);
  assert.match(officeace, /function officeaceStatus\(\)/);
  assert.match(officeace, /async function updateOfficeAce\(\)/);
  assert.match(officeacePaths, /function officeaceCapabilitiesDir\(\)/);
  assert.match(officeacePaths, /function officeaceCapabilitiesFile\(\)/);
  assert.match(officeacePaths, /function officeaceSkillsDir\(\)/);
  assert.match(officeacePaths, /function officeacePluginsDir\(\)/);
  // The registry probe is shared with the MCP-side detection
  // (auth/agent-registration.ts) through officeace-paths.ts.
  assert.match(officeacePaths, /export function readOfficeaceRegistryInstallDir\(\)/);
  assert.match(officeacePaths, /export function probeOfficeaceSystemDirs\(/);
  assert.match(officeaceRegistry, /function ensureOfficeaceMcpInSqlite\(\)/);
  assert.match(officeaceRegistry, /function removeOfficeaceMcpFromSqlite\(\)/);
  // Native skill registration is gone; install/update actively clean the
  // capabilities entries older versions wrote.
  assert.doesNotMatch(officeace, /registerOfficeaceSkillEntries/, 'no native skill registration');
  assert.match(officeace, /copyServerPayload\(pluginDest\)/);
  assert.match(officeace, /removeOfficeaceSkillCapabilities\(\)/);
  assert.match(officeaceRegistry, /existing\.command === 'node'/);
  assert.match(officeace, /capabilities\.json/);
  const branches = setup.match(/target === 'officeace' \|\| target === 'all'/g);
  const installDispatch = setup.match(/shouldInstall\('officeace'\)/g);
  assert.ok(
    (branches?.length ?? 0) + (installDispatch?.length ?? 0) >= 3,
    `officeace dispatch branches: ${(branches?.length ?? 0) + (installDispatch?.length ?? 0)}`,
  );
  assert.match(setup, /install --target officeace/);
  // The sqlite reader stays exported for the packs slot read.
  assert.match(officeaceSqlite, /export function readOfficeaceDevkitPacks\(\)/);
});

test('agents/hermes.ts supports the hermes target end to end', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const targets = readSource(join('src', 'targets.ts'));
  // The hermes module family: the lifecycle + SDK live in hermes.ts, the
  // config.yaml mcp_servers block family in hermes-config.ts, and the
  // hooks/allowlist/plugin family in hermes-hooks.ts (the complex-file split).
  const hermes = readSource(join('src', 'agents', 'hermes.ts'));
  const hermesConfig = readSource(join('src', 'agents', 'hermes-config.ts'));
  const hermesHooks = readSource(join('src', 'agents', 'hermes-hooks.ts'));
  const hermesHookPlugin = readSource(join('src', 'agents', 'hermes-hook-plugin.ts'));
  assert.match(setup, /'hermes'/);
  assert.match(hermes, /async function deployHermes\(mode: DeployMode\)/);
  assert.match(hermes, /function uninstallHermes\(removeOwnedSkills: \(dir: string\) => number\)/);
  assert.match(hermes, /function hermesStatus\(\)/);
  assert.match(targets, /function hermesHomeDir\(\)/);
  assert.match(targets, /function hermesSkillsDir\(\)/);
  assert.match(targets, /function hermesPluginsDir\(\)/);
  assert.match(targets, /function hermesConfigFile\(\)/);
  assert.match(hermesConfig, /function ensureHermesMcpConfig\(\)/);
  assert.match(hermesConfig, /function removeHermesMcpConfigBlock\(\)/);
  assert.match(hermesHooks, /function ensureHermesHooksConfig\(\)/);
  assert.match(hermesHooks, /function removeHermesHooksConfigBlock\(\)/);
  assert.match(hermesHooks, /function ensureHermesHookAllowlist\(\)/);
  assert.match(hermesHooks, /function hermesHookCommand\(\)/);
  assert.match(hermesHookPlugin, /function ensureHermesHookPlugin\(\)/);
  assert.match(hermesHookPlugin, /function removeHermesHookPlugin\(\)/);
  assert.match(targets, /function hermesPythonPluginsDir\(\)/);
  assert.match(targets, /function hermesSafetyPluginDir\(\)/);
  assert.match(hermes, /copyServerPayload\(pluginDest, \{ skipDist: skipMcp \}\)/);
  assert.match(hermes, /copyDir\(hooksDir, join\(pluginDest, 'hooks'\)\)/);
  assert.match(hermes, /ensureHermesMcpConfig\(\)/);
  assert.match(hermes, /ensureHermesHooksConfig\(\)/);
  assert.match(hermes, /ensureHermesHookAllowlist\(\)/);
  assert.match(hermes, /ensureHermesHookPlugin\(\)/);
  assert.match(hermesConfig, /mcp_servers:/);
  assert.match(hermesConfig, /huaweicloud-devkit:/);
  assert.match(hermesConfig, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"/);
  assert.match(hermesHooks, /hooks:/);
  assert.match(hermesHooks, /pre_tool_call:/);
  assert.match(hermesHooks, /matcher: "terminal"/);
  assert.match(hermesHooks, /fail_closed: true/);
  assert.match(hermesHooks, /shell-hooks-allowlist\.json/);
  assert.match(hermesHookPlugin, /name: huaweicloud-safety/);
  assert.match(hermesHookPlugin, /register_hook\("pre_tool_call"/);
  assert.match(hermesHookPlugin, /evaluate\(tool_name, args\)/);
  assert.match(hermesHooks, /huaweicloud-safety\.py/);
  const branches = setup.match(/target === 'hermes' \|\| target === 'all'/g);
  const installDispatch = setup.match(/shouldInstall\('hermes'\)/g);
  assert.ok(
    (branches?.length ?? 0) + (installDispatch?.length ?? 0) >= 3,
    `hermes dispatch branches: ${(branches?.length ?? 0) + (installDispatch?.length ?? 0)}`,
  );
  assert.match(setup, /install --target hermes/);
  assert.match(targets, /HERMES_HOME/);
  // The Windows Program Files probe (LOCALAPPDATA bases) lives in the shared
  // officeace-paths probe, not setup-cli.
  assert.match(readSource(join('src', 'officeace-paths.ts')), /LOCALAPPDATA/);
  assert.match(hermes, /--skip-mcp-server/);
  assert.match(readSource(join('src', 'agents', 'hermes-sdk.ts')), /function ensureHermesMcpSdk\(\)/);
  assert.match(readSource(join('src', 'agents', 'hermes-sdk.ts')), /function hermesMcpSdkOk\(\)/);
});

test('PAYLOAD_TARGETS is the single id→dir map for payload targets', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  // The marker-dir function is a lookup over the table, not a second hand
  // list — the atomcode/openclaw drift class dies only if the lookup stays
  // derived.
  const markerFn = setup.match(/function installMarkerDirForTarget\(target: string\): string \| null \{[\s\S]*?\n\}/);
  assert.ok(markerFn, 'installMarkerDirForTarget must exist');
  assert.match(markerFn[0], /PAYLOAD_TARGETS\.find\(\(t\) => t\.id === target\)\?\.dir\(\) \?\? null/);
  assert.doesNotMatch(markerFn[0], /target === '/);
  // Every non-codex supported target has a table row: doctor's payload
  // checks, the marker dir, willPlacePayload, and the update dispatch all
  // follow the table, so a missing row silently drops a target everywhere.
  const table = setup.match(/const PAYLOAD_TARGETS: readonly PayloadTarget\[\] = \[[\s\S]*?\n\];/);
  assert.ok(table, 'PAYLOAD_TARGETS table must exist');
  for (const id of SUPPORTED_AGENT_TARGETS) {
    if (id === 'codex') continue;
    assert.match(table[0], new RegExp(`\\bid: '${id}',`), `${id} must have a PAYLOAD_TARGETS row`);
  }
  // Table-driven doctor shape: every payload row binds a doctor section, so
  // a new row cannot appear without its payload-triple + native-freshness
  // coverage (the atomcode undici / openclaw-wide drift class, now pinned
  // per row). The generic rows bind payloadDoctorSection; agent-owned
  // overrides must come from the owning agents module (dsh's package-root
  // candidate is the precedent).
  const rows = table[0]!.split(/\n {2}\},/);
  assert.ok(rows.length >= 10, `expected the payload rows, found ${rows.length}`);
  for (const row of rows) {
    const id = /\bid: '([a-z-]+)',/.exec(row)?.[1];
    if (!id) continue;
    const binding = /doctor: ([A-Za-z]+),/.exec(row)?.[1];
    assert.ok(binding, `${id} row must bind a doctor section`);
    if (id === 'dsh') {
      assert.equal(binding, 'dshPayloadDoctorSection', 'the dsh row binds its agent-owned section');
    } else {
      assert.equal(binding, 'payloadDoctorSection', `${id} row binds the generic payload section`);
    }
  }
  assert.match(readSource(join('src', 'doctor-payload.ts')), /export function payloadDoctorSection\(/);
  assert.match(readSource(join('src', 'agents', 'dsh-patch.ts')), /export function dshPayloadDoctorSection\(/);
  // The reporter contract is the sections' only emission path.
  assert.match(readSource(join('src', 'doctor-report.ts')), /export interface DoctorReporter/);
});

// The MCP-configured chain is table-driven over agent-owned candidates: the
// shell keeps the chain driver and the check line, and every candidate
// (the config-file knowledge) lives in the agent module that owns the file
// it reads — in a fixed order, so a new agent joins by exporting its
// candidate and adding it here, not by growing an inline probe.
test('the doctor MCP-configured chain covers every agent-owned candidate', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const driver = setup.match(
    /let mcpCfgTarget: string \| null = null;\n {2}for \(const candidate of \[([\s\S]*?)\]\) \{/,
  );
  assert.ok(driver, 'the chain driver must exist in cmdDoctor');
  const chain = driver[1]!;
  const candidates = [
    ['opencodeDoctorMcpConfigured', 'agents/opencode.ts'],
    ['codexDesktopDoctorMcpConfigured', 'agents/codex-desktop.ts'],
    ['codeartsDoctorMcpConfigured', 'agents/codearts.ts'],
    ['codeartsWorkDoctorMcpConfigured', 'agents/codearts-work.ts'],
    ['workbuddyDoctorMcpConfigured', 'agents/workbuddy.ts'],
    ['dshDoctorMcpConfigured', 'agents/dsh-patch.ts'],
    ['officeaceDoctorMcpConfigured', 'agents/officeace.ts'],
    ['hermesDoctorMcpConfigured', 'agents/hermes.ts'],
    ['atomcodeDoctorMcpConfigured', 'agents/atomcode.ts'],
    ['openclawDoctorMcpConfigured', 'agents/openclaw.ts'],
  ] as const;
  for (const [name, module] of candidates) {
    assert.match(chain, new RegExp(`\\b${name},`), `${name} must sit in the chain, in order`);
    assert.match(
      readSource(join('src', module)),
      new RegExp(`export function ${name}\\(\\): string \\| null`),
      `${name} must be exported by ${module}`,
    );
  }
  // The chain short-circuits on the first hit, like the inline guards did.
  assert.match(setup, /if \(mcpCfgTarget !== null\) break;/);
});

test('tools.ts no longer probes hermes/atomcode native skill dirs', () => {
  const tools = readSource(join('src', 'tools.ts'));
  assert.doesNotMatch(tools, /function hermesSkillsDir\(\)/, 'hermes dir probe must be gone');
  assert.doesNotMatch(tools, /function atomcodeSkillsDir\(\)/, 'atomcode dir probe must be gone');
  assert.match(tools, /const SKILLS_ROOT = join\(__dirname, '\.\.', 'skills'\);/);
});
