# REPORT-payload — install-payload.ts modularization (stable public face)

Branch `payload-split`, base `7e469857` (jscpd line). Fifth application of the
safety-policy re-export-face precedent (after REPORT-session.md,
REPORT-hcloud.md, the auth-split wave, and REPORT-upchk.md).

## Result

`plugins/huaweicloud-core/src/install-payload.ts` went from **644 lines /
jscpd cx 155** to a **63-line pure re-export face (cx 1)**; the internals
live in eight src/-ROOT-level `payload-*` family modules, every one below
the cx < 50 bar.

## Per-file final cx (`npx jscpd <file> --complexity --reporters ai`)

| File                            | Lines | cx  | Bar |
| ------------------------------- | ----- | --- | --- |
| `src/install-payload.ts` (face) | 63    | 1   | ✓   |
| `src/payload-utils.ts`          | 51    | 10  | ✓   |
| `src/payload-files.ts`          | 78    | 21  | ✓   |
| `src/payload-placement.ts`      | 107   | 9   | ✓   |
| `src/payload-roster.ts`         | 85    | 14  | ✓   |
| `src/payload-native-sync.ts`    | 110   | 28  | ✓   |
| `src/payload-native-clean.ts`   | 154   | 42  | ✓   |
| `src/payload-runtime-deps.ts`   | 68    | 20  | ✓   |
| `src/payload-status.ts`         | 53    | 11  | ✓   |

## Module map

- `src/payload-utils.ts` — the layout roots + version + small shared utils:
  the one-climb root-level `__dirname` derivation (PLUGIN_ROOT /
  PACKAGE_ROOT — depth-safe because the module sits at src/ ROOT level,
  never a subdir, never a two-level climb), pkgVersion, DeployMode /
  deployWord, errorMessage, sleepSync. The family leaf every sibling
  imports.
- `src/payload-files.ts` — the verified file operations: copyFileVerified
  (the retrying size-checked copy), mcpServerInstalled, copyDir,
  pruneStale, removeIfExists (the #556 retrying removal).
- `src/payload-placement.ts` — the server-payload placement: AGENT_RULES_FILE,
  injectAgentRules (the #758 injection) and copyServerPayload (the loud
  missing-source aborts for dist/ and skills/, the stale-name prune, the
  `.installed` restart marker written only when the server shipped).
- `src/payload-roster.ts` — the skills-roster readers: devkitOwnedSkillNames
  (the raw ownership manifest), shippedSkillRoster, tryCoreSkillNames /
  coreSkillNames (the null-vs-throw loudness pair), payloadCoreNames.
- `src/payload-native-sync.ts` — the native-disclosure placement family:
  NativeSyncRow, nativeSyncDirs, nativeSkillDirs (the rows+foreign-scan
  derivation), syncNativeSkillsForTarget, syncNativeCoreSkills (the
  remove-then-copy per-dir converge with the receipt rewrite).
- `src/payload-native-clean.ts` — the native-disclosure cleanup family:
  cleanupNativeDirs (the receipt-gated pre-install reconcile),
  removeHuaweiCommandsFrom (the huawei-prefix command sweep),
  removeOwnedSkillsFrom (the receipt-gated uninstall removal with the DSH
  marketplace attribution + liveness probe).
- `src/payload-runtime-deps.ts` — installRuntimeDeps (the npm spawn with
  the file-lock retry ladder); spawnErrorCode moved here as a
  family-internal function (never exported, never re-exported by the face).
- `src/payload-status.ts` — the status + residue family: serverSkillDirNames
  / serverSkillCount (the SKILL.md-aware listing), payloadStatusLines (the
  payload triple), removeSkillsDirIfEmpty.

Dependency DAG (all siblings at src/ ROOT level; no module imports the
face — verified by grep, zero import statements): utils (leaf) ← files ←
placement; utils + lib/skill-manifest ← roster; utils + files + roster +
lib/native-receipt ← native-sync; native-sync + roster + files +
lib/native-receipt ← native-clean; utils + lib/as-text ← runtime-deps;
files + lib/skill-tree ← status. No cycles (eslint import cycle check:
zero new warnings). The family feeds the UNBUNDLED `dist/setup-cli.js`
graph through the face; zod-free and SDK-free in every sibling, enforced
structurally — all eight joined the zod-free guarded list in
`test/structure-installer-cmds.test.ts` (one entry per sibling, added in
the same commit as the module).

## Public-surface verification

31/31 public names preserved (29 value + 2 type), same import path
`src/install-payload.ts` — verified mechanically per unit against the
pre-split export set (runtime `Object.keys(await import('dist/install-payload.js'))`
= 29/29, missing [] extra []) and at type level through every consumer
(typecheck covers all importers of `type DeployMode` / `NativeSyncRow`).
The face's re-exported bindings were additionally proven to be the very
module-instance bindings (`m.coreSkillNames === rosterModule.coreSkillNames`
etc. through the compiled dist tree), so no dual-instance state can drift.

Every declaration moved byte-identically (verified per unit with
declaration-range diffs of the base blob against each new home; the only
additions are the per-module header comments and re-export blocks, and the
declaration ORDER inside payload-native-sync.ts follows the brief's outline
— rows/dir-derivations/dispatch, then the per-dir sync). The one
deliberate transformation, non-observable: `spawnErrorCode` stays
unexported (it was module-internal in the base; it moved with its only
consumer into payload-runtime-deps.ts).

Direct importers were NOT rewritten (per the brief): src/doctor-payload.ts,
src/doctor-native.ts, the whole src/agents/ family, src/packs-cli/*,
src/lib/banner.ts, src/mcp-config-io.ts, src/auth/init-cli.ts, and
src/setup-cli.ts all keep importing `src/install-payload.ts`.

## Structure-guard retargets (same strength, canonical homes)

- `test/structure-load-path.test.ts` — the #758 agent-rules pins
  (injectAgentRules signature + call-site ordering, AGENT_RULES_FILE,
  rmSync/copyFileVerified lines, the missing-source abort) now read
  `src/payload-placement.ts`. Regexes unchanged.
- `test/structure-installer.test.ts` — the `.installed` marker pin reads
  `src/payload-placement.ts`; the tryCoreSkillNames pin reads
  `src/payload-roster.ts`; the serverSkillDirNames listSkillDirs pin reads
  `src/payload-status.ts`; the nativeSkillDirs module-body pin (signature +
  rows.flatMap + foreignScanDirs) reads `src/payload-native-sync.ts`.
  Regexes unchanged.
- `test/structure-installer-cmds.test.ts` — the syncNativeCoreSkills pin
  reads `src/payload-native-sync.ts` (regex unchanged); the zod-free
  guarded list gains the eight payload-* siblings beside the face entry.
- No guard reads payload-native-clean / runtime-deps / status-utils
  content, and no pack imports the family — `pack-boundaries.mjs`
  `CORE_VALUE_FILES` untouched (correct: install-payload.ts was never in
  it).

Runtime behavior pins stayed green untouched: agent-install-native,
doctor-native-receipts, agent-install, cross-platform (the suites the brief
names) all pass inside `npm test` every unit.

## Gate results (run in full before every commit; 7 code commits)

| Gate                                                                     | Result                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                      | 0 errors (both projects), every unit                                                          |
| `npx eslint .`                                                           | 0 errors, 73 warnings — exactly the pre-existing allowance, zero new, every unit              |
| `npm run build`                                                          | green every unit (import graph changed each time); dist + skills regenerated                  |
| `node --experimental-test-module-mocks --test "test/structure*.test.ts"` | 114 pass, 0 fail, every unit                                                                  |
| `npm test`                                                               | 1412 tests, 1410 pass + 2 skip — the contract, every unit                                     |
| `npm run lint:dup`                                                       | exit 0 every unit; zero new clones, `.jscpd-baseline.json` untouched                          |
| `npx prettier --check .`                                                 | final-state warn set == the base's 7 pre-existing drift files exactly (zero new; see round 7) |

Telemetry stamp residue in `src/telemetry/` removed after every full
`npm test` run, per the common rules.

## Commits

- `e0f33c89` refactor(payload): extract the shared-utils and verified-file families
- `19616235` refactor(payload): extract the server-payload placement family; retarget the #758 and marker pins
- `aeed2772` refactor(payload): extract the skills-roster reader family; retarget the tryCoreSkillNames pin
- `1020324e` refactor(payload): extract the native-disclosure placement family; retarget the sync and dir-derivation pins
- `98ed12ad` refactor(payload): extract the native-disclosure cleanup family
- `22aa75e6` refactor(payload): extract the runtime-deps and status families; the face becomes the pure re-export
- `a93d5543` chore(payload): prettier the retargeted structure pin
- (this commit) docs(payload): AGENTS.md family module map + REPORT-payload.md

## Interrogate rounds

Execute → interrogate → fix loop, one adversarial pass per unit plus a
final complete-diff pass over 7e469857..HEAD:

- Round 1 (utils + files): zero findings. (Two face-import omissions —
  copyFileVerified/pkgVersion/asText/mcpServerInstalled/removeIfExists —
  were caught by the unit's own typecheck and fixed BEFORE its pass.)
- Round 2 (placement): zero findings. (Byte-identity re-verified after the
  retargets; no other guard reads the moved content — confirmed by grep.)
- Round 3 (roster): zero findings.
- Round 4 (native-sync): zero findings on the final state. (A sed line-range
  error during execution deleted the status+runtime-deps block from the
  face; caught immediately by typecheck, restored byte-identically from the
  base blob, and the face re-diffed clean before the pass.)
- Round 5 (native-clean): zero findings.
- Round 6 (runtime-deps + status + pure face): zero findings. (The surface
  script itself had a `Set.includes` typo — fixed and re-run, 29/29.)
- Round 7 (final complete-diff): ONE finding — the unit-4 multiline
  retarget in structure-installer-cmds.test.ts introduced prettier drift
  (`prettier --check` flagged it against the base's warn set; the base's 7
  drift files are pre-existing and untouched). Fixed in `a93d5543`,
  structure tests + eslint re-run green, and the post-fix re-pass over the
  complete diff: zero findings.

Execution note, zero final impact: while probing whether the base's format
drift was pre-existing, a `git stash pop` of a stale supervisor stash
conflicted against the branch; recovered with `git reset --hard HEAD`
(all work committed, tree clean, the stash entry preserved untouched).
The base probe was then redone safely through a throwaway `git worktree`.

## Deliberately NOT done

- `.jscpd-baseline.json` not regenerated — the split introduced zero new
  clones (regen is reserved for moved-not-deleted duplication).
- The base's misplaced comment block (the removeOwnedSkillsFrom-describing
  paragraphs sitting above removeHuaweiCommandsFrom) moved byte-identically
  rather than being reorganized — both functions live in the same module
  (payload-native-clean.ts), so the attachment is unchanged and rewriting
  it would be unforced drift.
- The base's 7 pre-existing prettier-drift files (sandbox/devbridge-_.ts,
  REPORT-_.md ×3, test/structure-proxy-devbridge.test.ts) left as-is —
  pre-existing, out of scope.
- No direct-importer rewrites, no test weakenings, no pack-boundaries or
  CORE_VALUE_FILES changes (no pack imports the family).
- `REPORT.md` written as `REPORT-payload.md` per the task brief's
  per-task naming convention (the five precedent waves at the repo root
  follow it).
