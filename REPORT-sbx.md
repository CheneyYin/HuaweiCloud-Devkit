# REPORT-sbx — packs/sandbox/tools.ts modularization (within-pack split, stable face)

Branch `sandbox-pack-split`, base `a82419d7` (jscpd line). The sandbox pack's
`tools.ts` (879 lines, jscpd cx 122) landed below the complex-file bar
(cx < 50 per file) via a WITHIN-PACK module split with a stable face — the
eighth application of the repo's monolith-split pattern (tools / hcloud-run /
auth / update-check / telemetry / payload / session precedents), the first
one inside `src/packs/`.

## Per-file final cx (`npx jscpd <file> --complexity --reporters ai`)

| File (all under `plugins/huaweicloud-core/src/packs/sandbox/`) | lines | cx     | role                                                                                                                                              |
| -------------------------------------------------------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.ts` (the face)                                          | 182   | **1**  | `SANDBOX_TOOLS` / `SANDBOX_TOOL_SCHEMAS` / `SANDBOX_TOOL_HANDLERS` + `satisfies` checks + `SANDBOX_TIMEOUT_MS` re-export (was 879 lines / cx 122) |
| `schemas.ts`                                                   | 254   | **1**  | the zod schema block + the `SANDBOX_TIMEOUT_MS` table                                                                                             |
| `git-transfer.ts`                                              | 93    | **15** | `isGitAvailable` / `gitCloneToLocal` / `transferGitRepo` (repo-transfer trio)                                                                     |
| `handlers-session.ts`                                          | 48    | **17** | exec_with_session, exec_one_shot, close_session                                                                                                   |
| `handlers-upload.ts`                                           | 46    | **13** | upload_file, upload_project                                                                                                                       |
| `handlers-deploy.ts`                                           | 63    | **17** | deploy_nginx, deploy_check                                                                                                                        |
| `handlers-tunnel.ts`                                           | 89    | **24** | expose_tunnel, renew_tunnel, keepalive_watchdog                                                                                                   |
| `handlers-account.ts`                                          | 46    | **8**  | check_user, sign_agreement, connect                                                                                                               |
| `handlers-credentials.ts`                                      | 144   | **28** | credentials (vault refs, STS, IAM pre-validation, /tmp injection pair)                                                                            |
| `pack.ts` (untouched)                                          | 16    | **1**  | pack manifest                                                                                                                                     |

Every OTHER touched file also measured below the bar:
`test/structure.test.ts` cx 40, `test/structure-proxy-devbridge.test.ts` cx 21,
`src/lib/credentials.ts` cx 38, `src/sandbox/deploy-check.ts` cx 26,
`src/tool-schemas.ts` cx 6, `src/sandbox/session-manager.ts` cx 1,
`src/sandbox/devbridge-tunnel.ts` cx 1, `eslint.config.mjs` cx 4.

## Module map

```
src/packs/sandbox/
  tools.ts               ← the stable face: arrays + satisfies + SANDBOX_TIMEOUT_MS re-export
  schemas.ts             ← zod schemas + timeout table (leaf; zod allowed, SDK never)
  git-transfer.ts        ← repo-transfer trio; only consumer is handlers-account.ts (connect)
  handlers-session.ts    ← exec/close handlers
  handlers-upload.ts     ← upload handlers
  handlers-deploy.ts     ← deploy_nginx / deploy_check handlers
  handlers-tunnel.ts     ← expose/renew/keepalive handlers
  handlers-account.ts    ← check_user / sign_agreement / connect handlers
  handlers-credentials.ts← credentials handler + shellSingleQuote
  pack.ts                ← pack manifest (untouched)
```

Import DAG (no cycles): `schemas.ts` is the leaf (zod + lib/tool-schema-parts
only); every handler module reads `schemas.ts` + whitelisted core dirs
(`src/sandbox/`, `src/auth/`, `src/lib/`) + type-only edges into `tools.ts`;
`handlers-account.ts` value-imports `git-transfer.ts` (own pack root —
allowed); the face imports schemas + all fourteen handlers.

## Import surface (unchanged, verified by grep + green suites)

`SANDBOX_TOOLS` (pack.ts, tool-definitions.ts, structure-packs.test.ts,
sandbox-pack.test.ts), `SANDBOX_TOOL_HANDLERS` (registry.ts),
`SANDBOX_TOOL_SCHEMAS` (tool-schemas.ts), `SANDBOX_TIMEOUT_MS` +
`type SandboxToolName` (sandbox-pack.test.ts) — all still imported from
`./tools.ts`; the face re-exports `SANDBOX_TIMEOUT_MS` from `schemas.ts`.
No consumer import was touched.

## Guard retargets (source-text reads of the old tools.ts, same strength or stronger)

- `test/structure.test.ts` "sandbox timeout defaults stay single-sourced":
  was a single-file read of tools.ts; now scans EVERY `.ts` module in
  `src/packs/sandbox/` — same deny (`args.timeout_ms || <digit>`), same
  exact count (9 table-based fallbacks), strictly stronger scope (no sibling
  can smuggle a raw numeric fallback).
- `test/structure-proxy-devbridge.test.ts` connect PATH pin: same regex,
  retargeted to `handlers-account.ts` (comment + assertion message updated).
- `test/structure-proxy-devbridge.test.ts` credentials assertions
  (`api_key`, `process.env.HW_API_KEY || args.api_key`, `/tmp/hw_api_key`,
  the credsScript-not-HW_API_KEY block): same regexes, retargeted to
  `handlers-credentials.ts`.
- `structure-packs.test.ts`'s per-pack `name: '...'` scan and the
  boundary-allowlist walk needed no retarget: the arrays stay in the face,
  and new siblings join the walk automatically (verified green).

## Behavior pins held untouched

test/structure-packs.test.ts, the sandbox suites (sandbox-pack, session
manager, ws-exec-protocol, devbridge families — all dispatch through the
registry), `npm run registry:diff` (schemas moved-but-identical: "40 tools
structurally identical"), pack-meta-tools / pack-disclosure guards.

## Verbatim-move verification

Mechanical line-set check (whitespace-normalized, import statements and
`export` prefixes factored out): every body line of the pre-split tools.ts
survives in the family — **0 missing**; the only new-only lines are the
unit-1 schema block (already pinned byte-for-byte by registry:diff and the
sandbox-pack schema-text test). Handler code, error messages, comments, and
the timeout table were moved, never rewritten.

## Gate results (full gates before every commit; final state)

| Gate                                                                     | Result                                                                                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                      | pass (src + test projects)                                                                                                        |
| `npx eslint .`                                                           | 0 errors, 73 warnings — exactly the pre-existing allowance, zero new                                                              |
| `npm run build`                                                          | pass every unit the import graph changed (both units)                                                                             |
| `node --experimental-test-module-mocks --test "test/structure*.test.ts"` | 118 pass (base: 118)                                                                                                              |
| `npm test`                                                               | 1416 tests / 1414 pass + 2 skip (base contract: 1416 / 1414 + 2)                                                                  |
| `npm run lint:dup` (baseline gate)                                       | exit 0, zero new clones — `.jscpd-baseline.json` NOT regenerated (content fingerprints held through the moves; nothing to absorb) |
| `npm run registry:diff`                                                  | OK: 40 tools structurally identical                                                                                               |
| `npx prettier --check` (touched files)                                   | clean                                                                                                                             |

## Commits

1. `b42acfd0` — refactor(sandbox): extract the pack's zod schemas and timeout
   table into schemas.ts (+ eslint `packs/*/schemas.ts` allowlist glob,
   tool-schemas.ts comment accuracy)
2. `49ba26a6` — refactor(sandbox): extract the handler family; tools.ts
   becomes the re-export face (+ the three guard retargets, four stale
   comment fixes in session-manager/devbridge-tunnel/deploy-check/lib-credentials)
3. docs commit — AGENTS.md `src/packs/` doctrine paragraph updated for the
   sandbox family (the doctor-split AGENTS precedent) + this report

## Interrogate rounds

- Round 1 (unit 1 diff): zero findings.
- Round 2 (unit 2 diff): 12 findings, all fixed before the commit —
  5 new `import/order` warnings (blank line inside the parent+sibling group
  in the handler modules), 4 stale comments naming the old co-location
  (session-manager.ts, devbridge-tunnel.ts ×2, deploy-check.ts,
  lib/credentials.ts), 3 prettier formatting misses (hand-written import
  blocks in the face + retargeted guards). Re-check after fixes: zero
  findings; mechanical verbatim check 0 missing.
- Round 3 (docs diff): zero findings.

## Deliberately NOT done

- No `.jscpd-baseline.json` regeneration — the gate stayed green with zero
  new clones (content-based fingerprints survive wholesale moves), so per the
  AGENTS.md doctrine there was nothing to absorb.
- No handler-body refactoring (e.g. extracting the repeated
  workspace-id-required throw into a shared helper): the brief pinned
  verbatim moves, and the timeout-defaults guard reads the exact
  `args.timeout_ms || SANDBOX_TIMEOUT_MS.<tool>` shape nine times — a helper
  extraction would weaken that pin and grow the diff beyond the move.
- `pack.ts` and the open-mcp style siblings elsewhere were left as-is; only
  the sandbox pack was in scope.
- The docs/e2e-testing-design.md bootstrap-window note and all other docs are
  untouched (AGENTS.md was the one doctrine paragraph the brief named).
