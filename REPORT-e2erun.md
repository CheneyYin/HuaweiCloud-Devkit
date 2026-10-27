# REPORT — test/e2e/runner.ts modularization (stable import face)

Branch `e2erun-split`, base `e0c9ed20`. Task: bring every file under
`test/e2e/` below the jscpd complex-file bar (cx < 50, measured per file
with `npx jscpd <file> --complexity --reporters ai`) via an internal module
split whose entry contract does not change — `npm run test:e2e` still runs
`node test/e2e/runner.ts`, same flags, same `E2E_AGENT` driver selection,
same output contract.

## Per-file final cx (all 33 files under test/e2e/)

| File                                 | cx before | cx after | Verdict               |
| ------------------------------------ | --------- | -------- | --------------------- |
| runner.ts                            | 227       | 42       | below bar             |
| evaluate.ts                          | 131       | 15       | below bar             |
| ws-fake/hwlink-server.ts             | 64        | 31       | below bar             |
| selfcheck-verify.ts (new)            | —         | 47       | below bar             |
| drivers/gateway-proxy.ts             | 46        | 46       | below bar (untouched) |
| evaluate-kinds.ts (new)              | —         | 46       | below bar             |
| evaluate-matchers.ts (new)           | —         | 42       | below bar             |
| drivers/shared.ts                    | 42        | 42       | below bar (untouched) |
| ws-fake/fake-shell.ts                | 41        | 41       | below bar (untouched) |
| drivers/codex.ts                     | 37        | 37       | below bar (untouched) |
| recordings.ts (new)                  | —         | 28       | below bar             |
| report.ts (new)                      | —         | 26       | below bar             |
| case-run.ts (new)                    | —         | 25       | below bar             |
| evaluate-sequence.ts (new)           | —         | 24       | below bar             |
| http-fake.ts                         | 20        | 20       | below bar (untouched) |
| harness.ts (new)                     | —         | 19       | below bar             |
| selfcheck.ts (new)                   | —         | 19       | below bar             |
| env-policy.ts                        | 15        | 15       | below bar (untouched) |
| ws-fake/terminal-protocol.ts (new)   | —         | 14       | below bar             |
| evaluate-evidence.ts (new)           | —         | 3        | below bar             |
| ws-fake/tunnel-relay.ts (new)        | —         | 25       | below bar             |
| pack-install.ts (new)                | —         | 6        | below bar             |
| seams.ts (new)                       | —         | 6        | below bar             |
| case-fixtures.ts (new)               | —         | 7        | below bar             |
| drivers/opencode.ts                  | 20        | 20       | below bar (untouched) |
| cases/\*, drivers/types.ts, types.ts | 1–3       | 1–3      | below bar (untouched) |

The task brief's note that `cases/core.ts` measured ~74/96 earlier did not
reproduce: every file in `cases/` measures cx 1–3 today (data-heavy case
definitions, few branches) — nothing to rebalance there. The over-bar set
was exactly `runner.ts`, `evaluate.ts`, `ws-fake/hwlink-server.ts`; all
three are now split and below the bar, and no untouched file regressed.

## Module map

### evaluate family (commit 81347c8e)

- `evaluate.ts` — the stable face: all recording/verdict types
  (`Recordings`, `CaseVerdict`, …) and `evaluateCase`. Its importer
  `test/e2e-evaluate.test.ts` is unchanged.
- `evaluate-matchers.ts` — the matcher layer (inRange/describeRange,
  matchHcloud, argsPartialMatch, matchToolCall, matchDisclosure,
  matchAgentSays). Type-only back-edge into the face for the recording
  types; no value cycle.
- `evaluate-sequence.ts` — the ordered-subsequence expectation end-to-end
  (matcher + verdict constructor).
- `evaluate-evidence.ts` — the one evidence shape the hcloud/http/gateway
  kinds share verbatim.
- `evaluate-kinds.ts` — the per-kind verdict switch (`expectationVerdict`).

### ws-fake family (commit 09cb58e7)

- `hwlink-server.ts` — server lifecycle, connection wiring, packet
  dispatch; still exports `WsFake` / `WsConnectionRecording` /
  `WsCommandRecording` (the pre-existing surface `evaluate.ts` and the
  runner import).
- `terminal-protocol.ts` — the terminal-session half: byte-stream
  reassembly, ready handshake, command-blob drain, chunked sends.
- `tunnel-relay.ts` — the tunnel-session half: bounded tunnel relay plus
  the in-fake HTTP file server (tryParseHttp, /health, /upload with true
  md5).
- `ConnState` exports from hwlink-server.ts; both session modules import
  it type-only (type-only back-edge, no value cycle).

### runner family (commits f1f12756, 68b4d861 + the report commit)

- `runner.ts` — the entry face: `main()` stays here (arg parsing,
  `E2E_AGENT` driver selection, suite loop with the
  incident-hardening streaks, the always-ships report) plus the
  `[runner] driver <id>` echo the workflow greps — so the
  structure-adopted source-text pin still reads runner.ts, unchanged.
- `harness.ts` — root/npm/TEMP_PREFIX, `out`, `packageJson`,
  `loadDotEnv`, `sweepStaleTempDirs` (the "Signal death" comment moved to
  its function, where it always belonged).
- `seams.ts` — `seamVars` + `installPathShim` (fake fixture paths are
  module-private now).
- `pack-install.ts` — `npmPackTarball`, `installPrefix`, `runInstall`.
- `case-fixtures.ts` — `seedHome`, `seedWorkdir`, `renderPrompt`.
- `recordings.ts` — `readGatewayLog`, `readHcloudLog`, `readTrace`,
  `collectFiles`, `emptyRecordings` (the zero-activity literal, shared by
  runCase's initial state and main's harness-crash belt).
- `report.ts` — `AttemptReport`/`CaseRunReport`, `runnerErrorVerdict`,
  `scrubbedStack`, `pruneReports`, and the per-attempt call-list summaries
  (one copy each — the success and crash paths of runCase previously
  duplicated all five formatters).
- `case-run.ts` — `runCase`, the per-case attempt loop.
- `selfcheck.ts` — the LLM-less chain (setup, install, spawn, collect).
- `selfcheck-verify.ts` — the assertion ladder, pure over the collected
  evidence (responses, hcloud calls, trace, HTTP recordings, ws commands).

Import discipline: node builtins + the existing e2e family only; no new
deps; `verbatimModuleSyntax`-clean (type-only imports use `import type`);
verified zero value-level import cycles across `test/e2e/` by script.

## Entry-contract and behavior verification

The e2e suite itself is E2E_ENABLE-gated and does not run in this loop, so
behavior was pinned by every runnable angle:

- Live runner gates: `node test/e2e/runner.ts` without E2E_ENABLE prints
  the skip message, exit 0; `E2E_ENABLE=1` with no model env hits the
  probe refusal (exit 2, report JSON shipped with `fatalError` and the
  agent block); `E2E_AGENT=bogus` hits the unknown-driver fatal (exit 2).
- **The full LLM-less selfcheck chain ran green end-to-end**
  (`E2E_ENABLE=1 node test/e2e/runner.ts selfcheck`, exit 0): tarball →
  prefix install → MCP server over the wire → 56 tools, vendor-challenge
  bounce, check_cli retry, approval token, voucher_status through the
  HTTP fake, list_skills with skillRoot, 100001-char reassembled ws exec —
  exercising npmPackTarball/installPrefix/runInstall/seamVars/
  installPathShim/selfcheck/selfcheck-verify/recordings/harness as moved.
- A raw-WebSocket behavioral smoke drove the refactored ws fake through
  the ready handshake, chunked exec reassembly, fileserver start, refused
  tunnel port, tunnel upload with true md5, and the recording channel.
- Function-level `diff -wB` of every moved function against the original
  monolith: identical modulo `export` keywords, the verified-equivalent
  helper extractions (`emptyRecordings`, the five summarize formatters,
  `matchedEvidence`), and the selfcheck evidence threading. Ladder shape
  counts match (15 fail legs, 28 output lines, 5 payload calls).
- The evaluator's evidence strings were spot-checked byte-identical for
  every expectation kind (hit and miss branches).
- The workflow's driver-echo grep and `test:e2e` package.json pin are
  untouched; structure-adopted's runner.ts source-text pin passes without
  retargeting (the echo stayed in runner.ts).

## Gate results (final pass)

- `npm run typecheck` — pass (src + strict test project).
- `npx eslint .` — 0 errors, 73 warnings (the pre-existing baseline; zero
  new).
- `npm run build` — pass (dist rebuilt, 30 skills, 134 files).
- `node --experimental-test-module-mocks --test "test/structure*.test.ts"`
  — 114/114 pass (includes the driver-echo/workflow agreement pin).
- `npm test` — 1412 tests: 1410 pass + 2 skip (the repo contract), which
  includes the e2e-adjacent suites (e2e-evaluate, e2e-env-policy,
  e2e-cases-roster, e2e-driver-codex, e2e-driver-shared,
  ws-exec-protocol).
- `npm run lint:dup` — exit 0 (no new clones vs baseline).
- `npx prettier --check "test/e2e/**/*.ts"` — clean.

## Commits

- 81347c8e — refactor(e2e): extract the evaluator matcher and kind families
- 09cb58e7 — refactor(e2e): split the hwlink fake by session kind
- f1f12756 — refactor(e2e): extract the runner family; runner.ts becomes
  the main-holding entry
- 68b4d861 — chore(e2e): tighten family module surfaces after interrogate
- (this commit) — runner.ts header family-map completeness + this report

## Interrogate rounds

Four full adversarial passes over the cumulative diff:

1. Round 1 (after wave 1): removed a dead `RecordingsSurface` placeholder
   export I had drafted into evaluate-matchers.ts; un-exported the
   internally-only `matchSequence`.
2. Round 2 (after wave 2): mechanical statement-equivalence diff + the
   raw-ws behavioral smoke; zero further findings on the code, prettier
   reformat applied.
3. Round 3 (after wave 3): found and fixed the duplicated
   `import type … from './evaluate.ts'` (eslint import/no-duplicates error),
   un-exported `ParsedHttp` (tunnel-relay.ts) and
   `SelfcheckEvidence`/`toolPayload` (selfcheck-verify.ts) after a
   scripted unused-export sweep; kept `WsCommandRecording` exported
   (pre-existing face). Verified no value-level import cycles by script.
4. Round 4 (final, including the report and the header edit): zero
   findings.

## Deliberately NOT done

- No re-split of already-separate, under-bar modules (drivers/codex 37,
  drivers/shared 42, drivers/gateway-proxy 46, ws-fake/fake-shell 41,
  http-fake 20, env-policy 15, cases/\*, types.ts) — the task scopes the
  split to over-bar files.
- No retarget of the structure-adopted driver-echo pin — it still reads
  runner.ts and still passes, because `main()` (and the echo) stayed in
  the entry file.
- No AGENTS.md / docs/e2e-testing-design.md edits — neither contains
  file-level claims about test/e2e that the split invalidated (verified by
  grep); the design doc's runner-mechanics section describes behavior,
  which is unchanged.
- No change to the e2e-nightly workflow (byte-identical main/v2 contract
  is guarded elsewhere; nothing here touches it).
- The three `hwc-e2e-*` dirs in /tmp dated Oct 23 predate this task
  (shared user-level state, another session's); the runner's own day-old
  sweep owns them.
