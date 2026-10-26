# hcloud-cli.ts modularization — wave report

Branch `hcloud-split`, base `dd7f044`. Goal: land the 888-line
`plugins/huaweicloud-core/src/hcloud-cli.ts` monolith (jscpd cx 233) below
the complex-file bar (cx < 50 per file) via an internal module split with a
STABLE public face — same exported names, same import path, same behavior
(the safety-policy.ts precedent). Zero human interaction; all decisions per
documented doctrine.

## Final per-file cx (`npx jscpd <file> --complexity --reporters ai`)

| File (plugins/huaweicloud-core/src/) | tokens/lines | cx                                                                                                             |
| ------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------- |
| hcloud-cli.ts (the face)             | 96/32        | 1                                                                                                              |
| hcloud-obs-redact.ts                 | 310/65       | 16                                                                                                             |
| hcloud-api-error.ts                  | 372/69       | 21                                                                                                             |
| hcloud-catalog.ts                    | 651/107      | 22                                                                                                             |
| hcloud-plan.ts                       | 818/126      | 22                                                                                                             |
| hcloud-run.ts                        | 752/146      | 31                                                                                                             |
| hcloud-run-once.ts                   | 1164/228     | 37                                                                                                             |
| hcloud-sts.ts                        | 609/123      | 40                                                                                                             |
| hcloud-sg-preflight.ts               | 723/111      | 42                                                                                                             |
| lib/as-text.ts                       | —            | not listed (below jscpd's complexity-report floor; 19 lines, two single-ternary functions — far under the bar) |

Every touched file is below cx 50. The former monolith: 5245 tokens / 888
lines / cx 233 → a 32-line pure re-export face at cx 1.

## Module map

- `src/hcloud-cli.ts` — the stable re-export face: all 21 public names
  (4 approval-token re-exports, stripKooCliUpdateBanner, readServiceCatalogs,
  classifyUnsupported, ServiceCatalogCache, UnsupportedCause, SgFinding,
  resolveStsInjectArgs, redactArgsWithObs, planHcloudCommand, HcloudPlan,
  HcloudPlanWithArgs, runHcloud, HcloudRunResult, HcloudRunOptions,
  extractApiError, redactOutput, ApiErrorInfo). Verified mechanically
  against the pre-split export set: 21/21, no losses, no additions.
- `src/hcloud-plan.ts` — planHcloudCommand, quoteShellArg, planningWarnings,
  REQUIRED_PARAMS/PARAM_VALUE_HINTS/validateRequiredParams, the plan types;
  consumes lib/approval-tokens, hcloud-obs-redact, hcloud-sg-preflight.
- `src/hcloud-run.ts` — the retrying orchestrator: runHcloud,
  runHcloudOnceWithRetries, runtimeCurrentMismatchWarning (dynamic
  auth/reconcile import), isRetryableNetworkError, wait, HcloudRunResult,
  HcloudRunOptions, DEFAULT_MAX_RETRIES.
- `src/hcloud-run-once.ts` — the single-execution child supervisor:
  runHcloudOnce (spawn, proxy env, stdin, SIGTERM→SIGKILL escalation, the
  #921 ok-gate over child output), saveLargeOutput, timeout/large-output
  constants. Split out of the run engine because the combined module
  measured cx 68 (over the bar); after the rebalance: run 31, run-once 37.
- `src/hcloud-catalog.ts` — readServiceCatalogs (+ TTL cache),
  classifyUnsupported, UnsupportedCause, UNSUPPORTED_SERVICE_RE,
  appendLangHint. Type-only back-edge into hcloud-run.ts (the documented
  pack-module pattern; no value-level cycle).
- `src/hcloud-sts.ts` — resolveStsInjectArgs, isTemporaryStsExpired, the
  private asCreds/CredentialLike narrowing.
- `src/hcloud-obs-redact.ts` — redactArgsWithObs, OBS_WRITE_SUBCOMMANDS,
  obsWriteHint (family-internal export for the plan module).
- `src/hcloud-sg-preflight.ts` — SgFinding, preflightSecurityGroupCheck,
  applyPreflightFindings, private asPortText.
- `src/hcloud-api-error.ts` — ApiErrorInfo, extractApiError, redactOutput.
- `src/lib/as-text.ts` — gained `asString` (unknown→string|undefined
  narrowing; empty string stays `''`, unlike `asText(v) || undefined`),
  shared by the api-error and sg-preflight modules instead of duplicating
  the 3-line helper.

Import discipline held by every new module: node builtins + safety-policy +
lib/approval-tokens + lib/as-text + lib/as-record + risk-rule-engine
(type-only) + proxy/proxy-config + hcloud-probe + auth/credentials +
koocli-version + family siblings — no zod, no SDK. All modules sit at src/
ROOT level; none derives `__dirname`/`import.meta.url`, so the esbuild
bundle flattening concern does not apply. The face stays in
`scripts/lib/pack-boundaries.mjs`'s `CORE_VALUE_FILES`, so the three pack
consumers (huaweicloud-cli/tools.ts, obs/tools.ts, auth/account-type.ts)
keep importing the same path with the same names — their imports were NOT
rewritten, per the behavior pins. No structure guard read `hcloud-cli`
source text (grep over test/structure*.test.ts), so nothing needed
retargeting — nothing was weakened.

## Gate results (final state)

- `npm run typecheck` — 0 errors (src + test projects).
- `npx eslint .` — 0 errors, 73 warnings (the pre-existing allowance; zero new).
- `npm run build` — green; dist/ carries all 9 hcloud-*.js modules + the
  bundle rebuilds through the new import graph.
- `node --experimental-test-module-mocks --test "test/structure*.test.ts"` —
  114/114 pass (incl. the jscpd baseline gate: zero new clones).
- `npm test` — 1412 tests, 1410 pass + 2 skip, 0 fail (the contract).
- `npm run lint:dup` — exit 0, 179 clones (unchanged from baseline; the
  in-suite fingerprint gate confirms zero new).
- `npm run registry:diff` — OK: 40 tools structurally identical.
- `npm run format:check` — clean.
- Per-step family gates: the 8 direct test importers of the face
  (hcloud-cli/-run/-sts/-output/-approval, koocli-lang-gate, issue-443-fix,
  account-type) — 86/86 pass after every extraction.
- Telemetry stamp residue removed after every full `npm test` run.

## Commits

1. `78b9700` — refactor(hcloud-cli): extract the api-error and
   OBS-redaction family, hoist asString to lib/as-text
2. `f4c4ecf` — refactor(hcloud-cli): extract the service-catalog,
   STS-injection, and SG-preflight family
3. `6505f62` — refactor(hcloud-cli): extract the plan and run family; the
   face becomes the pure re-export seam
4. (this commit) — docs: AGENTS.md module-map bullet + gotcha reference,
   plan-run-approval-contract.md path note, REPORT.md

## Interrogate rounds

Four adversarial passes (one per commit unit), zero unresolved findings:

- Round 1 (leaves): all moved blocks mechanically verified byte-faithful
  (whitespace-normalized containment against the pre-move source); no
  public-face drift; comment surgery on the shared STS/redaction comment
  split both halves faithfully.
- Round 2 (catalog/sts/sg-preflight): 11 moved blocks verified; catalog's
  transient type import came from the face (still the defining module at
  that commit) and was retargeted to hcloud-run.ts in commit 3 when the
  definition moved; one prettier wrap applied (line-length only).
- Round 3 (plan/run/face): export-set diff 21/21 exact (an initial "lost
  SgFinding" and "runHcloudOnce drifted" were false positives of my
  verification script — `export type {}` form and a `runHcloudOnceWithRetries`
  prefix match — both disproven with corrected anchors); run engine measured
  cx 68 → rebalanced into run + run-once (31/37) per the brief's measurement
  note; one type-only import restyle (`import type {`) for consistency.
- Round 4 (final sweep, docs): grep for stale `hcloud-cli.ts` references in
  docs — the two live ones (AGENTS.md gotcha, plan-run-approval-contract.md)
  updated; CHANGELOG mentions are historical and left alone.

## Deliberately NOT done

- No test-file import rewrites (the face is the contract; the brief pins
  the direct test importers to `src/hcloud-cli.ts`).
- No structure-guard additions: no guard read the monolith's source text,
  so there was nothing to retarget; the existing complex-file-relevant
  gates (jscpd baseline, pack boundaries, typecheck) all pin the split as-is.
- No `CORE_VALUE_FILES` change in scripts/lib/pack-boundaries.mjs — the
  face path is unchanged, so the pack import surface is unchanged.
- No baseline regeneration for `.jscpd-baseline.json` — zero new clones;
  the committed fingerprints still cover everything (regeneration is only
  for moved-not-deleted clones, which did not occur).
- docs/CHANGELOG.md historical mentions of hcloud-cli.ts left untouched
  (history); no RELEASES/CHANGELOG entry added for a refactor wave (repo
  convention: CHANGELOG entries ride the release flow, not refactor waves).
- The `ProvisionOptions`-style cosmetic questions (e.g. whether
  `obsWriteHint`/`appendLangHint`/`isTemporaryStsExpired`/
  `preflightSecurityGroupCheck` deserve a dedicated family-internal export
  convention) are left as-is: each carries a "consumed by X; not part of the
  face's public surface" note at its definition, which is the existing
  repo pattern for such seams.
