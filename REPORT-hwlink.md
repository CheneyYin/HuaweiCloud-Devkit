# REPORT-hwlink — ws-exec/hwlink-exec-client.ts modularization

Branch `hwlink-split`, base 89783468. Goal: `plugins/huaweicloud-core/src/ws-exec/hwlink-exec-client.ts`
(577 lines, jscpd cx 102) below the complex-file bar (cx < 50) via an
internal module split with a STABLE public face (the safety-policy
precedent).

**Report authorship note:** the task agent landed the refactor commit and
measured every cx number, but its documentation turns were repeatedly cut
off by the provider's content filter (three consecutive blocks on the
AGENTS.md edit and then on this report's own writing turn). The supervisor
completed this report and the AGENTS.md bullet from the agent's committed
work; all gate numbers below were re-run by the supervisor on the final
tree, and the module content was reviewed against the diff.

## Per-file final cx (`npx jscpd <file> --complexity --reporters ai`)

| File                               | Lines | cx  | Role                                                                  |
| ---------------------------------- | ----- | --- | --------------------------------------------------------------------- |
| `hwlink-exec-client.ts` (the face) | —     | 1   | pure re-export of the exact six-name public set                       |
| `hwlink-normalize.ts`              | 60    | 21  | input shaping (normalizeCommand/Timeout/Source/Url, isFiniteNumber)   |
| `hwlink-interactive-terminal.ts`   | 158   | 36  | the one-shot terminal factory (createHwlinkTerminal)                  |
| `hwlink-exec-pending.ts`           | 113   | 11  | PendingExec request/response correlation over the narrowed host shape |
| `hwlink-exec-session.ts`           | 334   | 39  | the session class + entry points (connect/execute wrappers)           |

Every touched file below cx 50. The pre-existing siblings
(hwlink-packet 26, hwlink-fair-queue 25, hwlink-terminal-channel 33,
ws-exec-client 14) are untouched and under the bar; hwlink-multiplexer
(cx 89) and hwlink-tunnel-channel (cx 72) were over the bar before this
task and remain so — out of this task's scope, recorded here as the
follow-up candidates in the family.

## Module map

The face re-exports the exact public set (createHwlinkTerminal,
HwlinkTerminalHandle, the connect/execute functions and option/result
types) consumed by `src/ws-exec/index.ts`. The session class's correlation
bookkeeping moved to hwlink-exec-pending.ts over a narrowed state shape;
the one-shot factory to hwlink-interactive-terminal.ts; the normalize
helpers to hwlink-normalize.ts; the class + wrappers to
hwlink-exec-session.ts. Pinned by the new `test/structure-ws-exec.test.ts`
(face ownership, family layering, bundle-graph discipline).

## Gate results (supervisor re-run on the final tree)

- `npm run typecheck` — 0 errors (src + test projects).
- `npx eslint .` — 0 errors (pre-existing warning allowance only).
- `npm run build` — green (dist + bundle + skills regenerated).
- `node --experimental-test-module-mocks --test "test/structure*.test.ts"`
  — 128 pass, 0 fail (123 baseline + 5 new ws-exec structure tests).
- `npm test` — 1426 tests: 1424 pass + 2 skip, 0 fail.
- `npm run lint:dup` — exit 0, 179 clones (unchanged; no baseline
  regeneration needed).
- Telemetry stamp residue removed after the full run.

## Commits

1. `6bd334d8` — refactor(ws-exec): extract the hwlink exec-client family;
   the face becomes the pure re-export (+ the new structure-ws-exec guard
   file).
2. (this commit) — docs: the wave report + the AGENTS.md family bullet
   (supervisor-authored after the provider content filter blocked the
   agent's documentation turns).

## Interrogate rounds

One full adversarial pass over the refactor diff was completed by the
agent before the filter interruptions (the commit message records the
boundary rationale: the PendingExec extraction over a narrowed host shape
keeps the class's correlation state cohesive). The supervisor's review of
the final diff found zero additional findings: the face's export set
matches the barrel's imports, the wire-protocol golden pins
(ws-exec-protocol.test.ts) pass untouched, and the family layering guard
is in place.

## Deliberately NOT done

- hwlink-multiplexer.ts (cx 89) and hwlink-tunnel-channel.ts (cx 72) stay
  over the bar — pre-existing, out of scope; the follow-up candidates.
- No AGENTS.md edits beyond the new ws-exec family bullet.
