# REPORT-tmtr — telemetry/telemetry.ts modularization (stable public face)

Branch `telemetry-split`, base `7e469857` (jscpd line). Seventh application of
the safety-policy re-export-face precedent (after REPORT-session.md,
REPORT-hcloud.md, the auth-split wave, REPORT-upchk.md, and the
devbridge/e2erun waves).

## Result

`plugins/huaweicloud-core/src/telemetry/telemetry.ts` went from **494 lines /
jscpd cx 133** to a **230-line face (cx 46)** that is BOTH the stable public
surface AND the owner of the family's load-bearing module-scope state; the
internals live in six stateless ctx-taking siblings. The over-bar detection
side was split in the same wave: `agent-registry.ts` went from **398 lines /
cx 93** to a **210-line data face (cx 24)** plus two detector modules. Every
file in the family is below the cx < 50 bar.

## Per-file final cx (`npx jscpd <file> --complexity --reporters ai`)

| File                                          | Lines | cx  | Bar          |
| --------------------------------------------- | ----- | --- | ------------ |
| `src/telemetry/telemetry.ts` (face)           | 230   | 46  | ✓            |
| `src/telemetry/telemetry-types.ts`            | 76    | 1   | ✓            |
| `src/telemetry/telemetry-fs.ts`               | 47    | 10  | ✓            |
| `src/telemetry/telemetry-values.ts`           | 61    | 17  | ✓            |
| `src/telemetry/identity-stamps.ts`            | 108   | 30  | ✓            |
| `src/telemetry/hook-ingest.ts`                | 42    | 9   | ✓            |
| `src/telemetry/event-pipeline.ts`             | 105   | 30  | ✓            |
| `src/telemetry/agent-registry.ts` (data face) | 210   | 24  | ✓            |
| `src/telemetry/agent-versions.ts`             | 84    | 20  | ✓            |
| `src/telemetry/agent-versions-desktop.ts`     | 138   | 49  | ✓ (tightest) |
| `src/telemetry/agent-detect.ts` (untouched)   | 51    | 20  | ✓            |
| `src/telemetry/invoke-value.ts` (untouched)   | 47    | 34  | ✓            |

## Module map

- `telemetry.ts` — the face: `resolvePluginDir` (marker resolution, comment
  preserved verbatim), the paths record, `GLOBAL_TELEMETRY_DIR`
  (HUAWEICLOUD_DEVKIT_HOME-derived), PLUGIN_VERSION, the ONE state record,
  DEBUG/debugLog, the ctx construction, the public wrappers (incl.
  initTelemetry orchestration), and the two pure re-exports
  (isTelemetryEnabled, sanitizeValue).
- `telemetry-types.ts` — types only: TelemetryEventInput, TelemetryEvent,
  TelemetryState, TelemetryPaths, TelemetryContext.
- `telemetry-fs.ts` — ensureDir/readTextFile/writeTextFile/touchFile/
  stampExists/getStampUTCDate/getUTCToday, all parameterized.
- `telemetry-values.ts` — sanitizeValue, capabilityFromKey,
  toTelemetryEventInput, buildEvent, the os snapshot (osTypeStr family-
  internal export).
- `identity-stamps.ts` — generateMachineFinger, recoverInstallId,
  loadCachedUserHash/persistUserHash/clearUserHashFile, recordInstall,
  consumeInstallCounter, shouldSendFirstUsePing, checkDauPing.
- `hook-ingest.ts` — ingestHookSpool (the .processing leftover + rename
  seam).
- `event-pipeline.ts` — isTelemetryEnabled, getEndpoint,
  enqueueTrackedEvent, flushEvents, requeueEvents, the queue/flush/retry
  constants.
- `agent-registry.ts` — AGENTS, matchAgent, installSegment, findAgentById;
  re-exports detectVersion.
- `agent-versions.ts` — detectVersion dispatch, the DSH/Hermes package-tree
  detectors.
- `agent-versions-desktop.ts` — the CodeArts/WorkBuddy/OfficeAce
  install-location probes (ProgramFiles/LOCALAPPDATA bases + A:-Z: drive
  scan) and the shared jsonField/versionText readers.

Import DAG (no module imports the face; no cycles): types ← fs ← values ←
identity-stamps ← event-pipeline; values ← hook-ingest ← event-pipeline;
agent-versions-desktop ← agent-versions ← agent-registry (type-only back-edge,
the pack-module pattern). The face imports all of them.

## The critical constraint: why the face keeps the state

test/telemetry.test.ts (withIsolatedTelemetry) isolates the module by
re-importing the FACE with a query string under a fresh
HUAWEICLOUD_DEVKIT_HOME — only the face re-evaluates; sibling specifiers
resolve to their already-cached module instances. State or env-derived
constants in a sibling would silently survive the isolation with stale
values. Therefore the face owns the paths record, the state record, and the
ctx; every sibling is stateless and takes `ctx: TelemetryContext`.
Empirically proven post-split: two query-imports under different homes write
into their respective tmp dirs (paths re-derived per face evaluation).

## Behavior verification

- Public surface unchanged: all 15 pre-split exports (incl.
  InitTelemetryOptions) remain face exports; direct importers (src/tools.ts,
  src/mcp-protocol.ts, src/lib/credentials.ts, src/sandbox/hwlink-
  connection.ts, src/lib/hdkit/hdkitservice-api.ts) untouched.
- The three pinning test files stay green UNTOUCHED: telemetry.test.ts (32
  family tests incl. isolation), telemetry-plugin-dir.test.ts (resolvePluginDir
  across bundle/tsc/source/codex-cache layouts), telemetry-hook.test.ts.
- Mechanical body-equivalence probe over the moved code (15 invariant
  lines, the old-home drop checks, and the face spot checks) — all OK.
- Path resolution preserved in all three layouts: the source tree still
  resolves AGENT_TELEMETRY_DIR to src/telemetry (the pre-existing
  src/safety marker effect that makes full test runs leave stamp residue
  there), the tsc tree to dist/telemetry, the bundle to the plugin root.
  Residue cleaned after every full run per the common rules.
- Query-import isolation contract proven empirically (above) and pinned
  structurally by test/structure-telemetry.test.ts.

## Gate results

| Gate                                                                     | Result                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `npm run typecheck`                                                      | pass (src + test projects)                                                       |
| `npx eslint .`                                                           | 0 errors, 73 warnings (exact pre-existing baseline)                              |
| `npm run build`                                                          | pass (dist + bundle + skills regenerated)                                        |
| `node --experimental-test-module-mocks --test "test/structure*.test.ts"` | 118 pass (114 baseline + 4 new)                                                  |
| `npm test` | 1416 tests: 1414 pass + 2 skip (contract 1410+2, plus the 4 new structure tests). One intermediate run showed 2 parallel-load flakes (hook-parity's 115s python battery killed with status null; mcp-server-tools spawn timeout) — both reproduced green standalone per the flake-triage rule and the next full run was green |
| `npm run lint:dup`                                                       | pass, zero new clones, no baseline regeneration needed                           |
| `npm run validate`                                                       | pass (KooCLI pairing, pack boundaries, skills sync)                              |
| `npm run pack:verify`                                                    | pass (612 files, install OK)                                                     |
| `npm run format:check`                                                   | pass for all task files                                                          |

## Commits

1. `df948b91` refactor(telemetry): extract the stateless family;
   telemetry.ts becomes the state-holding face
2. `f121b6b0` refactor(telemetry): extract the agent version detectors;
   agent-registry keeps the data face
3. `57167a38` test(structure): pin the telemetry face ownership and the
   re-export surfaces
4. `docs(tmtr)`: this report, the AGENTS.md family bullet, and the face
   header fix

## Interrogate rounds

Three formal rounds:

- Round 1 (pre-commit, over the full working diff): caught the
  event-pipeline import-group blank line (eslint import/order — parent and
  sibling are ONE group in this repo's config); prettier drift on two task
  files (formatted — and the seven unrelated files the repo-wide sweep
  touched were reverted, they are other waves' pre-existing drift); the
  hardcoded STATELESS_SIBLINGS list in the new guard (strengthened to a
  directory scan with an exact-membership pin so future siblings are held
  to the rule automatically); a unicorn/require-array-sort-compare error;
  plus one authoring-time bug caught before any gate (a stray dynamic
  import inside non-async detectDshVersion). All fixed, all gates re-run
  green.
- Round 2 (over the committed diff): caught the face header's family map
  omitting the agent-versions split (commit 2 landed after the header was
  written) — fixed. Verified: no outside-family imports of the new
  siblings, no pack imports of telemetry, body-equivalence invariants still
  OK on the committed tree, tsc dist tree and esbuild bundle both carry the
  family with intact marker resolution.
- Round 3 (over the docs edits before their commit): caught the AGENTS.md
  bullet claiming "node builtins + lib/as-text + proxy/proxy-agent only"
  for the whole family — imprecise for invoke-value.ts, whose edges into
  tool-definitions/tools are type-only; reworded to scope the claim to the
  ctx-taking siblings. The post-fix re-check (and the final closure pass:
  fresh build so dist matches the formatted src, pack:verify, validate,
  clean git status) found nothing further — zero findings.

## Deliberately NOT done

- `agent-versions-desktop.ts` sits at cx 49 — under the bar but the tightest
  file in the family. Not rebalanced further: the CodeArts/WorkBuddy/
  OfficeAce probes are one knowledge cluster (install-location scanning),
  and splitting them would scatter the cluster arbitrarily.
- The stale `.mjs` mention in test/telemetry.test.ts's withIsolatedTelemetry
  comment — pre-existing; the brief pins those tests untouched.
- The pre-existing prettier drift in REPORT-devbridge.md, REPORT-e2erun.md,
  REPORT-upchk.md, src/sandbox/devbridge-*.ts, and
  test/structure-proxy-devbridge.test.ts (base-commit drift owned by other
  waves; my repo-wide format sweep was reverted for those files).
- The src/safety marker quirk (source-tree resolvePluginDir resolves
  PLUGIN_DIR to src/, which is why full test runs leave stamp residue in
  src/telemetry/) — pre-existing behavior the brief explicitly required
  preserving ("the paths must keep resolving to the same locations").
- `findAgentById` remains exported-but-unused — pre-existing public surface.
- No e2e run (E2E_ENABLE-gated; never in the PR gate per AGENTS.md).
