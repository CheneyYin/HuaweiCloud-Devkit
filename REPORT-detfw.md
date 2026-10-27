# REPORT-detfw — detect-framework.ts modularization (stable public face)

Branch `detfw-split`, base `a82419d7`. Task: land the 466-line / cx 111
`plugins/huaweicloud-core/src/detect-framework.ts` below the complex-file
bar (cx < 50 per file) via an internal module split with a STABLE public
face — same exported names, same import path, same behavior.

## Result

Success criteria met. The file is now an 8-line pure re-export (the
safety-policy.ts precedent, eighth application); every implementation
module and every touched file measures below the bar.

## Per-file final cx (measured with `npx jscpd <file> --complexity --reporters ai`)

| File                                                      | Lines | cx                                                  | Under 50 |
| --------------------------------------------------------- | ----- | --------------------------------------------------- | -------- |
| `plugins/huaweicloud-core/src/detect-framework.ts` (face) | 8     | 0 (no functions; jscpd reports "analyzed no files") | yes      |
| `plugins/huaweicloud-core/src/detect-framework-table.ts`  | 166   | 1                                                   | yes      |
| `plugins/huaweicloud-core/src/detect-framework-pkg.ts`    | 79    | 32                                                  | yes      |
| `plugins/huaweicloud-core/src/detect-framework-match.ts`  | 143   | 48                                                  | yes      |
| `plugins/huaweicloud-core/src/detect-framework-scan.ts`   | 117   | 33                                                  | yes      |
| `test/structure-detect-framework.test.ts`                 | 113   | 8                                                   | yes      |

Base measurement: `detect-framework.ts` cx 111 (466 lines). The face has
zero functions, so jscpd's complexity reporter has nothing to count — cx 0
by construction.

## Module map

- `detect-framework.ts` — the public face: pure re-export of
  `detectFramework`, `SubApp`, `FrameworkDetection` (every pre-split public
  export, nothing else) from the scan module.
- `detect-framework-table.ts` — the FRAMEWORKS spec table + `FrameworkSpec`
  (pure data; leaf — imports nothing).
- `detect-framework-pkg.ts` — the pkg/project readers: `readPkg`,
  `detectPackageManager`, `collectDeps`, `readVitepressOutDir`,
  `resolveAngularOutput` (leaf — node builtins + `lib/as-record.ts` only).
- `detect-framework-match.ts` — `matchFrameworkSpec(projectPath, pkg, deps)`:
  the single-project branch chain (nextjs → … → static → deps+src
  fallback), returning specs; never builds results.
- `detect-framework-scan.ts` — the orchestration: `detectFramework` (monorepo
  branch inline, single-project chain delegated to the matcher),
  `scanSubApps` (recursive sub-app discovery — same module as
  `detectFramework`, so no cross-module cycle), `patchCommands`,
  `frameworkResult`, and the two public result interfaces.

Layering: table/pkg leaves ← match ← scan ← face. The discovery pack
(`src/packs/discovery/tools.ts`) still imports only the face, which stays
the `CORE_VALUE_FILES` entry in `scripts/lib/pack-boundaries.mjs` — no
guard change needed.

## Behavior verification

- `test/detect-framework.test.ts` untouched — 25/25 pass (detection matrix,
  PM detection, output resolution, sub-apps, main-1.1.9 parity cases).
- Mechanical move audit beyond the test matrix: brace-matched extraction
  proved 11 blocks byte-identical (modulo the `export` keyword), a
  normalized sorted-multiset diff of the whole family against the original
  accounted for every line (the only deltas: the sanctioned
  `frameworkResult(FRAMEWORKS.x, pm, projectPath)` → `FRAMEWORKS.x` spec
  returns, the vitepress multi-line call collapse, the extracted matcher's
  signature + closing brace, the face re-export line, and the two
  delegation lines), and an ordered line-by-line chain diff proved every
  branch condition positionally identical — no dropped branch, no
  reordering.
- Importers unchanged: `src/packs/discovery/tools.ts` and
  `test/detect-framework.test.ts` still import from
  `src/detect-framework.ts`.

## Structure pin (new, same commit as the move)

`test/structure-detect-framework.test.ts` (5 tests, modeled on
`structure-telemetry.test.ts`): face is the pure re-export and owns no
implementation; table/pkg keep canonical ownership and stay leaves
(import-shaped check — prose mentions of sibling names stay legal); match
owns the chain and returns specs (never `frameworkResult`/`patchCommands`);
scan owns `detectFramework`, the sub-app recursion, patching, and the
delegation seam; the discovery pack imports the face only; every family
member is zod/SDK-free with no `__dirname`/`import.meta.url` derivation.

The task's "retarget same-strength structure reads" line: grep found zero
pre-existing `detect-framework` reads in `test/structure*.test.ts`, so
there was nothing to retarget; the new pin adds the family's first
structure guard at full strength in the same commit as the move.

## Gates

| Gate                                                                     | Base                            | Final                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                      | pass                            | pass (both tsconfig projects)                                                           |
| `npx eslint .`                                                           | 0 errors / 73 warnings          | 0 errors / 73 warnings (zero new)                                                       |
| `npm run build`                                                          | pass                            | pass (import graph changed; bundle + skills tree regen)                                 |
| `node --experimental-test-module-mocks --test "test/structure*.test.ts"` | 118 pass                        | 123 pass (118 + 5 new pins)                                                             |
| `npm test`                                                               | 1416 tests / 1414 pass + 2 skip | 1421 tests / 1419 pass + 2 skip                                                         |
| `npm run lint:dup`                                                       | exit 0 (baseline in sync)       | exit 0, 179 clones both before and after — no new duplication, no baseline regen needed |
| `npx prettier --check` (touched files)                                   | —                               | pass                                                                                    |

Gate numbers at base differed between the briefs (common-rules said
structure 114 / npm test 1412; the actual base measured structure 118 /
npm test 1416 tests — the brief's header numbers were correct).

## Commits

1. `e4cc9cb6` refactor(detfw): extract the frameworks table and pkg readers from detect-framework
2. `4240c514` refactor(detfw): extract the spec matcher and scan orchestration; the face becomes the pure re-export (carries the structure pin)
3. docs(detfw): AGENTS.md family-map entry + this report

## Interrogate rounds

Three adversarial passes over the code diff plus a terminating docs pass,
zero findings on the final state:

- Round 1 (Cut A): block-level byte-identity + whole-family multiset audit
  — zero defects. (An intermediate shell-pipeline bug produced a vacuous
  "IDENTICAL" from a broken awk regex; caught and replaced with the
  brace-matching Node verifier — the vacuous check itself was the finding,
  fixed before any conclusion relied on it.)
- Round 2 (Cut B): ordered chain-diff (positional identity of every
  branch), brace accounting for the one extra `}` (the extracted matcher's
  own closing brace), prettier miss on the new test file — fixed in-round.
- Round 3 (full branch diff, after Cut B): face diff is the complete sanctioned
  replacement; all five pins non-vacuous; no dead code, no public-face
  drift, no doctrine violations. Zero findings.
- Round 4 (docs commit — the terminating pass): AGENTS.md sentence verified
  against the tree (pack ownership, precedent naming, pin filename) and
  every report claim re-checked against the measured gate outputs. Zero
  findings; this round itself is recorded here so the loop's terminal state
  is the committed one.

## Deliberately NOT done

- No `existsAny()`-style helper to further shrink `match` (cx 48): the bar
  is met by the pure move; a helper would rewrite branch conditions the
  tests pin positionally, for headroom the task does not require.
- No `.jscpd-baseline.json` regeneration: the gate stayed green with the
  committed baseline (same 179 clones before and after).
- No changes to `scripts/lib/pack-boundaries.mjs` (the face remains the
  whitelisted `CORE_VALUE_FILES` entry), to either importer, or to
  `test/detect-framework.test.ts`.
- AGENTS.md got one sentence in the `src/tools.ts` knowledge-module list
  (the wave doctrine); the full family map lives here.
