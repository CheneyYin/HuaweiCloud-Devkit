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
  assert.match(setup, /config\.mcpServers\['huaweicloud-devkit'\] = \{/);
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
  // serverSkillDirNames() appends 'skills'.
  const payloadModule = readSource(join('src', 'install-payload.ts'));
  assert.match(payloadModule, /return listSkillDirs\(join\(pluginDir, 'skills'\)\);/);
  assert.match(setup, /const expectedSkills = shippedSkillRoster\(\);/);
  assert.match(setup, /present\.size === expectedSkills\.length/);
  assert.match(setup, /expectedSkills\.every\(\(name\) => present\.has\(name\)\)/);
  assert.match(setup, /skillsTreeDirs\.push\(PLUGIN_ROOT\)/);
  assert.doesNotMatch(setup, /serverSkillCount\(dir\) >= 6/, 'count-floor doctor check must be gone');
  // doctor's native-dir check is the receipt-gated one: core names warn only
  // outside a dir a sync row manages, and a manifest without pack info warns
  // instead of crashing the diagnostic run.
  assert.match(payloadModule, /function tryCoreSkillNames\(\)/);
  assert.match(setup, /const corePack = tryCoreSkillNames\(\);/);
  assert.match(setup, /managedHere && corePack\.has\(entry\.name\)/);
  // The byte-equality comparator lives in the shared zod-free lib (doctor
  // and the install tests import the same one), not as a setup-cli local.
  assert.match(setup, /import \{ skillTreeEquals \} from '\.\/lib\/skill-tree\.ts';/);
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
    setup,
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
  assert.match(officeace, /function officeaceSkillsDir\(\)/);
});

test('agents/officeace.ts supports the officeace target end to end', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const officeace = readSource(join('src', 'agents', 'officeace.ts'));
  assert.match(setup, /'officeace'/);
  assert.match(officeace, /async function installOfficeAce\(\)/);
  assert.match(officeace, /function uninstallOfficeAce\(removeOwnedSkills: \(dir: string\) => number\)/);
  assert.match(officeace, /function officeaceStatus\(\)/);
  assert.match(officeace, /async function updateOfficeAce\(\)/);
  assert.match(officeace, /function officeaceCapabilitiesDir\(\)/);
  assert.match(officeace, /function officeaceCapabilitiesFile\(\)/);
  assert.match(officeace, /function officeaceSkillsDir\(\)/);
  assert.match(officeace, /function officeacePluginsDir\(\)/);
  // The registry probe is shared with the MCP-side detection
  // (auth/agent-registration.ts) through officeace-paths.ts.
  const officeacePaths = readSource(join('src', 'officeace-paths.ts'));
  assert.match(officeacePaths, /export function readOfficeaceRegistryInstallDir\(\)/);
  assert.match(officeacePaths, /export function probeOfficeaceSystemDirs\(/);
  assert.match(officeace, /function ensureOfficeaceMcpInSqlite\(\)/);
  assert.match(officeace, /function removeOfficeaceMcpFromSqlite\(\)/);
  // Native skill registration is gone; install/update actively clean the
  // capabilities entries older versions wrote.
  assert.doesNotMatch(officeace, /registerOfficeaceSkillEntries/, 'no native skill registration');
  assert.match(officeace, /copyServerPayload\(pluginDest\)/);
  assert.match(officeace, /removeOfficeaceSkillCapabilities\(\)/);
  assert.match(officeace, /existing\.command === 'node'/);
  assert.match(officeace, /capabilities\.json/);
  const branches = setup.match(/target === 'officeace' \|\| target === 'all'/g);
  const installDispatch = setup.match(/shouldInstall\('officeace'\)/g);
  assert.ok(
    (branches?.length ?? 0) + (installDispatch?.length ?? 0) >= 3,
    `officeace dispatch branches: ${(branches?.length ?? 0) + (installDispatch?.length ?? 0)}`,
  );
  assert.match(setup, /install --target officeace/);
});

test('agents/hermes.ts supports the hermes target end to end', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const targets = readSource(join('src', 'targets.ts'));
  const hermes = readSource(join('src', 'agents', 'hermes.ts'));
  assert.match(setup, /'hermes'/);
  assert.match(hermes, /async function deployHermes\(mode: DeployMode\)/);
  assert.match(hermes, /function uninstallHermes\(removeOwnedSkills: \(dir: string\) => number\)/);
  assert.match(hermes, /function hermesStatus\(\)/);
  assert.match(targets, /function hermesHomeDir\(\)/);
  assert.match(targets, /function hermesSkillsDir\(\)/);
  assert.match(targets, /function hermesPluginsDir\(\)/);
  assert.match(targets, /function hermesConfigFile\(\)/);
  assert.match(hermes, /function ensureHermesMcpConfig\(\)/);
  assert.match(hermes, /function removeHermesMcpConfigBlock\(\)/);
  assert.match(hermes, /function ensureHermesHooksConfig\(\)/);
  assert.match(hermes, /function removeHermesHooksConfigBlock\(\)/);
  assert.match(hermes, /function ensureHermesHookAllowlist\(\)/);
  assert.match(hermes, /function hermesHookCommand\(\)/);
  assert.match(targets, /function hermesPythonPluginsDir\(\)/);
  assert.match(targets, /function hermesSafetyPluginDir\(\)/);
  assert.match(hermes, /function ensureHermesHookPlugin\(\)/);
  assert.match(hermes, /function removeHermesHookPlugin\(\)/);
  assert.match(hermes, /copyServerPayload\(pluginDest, \{ skipDist: skipMcp \}\)/);
  assert.match(hermes, /copyDir\(hooksDir, join\(pluginDest, 'hooks'\)\)/);
  assert.match(hermes, /ensureHermesMcpConfig\(\)/);
  assert.match(hermes, /ensureHermesHooksConfig\(\)/);
  assert.match(hermes, /ensureHermesHookAllowlist\(\)/);
  assert.match(hermes, /ensureHermesHookPlugin\(\)/);
  assert.match(hermes, /mcp_servers:/);
  assert.match(hermes, /huaweicloud-devkit:/);
  assert.match(hermes, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"/);
  assert.match(hermes, /hooks:/);
  assert.match(hermes, /pre_tool_call:/);
  assert.match(hermes, /matcher: "terminal"/);
  assert.match(hermes, /fail_closed: true/);
  assert.match(hermes, /shell-hooks-allowlist\.json/);
  assert.match(hermes, /name: huaweicloud-safety/);
  assert.match(hermes, /register_hook\("pre_tool_call"/);
  assert.match(hermes, /evaluate\(tool_name, args\)/);
  assert.match(hermes, /huaweicloud-safety\.py/);
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
  assert.match(hermes, /function ensureHermesMcpSdk\(\)/);
  assert.match(hermes, /function hermesMcpSdkOk\(\)/);
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
});

test('tools.ts no longer probes hermes/atomcode native skill dirs', () => {
  const tools = readSource(join('src', 'tools.ts'));
  assert.doesNotMatch(tools, /function hermesSkillsDir\(\)/, 'hermes dir probe must be gone');
  assert.doesNotMatch(tools, /function atomcodeSkillsDir\(\)/, 'atomcode dir probe must be gone');
  assert.match(tools, /const SKILLS_ROOT = join\(__dirname, '\.\.', 'skills'\);/);
});
