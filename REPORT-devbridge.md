# REPORT — sandbox/devbridge-tunnel.ts modularization (stable public face)

Branch `devbridge-split`, stacked on 330ec6a (the session-split merge). Goal:
`plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts` (1164 lines, jscpd
cx 186) below the complex-file bar (cx < 50) via an internal module split with
a STABLE public face — same exported names, same import path
(`src/sandbox/devbridge-tunnel.ts`), same behavior. The safety-policy and
session-manager precedents: devbridge-tunnel.ts is now the pure re-export seam
(0 imports, 72 lines), the internals live in 8 new src/sandbox/ siblings.

## Final per-file cx (measured with `npx jscpd <file> --complexity --reporters ai`)

| File                       | Lines | cx  | Role                                                                    |
| -------------------------- | ----- | --- | ----------------------------------------------------------------------- |
| `devbridge-tunnel.ts`      | 72    | 1   | pure re-export face (was 1164 / cx 186; 0 imports)                      |
| `devbridge-exec.ts`        | 28    | 5   | the one-shot exec seam (OneShotResult, test override, runOneShot)       |
| `devbridge-validation.ts`  | 100   | 15  | port/expiry/id validators + lifetime constants + the 0.1.x version gate |
| `devbridge-auth.ts`        | 220   | 21  | auth waterfall probe + parser + the expose auth/version gate            |
| `devbridge-expose.ts`      | 295   | 38  | expose attempt contract: script, DB_* grammar (readDbField), parsers,   |
|                            |       |     | reachability warning, ExposeTunnelResult, the no-URL failure verdict    |
| `devbridge-verify.ts`      | 120   | 15  | fresh-session re-verify family (#919/#922) + persistence verdict        |
| `devbridge-renew.ts`       | 90    | 12  | renew script + parser + renewTunnel flow                                |
| `devbridge-keepalive.ts`   | 248   | 44  | keepalive watchdog family (scripts, parser, merge, install, enrollment) |
| `devbridge-expose-flow.ts` | 260   | 44  | the exposeTunnel orchestration (retry loop + dead-url/keepalive fields) |

The touched guard file also measures below the bar:
`test/structure-proxy-devbridge.test.ts` cx 21 (was 18 at base; the +3 is the
stronger family sweep, the five canonical seam-import pins, and the three face
re-export pins). Comment-only touches: `session-manager.ts` (cx 1),
`sandbox-output.ts` (cx 2), `devbridge-gateway.ts` (below jscpd's minTokens
floor, "0 files analyzed" — trivially compliant).

## Module map (runtime value edges, no cycles — not even type-level)

```
devbridge-tunnel.ts (face) ──re-exports──> every sibling below
devbridge-exec.ts        (leaf: imports hwlink-connection's execOneShot)
devbridge-validation.ts  (leaf: imports lib/as-text)
devbridge-auth.ts ──────> sandbox-output, devbridge-exec, devbridge-validation,
                          TYPE devbridge-expose (ExposeTunnelResult)
devbridge-expose.ts ────> devbridge-gateway, devbridge-validation, sandbox-output,
                          devbridge-exec (reportUnusableExpose's #998 read-back)
devbridge-verify.ts ────> devbridge-gateway, sandbox-output, devbridge-expose
                          (readDbField), devbridge-exec
devbridge-renew.ts ─────> devbridge-validation, devbridge-exec, sandbox-output,
                          devbridge-expose (readDbField)
devbridge-keepalive.ts ─> devbridge-validation, devbridge-exec, sandbox-output,
                          devbridge-expose (readDbField), lib/as-text
devbridge-expose-flow.ts > devbridge-validation, devbridge-exec, devbridge-auth
                          (gateExposeAuth), devbridge-expose (contract +
                          reportUnusableExpose), devbridge-verify
                          (verifyTunnelPersistence), devbridge-keepalive
                          (enrollKeepalive)
```

No sibling imports the face (verified by grep + the esbuild bundle carrying
zero `./sandbox/*` / `./devbridge-*` imports — the family is fully inlined).
No zod, no SDK, no `__dirname`/`import.meta.url` derivations in any new
sibling (the one-climb structure guard is untouched and green — this file
never derived layout paths).

## The exposeTunnel decomposition (the cx-186 → cx-44 cut)

exposeTunnel alone measured cx 84 — over the bar in isolation, so the flow was
decomposed into phase helpers that live with their concerns (the brief's
"rebalance when a module lands over the bar" note, applied once):

- `gateExposeAuth` → devbridge-auth.ts: the auth waterfall exec + parse + the
  #998 version gate + both pre-loop failure returns (verbatim bodies).
- `reportUnusableExpose` → devbridge-expose.ts: the no-usable-URL verdict with
  the deferred #998 version read-back and the too_old / no_tunnel_url /
  tunnel_unreachable taxonomy (verbatim body, object-args + destructure).
- `verifyTunnelPersistence` → devbridge-verify.ts: the fresh-session GET,
  dedicated parser, persistent verdict, and the three 请勿分享 warnings
  (verbatim texts; returns `{verifyHttpCode, verifyNotFound, persistent,
warning}`).
- `enrollKeepalive` → devbridge-keepalive.ts: the AUTO-ENROLL read → merge →
  install with its warnings (verbatim texts).
- `deadUrlExposeFailure` + `keepaliveResultField` → devbridge-expose-flow.ts
  (module-local): the gateway-dead/migration return and the keepalive summary
  field (verbatim bodies).
- The remaining `exposeTunnel` skeleton (retry loop, classification, warnings
  assembly, usable check, success return) stays in devbridge-expose-flow.ts.

Branch parity was verified line-by-line against base (ordering, timeouts,
catch arms, ternary chains, warning push order) and pinned end-to-end by the
existing seam tests — every devbridge-* suite and ws-exec-protocol ran
untouched and green through every commit.

## Byte-identity verification

Every moved declaration (32 of the original file's top-level declarations)
was verified byte-identical against `git show 330ec6a:…` with an
anchor+brace-matched extractor, per commit and again in a final whole-family
sweep. Documented deviations, all benign:

- `export` keyword added: `OneShotResult` (interface), `runOneShot`,
  `readDbField` — sibling-visibility exports; none are face exports (the
  original kept them module-internal; the family still does, one level down).
- `readDbField`'s comment extended: "…shared by the expose and verify parsers
  (and, through this canonical home, the renew and keepalive parsers)."
- The decomposed exposeTunnel pieces are new code by design (see above);
  their string literals (error/warning/remediation texts) were diffed against
  base and pinned by the behavioral suites.

The public surface was verified two ways: the parsed export set is identical
to 330ec6a (34 names: 25 values + 9 types), and the runtime
`Object.keys()` of the loaded face returns exactly the original 25 value
exports. Consumer imports were never touched: packs/sandbox/tools.ts, the
nine devbridge/ws-exec test files, and devbridge-harness.ts all still import
`src/sandbox/devbridge-tunnel.ts`.

## Guard retargets (same-strength-plus, same commit as each move)

`test/structure-proxy-devbridge.test.ts` — every devbridge-tunnel source read
retargeted to the new canonical module in the same commit as the move; all
regex literals preserved verbatim (only the source-read variables re-aimed):

- setsid / no-setsid fallback / disown / DB_EXPIRY_HOURS / PATH export /
  DB_MIGRATION grep / readDbField DB_MIGRATION / includes('10006') denial →
  `devbridge-expose.ts`; `DEVBRIDGE_HOST_EXPIRY_HOURS = 72` →
  `devbridge-validation.ts`.
- validateExpiryHours / validateTunnelId pins → `devbridge-validation.ts`;
  buildDevbridgeRenewScript → `devbridge-renew.ts`;
  buildDevbridgeKeepaliveScript / mergeKeepaliveTunnels / HC --noproxy →
  `devbridge-keepalive.ts`.
- buildDevbridgeVerifyScript / parseDevbridgeVerifyOutput / persistent /
  请勿分享 / DB_VERIFY_HTTP_CODE → `devbridge-verify.ts`.
- "gateway reports the fresh tunnel URL as dead" → `devbridge-expose-flow.ts`.
- The stripTerminalEscapes import-form pin (which prettier had collapsed to a
  single-line import mid-wave) was replaced by FIVE canonical seam-import pins
  (`import { stripTerminalEscapes } from './sandbox-output.ts';` in
  auth/expose/verify/renew/keepalive) — strictly stronger than the original
  single-file pin; the existing family-wide CSI/OSC literal-regex sweeps cover
  the new siblings automatically.
- `-e 8\b` denial widened from the single file to a whole-family sweep (the
  face-only check would have been vacuous once the scripts moved out).
- NEW face re-export pins (session-wave style): the expose-contract block,
  the verify pair, and the auth parser pair are pinned on the face's
  `export … from './devbridge-*.ts'` seams.

Assertion count 142 → 149 (+7); test names identical (12). The live-fixture
s2-gateway 404 text/plain wire test ran untouched and green.

## Gate results (final state, re-run after the last commit)

- `npm run typecheck` — green (src + strict test projects).
- `npx eslint .` — 0 errors; exactly the 73 pre-existing warnings (a
  warning-count guard was added to the per-commit gate runner after round 1
  caught three dead-variable warnings that the exit-code-only check had
  masked).
- `npm run build` — green; dist + skills tree regenerated; the bundle inlines
  the family (0 `./sandbox/*` imports), `dist/sandbox/devbridge-*.js` all
  present.
- `node --experimental-test-module-mocks --test "test/structure*.test.ts"` —
  114 pass, 0 fail.
- `npm test` — 1412 tests: **1410 pass + 2 skip, 0 fail** (the contract).
- `npm run lint:dup` — exit 0; `.jscpd-baseline.json` untouched (no new
  clones; no regeneration was needed).
- Telemetry stamp residue removed after every full `npm test` run; `git
status` clean.

## Commits (one per verified unit)

1. `dc5b8659` — refactor(sandbox): extract the tunnel parameter policy into devbridge-validation.ts
2. `97ac1f76` — refactor(sandbox): extract the one-shot exec seam into devbridge-exec.ts
3. `7695fe5b` — refactor(sandbox): extract the DevBridge auth waterfall into devbridge-auth.ts
4. `230fe8fd` — refactor(sandbox): extract the expose attempt contract into devbridge-expose.ts
5. `d65d875b` — refactor(sandbox): extract the fresh-session re-verify family into devbridge-verify.ts
6. `03093c62` — refactor(sandbox): extract the renew family into devbridge-renew.ts
7. `2e6c6c51` — refactor(sandbox): extract the keepalive watchdog family into devbridge-keepalive.ts
8. `d3897450` — refactor(sandbox): decompose exposeTunnel into devbridge-expose-flow.ts; face becomes the pure re-export seam
9. `49dd9868` — test(sandbox): retarget the disown pin and widen the -e 8 sweep after the keepalive extraction
10. `4d32e131` — test(sandbox): pin the devbridge-tunnel face re-exports after the flow decomposition
11. `6d950876` — test(sandbox): refresh stale devbridge-tunnel comments after the modularization

(Commit ordering note: the verify module landed after the expose contract so
its parser could import readDbField from the grammar's canonical home without
a face import.)

## Interrogate rounds

- **Round 1** (full diff since 330ec6a): 2 defects. (a) Three dead
  `devbridgeTunnel` reads in the structure test after the flow decomposition —
  three NEW eslint warnings that the exit-code-only gate runner had masked;
  fixed by replacing them with face re-export pins (new strength) and by
  hardening the gate runner with a warning-count guard (73 baseline, zero
  new). (b) A process defect, honestly recorded: commit 7 (`2e6c6c51`) was
  committed with a red structure test — the disown pin should have been
  retargeted with the expose-script move at commit 4 but survived vacuously
  through the keepalive script's identical line until commit 7 removed it,
  and the pipe-based gate check (`cmd | grep` — the exact AGENTS.md
  documented trap) reported green. Fixed forward in `49dd9868`; all gates
  re-run green from the committed state.
- **Round 2** (whole diff): 2 defects — three stale comments claiming
  devbridge-tunnel.ts still imports the gateway constants / carries the
  persistence subsystem (one in the test, one at session-manager.ts:27, one
  in the test's U16 block). Fixed in `6d950876`; a repo-wide sweep found no
  further stale mentions.
- **Round 3** (whole diff): **zero findings.** Verified: the declaration
  census (all 32 original top-level declarations resolve to exactly one
  canonical home); the export set identical at rest and at runtime (25 value
  exports); the import graph acyclic with no face imports and no zod/SDK;
  no `__dirname` derivations; the bundle inlines the family; assertion count
  142 → 149 with every regex literal preserved; every touched file below
  cx 50; all gates green.

## Anything deliberately NOT done

- No AGENTS.md edit — it documents the sandbox family only at directory level
  and names no devbridge-tunnel internals; nothing went stale.
- No changes to any consumer's imports — packs/sandbox/tools.ts, all nine
  devbridge/ws-exec test files, and devbridge-harness.ts kept their face
  imports (pinned by grep: no file outside the family imports a sibling
  directly).
- `.jscpd-baseline.json` not regenerated — the moves created no new clones
  and the in-sync gate inside `npm test` stayed green.
- `devbridge-gateway.ts` reports "0 files analyzed" under jscpd (constants
  file below the tool's minTokens floor) — trivially compliant; noted rather
  than forcing an artificial measurement.
- The one-shot `OneShotResult`/`runOneShot`/`readDbField` exports are
  family-internal (sibling visibility), deliberately NOT added to the face —
  they were module-internal before and stay unexported from the public
  surface.
- The legacy `docs/` references to session-manager-era internals are
  historical design docs (AGENTS.md: trust the filesystem, not the docs) and
  were left untouched.
