# REPORT-upchk — update-check.ts modularization (stable public face)

Branch `upchk-split`, base `bcaab050` (jscpd line). Fourth application of the
safety-policy re-export-face precedent (after REPORT-session.md,
REPORT-hcloud.md, and the auth-split wave).

## Result

`plugins/huaweicloud-core/src/update-check.ts` went from **632 lines / jscpd
cx 185** to a **51-line pure re-export face (cx 1)**; the internals live in
seven src/-ROOT-level family modules, every one below the cx < 50 bar.

## Per-file final cx (`npx jscpd <file> --complexity --reporters ai`)

| File | Lines | cx | Bar |
| --- | --- | --- | --- |
| `src/update-check.ts` (face) | 51 | 1 | ✓ |
| `src/update-installed.ts` | 53 | 13 | ✓ |
| `src/update-hint.ts` | 82 | 21 | ✓ |
| `src/update-skip.ts` | 94 | 22 | ✓ |
| `src/update-upgrade.ts` | 123 | 24 | ✓ |
| `src/update-cache.ts` | 95 | 32 | ✓ |
| `src/update-semver.ts` | 80 | 38 | ✓ |
| `src/update-registry.ts` | 146 | 41 | ✓ |

## Module map

- `src/update-semver.ts` — semverParse / semverCompare / hasPrerelease /
  determineTarget, the ParsedSemver + DistTags shapes (the channel logic).
- `src/update-installed.ts` — selfDir (the one-climb root-level
  `import.meta.url` derivation, family-internal export), the #576
  plugin-manifest fallbacks, readInstalledVersion.
- `src/update-skip.ts` — SkipState, COOLDOWN_DAYS, the #607 per-session skip
  paths (skipFilePath / fallbackSkipFilePath / resolveSkipFilePath /
  sanitizeSessionId), the atomic readSkipState / writeSkipState pair.
- `src/update-hint.ts` — judgeUpdate (four-state + cooldown matrix),
  buildResult, the UpdateResult / UpdateHint / UpdateHintLike shapes.
- `src/update-registry.ts` — queryDistTagsFetch (undici + the
  HUAWEICLOUD_NPM_REGISTRY override), queryDistTagsSync, queryDistTags,
  parseDistTagsOutput, toDistTags, debugLog, errorMessage (family-internal
  export for the upgrade act).
- `src/update-cache.ts` — the single-flight inflight seam, TTL +
  failure throttling, the lastHint memo, invalidateUpdateCache,
  getCachedUpdateInfo, peekCachedUpdateInfo, getUpdateDistTags, applyUpdateHint.
- `src/update-upgrade.ts` — upgradePackage, UpgradeOptions, the #717 target
  allowlist, the officeace reconnect copy, the manual-command failure shape.

Dependency DAG (all siblings at src/ ROOT level; no module imports the face):
semver, installed (leaves) ← skip ← hint; semver(type) ← registry;
hint + skip + registry ← cache; semver + registry + installed + cache ←
upgrade. No cycles (eslint import/no-cycle: zero new warnings).

The family feeds BOTH graphs unchanged: the unbundled `dist/setup-cli.js`
tree (setup-cli imports queryDistTagsFetch/determineTarget/semverCompare via
the face) and the esbuild `dist/mcp-server.js` bundle (mcp-protocol warms
the cache at boot). Root-level placement verified against the
`import.meta.url` flattening trap: `selfDir()`'s one climb resolves the
plugin root identically in the src tree, the dist tsc tree
(`dist/update-installed.js` → `readInstalledVersion()` = 2.0.0, verified),
and the bundle.

## Public-surface verification

29/29 public names preserved (21 value + 8 type), same import path
`src/update-check.ts` — verified mechanically per commit against the
pre-split export set (script: extract export statements from
`git show bcaab050:…update-check.ts` vs the face), and at runtime through
the compiled face (`Object.keys(await import('dist/update-check.js'))`).
Direct test importers (update-check.test.ts, update-check-registry.test.ts,
update-check-upgrade.test.ts, upgrade-session.test.ts — including its
namespace `import * as updateCheck`) were NOT rewritten and stay green.

52 of 52 declarations moved byte-identically (verified per-declaration with
an awk extractor diffing base vs each new home). The only deliberate
transformations, both non-observable:

1. `selfDir` and `errorMessage` gained `export` (family-internal seams; not
   re-exported by the face, so the public surface is unchanged).
2. The shared `IS_WINDOWS` const was inlined into per-module
   `NPM_BIN`/`NPX_BIN` ternaries (same values; the repo's per-module
   platform-const pattern used by 11 other modules).

## Behavior pins

- #607 cooldown + session-suffixed skip files: upgrade-session.test.ts green
  at every unit (44/44 family tests per unit).
- Single-flight concurrency: additionally re-verified empirically through the
  finished face — two concurrent `getCachedUpdateInfo` calls share exactly
  one `doQuery` invocation (single-flight calls: 1), both resolve
  `update_available`, `peekCachedUpdateInfo()` returns the hint, and
  `invalidateUpdateCache()` clears it. All cache state and its accessors live
  in the one module (`update-cache.ts`), so the face's re-exported bindings
  and the upgrade act's direct import share one module instance.

## Gate results (run in full before every commit; 4 code commits)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | 0 errors (both projects), every unit |
| `npx eslint .` | 0 errors, 73 warnings — exactly the pre-existing allowance, zero new |
| `npm run build` | green every unit (import graph changed each time); dist + skills regenerated |
| `node --test "test/structure*.test.ts"` | 114 pass, 0 fail, every unit |
| `npm test` | 1412 tests, 1410 pass + 2 skip — the contract, every unit |
| `npm run lint:dup` | exit 0, zero new clones, `.jscpd-baseline.json` untouched (nothing to absorb: no moved-not-deleted duplication) |

Telemetry stamp residue in `src/telemetry/` removed after every full
`npm test` run, per the common rules.

## Commits

- `bdf8e747` refactor(update-check): extract the semver channel and installed-version families
- `b3040bd5` refactor(update-check): extract the skip-state and verdict families
- `a719dd47` refactor(update-check): extract the registry IO and single-flight cache families
- `6b215923` refactor(update-check): extract the upgrade act; the face becomes the pure re-export
- (this commit) docs(upchk): AGENTS.md family bullet + wave report

## Interrogate rounds

Execute → interrogate → fix loop, one adversarial pass per unit plus a final
complete-diff pass over bcaab050..HEAD:

- Round 1 (semver + installed): zero findings. (An `import/first` ordering
  error and a missing `readInstalledVersion` internal import were caught by
  the unit's own gates and fixed BEFORE its interrogate pass.)
- Round 2 (skip + hint): zero findings. (A splice error around
  `SpawnResultLike` was caught by typecheck and fixed before the pass.)
- Round 3 (registry + cache): zero findings. (A re-export routing mistake —
  parseDistTagsOutput pointed at update-hint — was caught during execution
  and fixed before the pass.)
- Round 4 (upgrade + pure face): zero findings.
- Final complete-diff pass: zero findings.

## Deliberately NOT done

- No structure-guard retargets: no guard reads update-check.ts content —
  `structure.test.ts:71` is the mkdtemp allowlist (test file name only) and
  `structure-packs.test.ts:93` asserts the update pack imports the FACE
  (`../../update-check.ts`), which still holds verbatim. The face stays in
  `pack-boundaries.mjs`'s `CORE_VALUE_FILES`; the new siblings are never
  imported by packs, so no CORE_VALUE_FILES change was needed.
- `.jscpd-baseline.json` not regenerated — the split introduced zero new
  clones (regen is reserved for moved-not-deleted duplication).
- No test rewrites: all direct importers kept their imports; nothing was
  weakened.
- e2e case `test/e2e/cases/update.ts` untouched (its "update-check-registry-seam"
  id is a string; e2e is gated by E2E_ENABLE=1 and outside `npm test`).
- `docs/superpowers/specs/2026-09-07-version-upgrade-design.md` is noted as
  internal/not committed in the face header, carried over unchanged.
