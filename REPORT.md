# REPORT — tools.ts modularization (bundled-graph-safe)

Branch `tools-split`, stacked on a8b484c. Goal: `plugins/huaweicloud-core/src/tools.ts`
(1690 lines, jscpd cx 269) below the complex-file bar (cx < 50) via an internal
module split that keeps the bundled mcp-server graph working identically.

## The cx metric (measured, not assumed)

jscpd's `--complexity` cx is per-file cyclomatic-ish complexity:
`1 + count(if, else, for, while, case, catch, &&, ||, ??, ?., ternary, arrow function)`
(comments and strings excluded; verified empirically — a file of N `if`s
measures cx N+1, 200 straight-line statements measure cx 1, and three arrow
constants measure cx 4). **Arrow callbacks count**, which the original
grouping estimates missed: the first capability-catalog cut measured cx 70,
not the estimated 38. That measurement forced two boundary adaptations (see
below).

## Final per-file cx (measured with `npx jscpd <file> --complexity --reporters ai`)

| File | Lines | cx | Role |
| --- | --- | --- | --- |
| `src/tools.ts` | 295 | 43 | dispatch shell + re-export face (was 1690 / cx 269) |
| `src/skill-disclosure.ts` | 242 | 47 | SKILLS_ROOT, verifySkillTree, retrieve_skill, list_skills, REFERENCE_CAP, referenceFilenames |
| `src/capability-catalog.ts` | 418 | 40 | service_catalog, list_packs, pack_info, SKILL_OWNER, pack-refusal helpers |
| `src/explain-error.ts` | 194 | 36 | explain_error |
| `src/telemetry/invoke-value.ts` | 47 | 34 | the telemetry invoke-value derivation callTool records |
| `src/packs-configure.ts` | 104 | 30 | packs_configure (the one mutating pack tool) |
| `src/search-docs.ts` | 64 | 21 | search_docs |
| `src/services/availability.ts` | 47 | 8 | get_regional_availability (beside SERVICE_REGIONS in services/regions.ts) |
| `src/vendor-gate.ts` | 103 | 7 | VENDOR_GATED_TOOLS, gate/challenge messages, challenge state, enforceVendorGate |
| `src/tool-definitions.ts` | 294 | 4 | TOOL_DEFINITIONS_LITERALS, packDescription, ToolName/ToolDefinition/TOOL_DEFINITIONS |

Every touched test/guard file also measures below the bar (max:
tools.test.ts cx 45, unchanged; structure-packs.test.ts cx 40 after retargets).
Every moved function body was verified byte-identical against its git-HEAD
source (modulo the added `export` keyword) — mechanically, per commit.

## Module map (runtime value edges, no cycles)

```
tools.ts ──> tool-definitions.ts (re-export face: TOOL_DEFINITIONS, ToolName, ToolDefinition)
tools.ts ──> vendor-gate.ts      (re-export face: VENDOR_GATED_TOOLS; dispatch calls enforceVendorGate)
tools.ts ──> capability-catalog.ts (serviceCatalog, listPacks, packInfo; SKILL_OWNER)
tools.ts ──> packs-configure.ts  (configurePacks)
tools.ts ──> skill-disclosure.ts (re-export faces: SKILLS_ROOT, verifySkillTree; retrieveSkill, listSkills)
tools.ts ──> search-docs.ts      (searchDocs)
tools.ts ──> explain-error.ts    (explainError)
tools.ts ──> telemetry/invoke-value.ts (toolInvokeValue)
tools.ts ──> services/availability.ts  (getRegionalAvailability)
skill-disclosure.ts ──> capability-catalog.ts (SKILL_OWNER, packNotFound, packNotEnabled, packEnablementRemediation)
search-docs.ts ──> skill-disclosure.ts (SKILLS_ROOT), capability-catalog.ts (SKILL_OWNER)
capability-catalog.ts ──> tool-definitions.ts (TOOL_DEFINITIONS for pack_info)
```

All new modules take `ToolArgs` / `CallToolOptions` / `ToolName` from `tools.ts`
via `import type` only — the same type-only back-edge pattern the pack modules
and `lib/pack-types.ts` already use (no runtime cycle; eslint `import/no-cycle`
stays at zero findings). tools.ts itself is now free of `node:fs`, `node:path`,
and `node:url` — it derives no paths at all.

## Where SKILLS_ROOT landed and why it is depth-safe

`SKILLS_ROOT = join(__dirname, '..', 'skills')` moved from `tools.ts` to
**`src/skill-disclosure.ts`, a src/ROOT-level module** — the depth-safe home the
task brief sanctions. The esbuild bundle inlines every module and flattens
`import.meta.url` to the bundle file's own URL, so `__dirname` inside
`dist/mcp-server.js` is `dist/` for every inlined module; the one-level climb
resolves to the plugin root in BOTH the tsc tree (`dist/skill-disclosure.js` →
`dist/` → one climb) and the bundle, only because `src/` and `dist/` are
siblings under the plugin root — exactly the property `tools.ts` had at src/
root depth. The module carries a header comment stating the constraint, and the
retargeted structure guards pin the literal join at the new canonical home plus
the `tools.ts` re-export face. No other `__dirname`-derived path existed in the
split scope. The pre-existing one-climb structure guard (src subdir modules
never climb more than one level) is untouched and green — all new subdir
modules (`telemetry/invoke-value.ts`, `services/availability.ts`) use no
`__dirname` at all.

## Guard retargets (same-strength, same commit as each move)

- `test/structure-manifests.test.ts` — get_service_icon name pin → `tool-definitions.ts`.
- `test/structure-load-path.test.ts` — the "fails or is denied" vocabulary pin → `tool-definitions.ts`
  (the description literals' home); the REFERENCE_CAP sync pin reads
  `tool-definitions.ts` (taught number) + `skill-disclosure.ts` (constant and
  interpolating marker) — a cross-module sync check, strictly stronger than the
  old single-file version.
- `test/structure-packs.test.ts` — the serviceCatalog routeMap scan →
  `capability-catalog.ts`; the SKILLS_ROOT resolution test retargeted to
  `skill-disclosure.ts` with the same const regex and absence pins, plus NEW
  face pins (the exact import line and `export { SKILLS_ROOT };` in tools.ts).
- `test/structure-installer.test.ts` — both SKILLS_ROOT pins retargeted to
  `skill-disclosure.ts` (const + dsh/hermes/atomcode absence pins) with a
  tools.ts re-export face pin.
- No guard was weakened; each kept its regex/assertion strength at the new
  canonical location, and the moved-code tests (tools/mcp-server/pack-meta/
  packs-configure/skills-tree/service-regions families) ran untouched and green.

## Boundary adaptations forced by the measured cx

The approved design grouped "capability catalog handlers (service_catalog /
list_packs / pack_info)" and left "remaining core handlers grouped coherently".
Measured with arrows counted, that grouping could not fit under cx 50, so:

1. `packs_configure` split from the catalog into `src/packs-configure.ts`
   (merged module measured cx 70; the read-only catalog and the one mutating
   pack tool are separate concerns anyway).
2. `search_docs` split from the disclosure family into `src/search-docs.ts`
   (merged module would measure cx 56).
3. `verifySkillTree` moved from tools.ts into `skill-disclosure.ts` (the tree
   boot guard beside the tree knowledge; SKILLS_ROOT becomes a local default)
   and `get_regional_availability` into `src/services/availability.ts` — these
   two moves took tools.ts from cx 50 (exactly at the bar) to 43.

## Gate results (final state)

- `npm run typecheck` — green (src + strict test projects).
- `npx eslint .` — 0 errors; 73 warnings, all pre-existing (baseline captured
  before the change: identical 73; zero new). `import/no-cycle`: zero.
- `npm run build` — green; the esbuild bundle builds with the new graph, dist +
  skills tree regenerated.
- `node --experimental-test-module-mocks --test "test/structure*.test.ts"` —
  114 pass, 0 fail.
- `npm test` — 1412 tests: **1410 pass + 2 skip, 0 fail** (the contract).
- `npm run lint:dup` — exit 0; the committed `.jscpd-baseline.json` stayed in
  sync (the in-sync gate inside `npm test` passed), so **no baseline
  regeneration was needed** — the moves created no new clones.
- `npm run lint` (markdownlint + eslint) — green at the pre-existing warning
  count (AGENTS.md edit included).
- Telemetry stamp residue after each full `npm test` run was removed (per the
  brief); `git status` clean of untracked stamp files.

## Commits (one per verified unit)

1. `386048f` — refactor(tools): extract the tool registry literals into tool-definitions.ts
2. `e0508aa` — refactor(tools): extract the vendorConfirmed gate into vendor-gate.ts
3. `2f02dda` — refactor(tools): extract the capability catalog and session pack configuration
4. `d8a1daa` — refactor(tools): extract the skills-serving family into skill-disclosure.ts and search-docs.ts
5. `b33f0f7` — refactor(tools): extract explain-error, the telemetry invoke value, regional availability, and the tree boot guard
6. `2ecee6c` — docs: tools-split module map, stale comment fixes, and the wave report
7. (this commit) — final interrogate sweep: three stale location comments, the tools.ts module header, report round count

## Interrogate rounds

Seven execute→interrogate→fix rounds (one per unit plus a final stack-wide
sweep over a8b484c..HEAD). Findings caught and fixed by interrogation:

- Unit 2: a challenge-consumption comment sentence duplicated into both
  `dispatchTool` and `enforceVendorGate` — trimmed from the call site (the
  internals are documented where they live).
- Unit 2: stale message-length comments claimed the gate/challenge messages
  fit call-trace's 300-char cap (actual lengths 375/327) — replaced with one
  accurate note (the trace copy truncates; the wire message does not).
- Unit 5: the #530 numeric-args comment was swept into
  `telemetry/invoke-value.ts` by a marker-based cut — restored above
  `NUMERIC_ARG_KEYS` in tools.ts.
- Unit 5: a double-brace splice defect in the first `services/availability.ts`
  write and an unused `ToolArgs` import — both fixed before commit.
- Unit 5: my own Unit-4 import-shape pin (exact import list) went stale when
  `verifySkillTree` joined the import — updated same-commit.
- Final sweep: three stale location comments naming tools.ts as the home of
  moved code (UPDATE_TOOLS derivation in structure-packs, the `known`-table
  provenance in services/regions.ts and service-regions.test.ts) — retargeted
  to the current homes; tools.ts gained the module header every other new
  module carries.

The final sweep also verified, mechanically: every moved function body
byte-identical to a8b484c (the only code delta in the whole stack is
dispatchTool's gate body → the `enforceVendorGate` call); the full export face
preserved (declarations became same-name re-exports); `__dirname` present in
exactly one new place (skill-disclosure.ts, ROOT-level); the SDK imported only
by the doctrine trio; and the release artifact itself — the spawned
`dist/mcp-server.js` bundle — serving `list_skills` with `skillRoot` resolved
to `<plugin-root>/skills`, proving the depth-safety end-to-end through the
flattened `import.meta.url`.

## Deliberately NOT done

- No behavior change of any kind: every moved function body is byte-identical
  (verified per commit); dispatch order, gate order, trace seam, and all
  message strings are untouched.
- No zod schema moves (`tool-schemas.ts` untouched; `npm run registry:diff`
  stays green through the tools.ts re-export face).
- No import rewrites for existing importers (mcp-protocol, tests, scripts keep
  importing from `src/tools.ts`); only guard files that read tools.ts source
  were retargeted.
- `classifyRawCommand` (an exported re-export of `classifyTextCommand` with no
  in-repo importers) was kept as-is: removing a public export is a face change
  beyond this task's scope. Flagged here for a future decision.
- The pre-existing 73 eslint warnings (8 `import/order`, 65
  `no-unused-vars` in hook fixtures) were left alone — the brief allows them.
- No `.jscpd-baseline.json` regeneration (in-sync gate passed without it).
- `hooks/`, `src/packs/` internals, `bin/`, and `integrations/` untouched.
