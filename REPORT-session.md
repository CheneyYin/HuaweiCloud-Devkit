# REPORT — sandbox/session-manager.ts modularization (stable public face)

Branch `session-split`, stacked on dd7f044. Goal: `plugins/huaweicloud-core/src/sandbox/session-manager.ts`
(1611 lines, jscpd cx 249) below the complex-file bar (cx < 50) via an internal
module split with a STABLE public face — same exported names, same import path
(`src/sandbox/session-manager.ts`), same behavior. The safety-policy precedent:
session-manager.ts is now the pure re-export seam, the internals live in
src/sandbox/ siblings.

## Final per-file cx (measured with `npx jscpd <file> --complexity --reporters ai`)

| File                     | Lines | cx  | Role                                                                            |
| ------------------------ | ----- | --- | ------------------------------------------------------------------------------- |
| `session-manager.ts`     | 87    | 1   | pure re-export face (was 1611 / cx 249)                                         |
| `devbridge-gateway.ts`   | 28    | —   | DEVBRIDGE_* constants (below jscpd's minTokens floor: "0 files analyzed")       |
| `sandbox-output.ts`      | 33    | 2   | stripTerminalEscapes, the single escape-stripping seam (#946)                   |
| `ws-exec-loader.ts`      | 104   | 9   | three-layout barrel resolution + the five ws-exec structural shapes             |
| `hwlink-connection.ts`   | 188   | 32  | workspace-id state, session cache, exec surfaces, tunnel sessions, close family |
| `upload-file.ts`         | 161   | 30  | base64 single-file upload family (chunks, #953 classify/reset, md5)             |
| `upload-diagnostics.ts`  | 46    | 14  | the upload log (append + rotation) + errorMessage                               |
| `tunnel-http.ts`         | 155   | 41  | raw-socket HTTP/1.1 client (POST /upload, GET /health)                          |
| `upload-transport.ts`    | 150   | 10  | file-server deploy + tunnel orchestration                                       |
| `upload-project.ts`      | 218   | 38  | project upload orchestration (archive, retry, extract)                          |
| `deploy-nginx.ts`        | 295   | 39  | nginx deploy orchestration (ports, templates, probes)                           |
| `deploy-nginx-verify.ts` | 68    | 18  | #935 A1 write-verification family (pure)                                        |
| `deploy-check.ts`        | 306   | 26  | deploy-check script, stdout-contract parser, remediation                        |

The touched guard file also measures below the bar:
`test/structure-proxy-devbridge.test.ts` cx 18 (was 17 at base; the +1 is the
stronger family sweep).

Every moved function body was verified byte-identical against its git source
(modulo the added `export` keyword) — mechanically, per commit and again in a
final whole-family sweep: all 78 top-level declarations of the original file
resolve to exactly one canonical home (see "deviations" below for the two
documented exceptions).

## Module map (runtime value edges, no cycles)

```
session-manager.ts (face) ──re-exports──> every sibling below
devbridge-gateway.ts   (leaf: the 5 DEVBRIDGE_* constants)
sandbox-output.ts      (leaf: stripTerminalEscapes)
ws-exec-loader.ts      (leaf: __dirname/firstExisting/resolveWsExecIndexUrl/loadWsExec + shapes)
hwlink-connection.ts ──> ws-exec-loader, lib/hdkit/hwlink-api, proxy/proxy-agent, telemetry
upload-file.ts ───────> hwlink-connection (execWithSession), sandbox-output
upload-diagnostics.ts (leaf: log + errorMessage)
tunnel-http.ts ───────> upload-diagnostics, lib/as-record
upload-transport.ts ──> hwlink-connection, ws-exec-loader (firstExisting + loadWsExec),
                        upload-diagnostics, tunnel-http
upload-project.ts ────> hwlink-connection, upload-file, upload-diagnostics,
                        tunnel-http (type), upload-transport
deploy-nginx.ts ──────> hwlink-connection (execOneShot), deploy-nginx-verify
deploy-nginx-verify.ts (leaf: pure functions)
deploy-check.ts ──────> hwlink-connection (execOneShot), devbridge-gateway, sandbox-output
```

devbridge-tunnel.ts (pre-existing sibling) keeps importing the DEVBRIDGE_*
constants, execOneShot, and stripTerminalEscapes from `./session-manager.ts` —
byte-identical import, pinned by the structure guard. packs/sandbox/tools.ts
and all test files keep their face imports unchanged. No sibling imports the
face or devbridge-tunnel (no cycles); only node builtins + the four sanctioned
repo-internal modules (hwlink-api, proxy-agent, telemetry, as-record) are
imported — no zod, no SDK.

## Where the __dirname derivations landed and why they are depth-safe

The critical constraint: `src/sandbox/` is a src SUBDIR, and the esbuild bundle
flattens every inlined module's `import.meta.url` to `dist/mcp-server.js`'s own,
so a subdir module's `__dirname` is `dist/sandbox/` in the tsc tree but `dist/`
in the bundle. The split keeps BOTH layout-deriving modules as src/sandbox
siblings at the SAME depth the original had, so resolution is provably identical
in all three layouts (source: `src/sandbox` → one climb to `src/ws-exec` /
asset beside the module; tsc mirror: `dist/sandbox` → one climb to
`dist/ws-exec`; bundle: `dist` → `dist/ws-exec` and `dist/sandbox/…`):

- `ws-exec-loader.ts` owns the barrel resolution (`firstExisting` +
  `resolveWsExecIndexUrl`) and exports `firstExisting` for the asset read.
- `upload-transport.ts` owns the file-server asset read
  (`SANDBOX_FILE_SERVER_SCRIPT`) with its own identical one-line derivation.

The pre-existing structure guard ("src subdir modules never climb __dirname
more than one level") is untouched and green — both derivations climb at most
one level (the asset read climbs zero). Verified live: the compiled tree
(`dist/sandbox/session-manager.js`) resolves the barrel to
`dist/ws-exec/index.js`, and `dist/ws-exec/index.js` +
`dist/sandbox/sandbox-file-server.py` both exist for the bundle's `dist/`
shape. The dist bundle contains the family fully inlined (no stray
`./sandbox/*` imports).

## Guard retargets (same-strength, same commit as each move)

`test/structure-proxy-devbridge.test.ts` — every session-manager source read
retargeted to the new canonical module, in the same commit as the move:

- nginx template / effectiveNodePort / port warnings / pipe join /
  `devbridge list -j` / A1 markers → `deploy-nginx.ts` (+ `deploy-nginx-verify.ts`
  for the `resolveNginxConfigPath` definition, re-aimed with a STRONGER
  definition-shaped regex).
- s2-domain / migration-marker / DEVBRIDGE_*-marker definitions →
  `devbridge-gateway.ts`, plus a NEW face pin (the re-export block tail).
- deploy_check remediation / probe-script / bounded-probe reads → `deploy-check.ts`.
- `stripTerminalEscapes`: definition + CSI-construction count → `sandbox-output.ts`,
  plus a NEW face pin (`export { stripTerminalEscapes } from './sandbox-output.ts';`);
  the literal-regex-copy denial loop now sweeps the WHOLE src/sandbox family
  (readdirSync) instead of two named files — strictly stronger.
- devbridge-tunnel import-form pin — unchanged and still passing (the face
  re-exports keep that import byte-identical).

Assertion count 140 → 142 (the two new face pins); test names identical; the
per-assertion normalized diff shows every regex literal preserved verbatim
(only the source-read variables were re-aimed). The behavioral batteries
(test/session-manager.test.ts, test/ws-exec-protocol.test.ts — including the
golden-byte wire-protocol pins and the `_setSessionConnectorForTests` seam
tests) ran untouched and green through every commit.

## Boundary adaptations forced by the measured cx

Exactly the pattern the brief warned about (jscpd's cx counts arrow callbacks):

1. The first upload cut (file-server + tunnel + log + orchestration in one
   `upload-transport.ts`) measured **cx 65**. Rebalanced into three:
   `tunnel-http.ts` (raw-socket HTTP pair, cx 41), `upload-diagnostics.ts`
   (log + errorMessage, cx 14), and a slimmer `upload-transport.ts` (cx 10).
   `UploadTunnelResponse` moved to `tunnel-http.ts` — it is the POST response
   contract, and placing it there keeps the dependency direction acyclic.
2. The first nginx cut (deploy + verify family in one `deploy-nginx.ts`)
   measured **cx 57**. The pure #935 A1 family moved to
   `deploy-nginx-verify.ts` (cx 18), leaving `deploy-nginx.ts` at cx 39.

## Gate results (final state, re-run after the last commit)

- `npm run typecheck` — green (src + strict test projects).
- `npx eslint .` — 0 errors; 73 warnings, all pre-existing (baseline captured
  before the change: identical 73; zero new; the family itself is warning-free).
- `npm run build` — green; dist + skills tree regenerated; the bundle inlines
  the family, dist assets verified present.
- `node --experimental-test-module-mocks --test "test/structure*.test.ts"` —
  114 pass, 0 fail.
- `npm test` — 1412 tests: **1410 pass + 2 skip, 0 fail** (the contract).
- `npm run lint:dup` — exit 0; `.jscpd-baseline.json` untouched (no new
  clones; the in-sync gate inside `npm test` stayed green — no baseline
  regeneration was needed).
- `npm run validate` + `npm run format:check` — green (extra AGENTS.md gates).
- Telemetry stamp residue removed after every full `npm test` run; `git
status` clean of untracked stamp files.

## Commits (one per verified unit)

1. `92f57df` — refactor(sandbox): extract the DevBridge s2 gateway contract into devbridge-gateway.ts
2. `7df2844` — refactor(sandbox): extract the escape-stripping seam into sandbox-output.ts
3. `426ffa4` — refactor(sandbox): extract the ws-exec loader into ws-exec-loader.ts
4. `3433da3` — refactor(sandbox): extract the hwlink connection layer into hwlink-connection.ts
5. `98e994d` — refactor(sandbox): extract the base64 upload family into upload-file.ts
6. `ad22eef` — refactor(sandbox): extract the file-server/tunnel upload transport into upload-transport.ts
7. `7f2eb4b` — refactor(sandbox): extract the project upload orchestration into upload-project.ts
8. `fb41f45` — refactor(sandbox): extract the nginx deploy family into deploy-nginx.ts
9. `d354896` — refactor(sandbox): extract the deploy-check family into deploy-check.ts; face becomes the pure re-export seam
10. `4adebaa` — refactor(sandbox): rebalance the upload transport under the cx bar
11. `5675658` — refactor(sandbox): rebalance deploy-nginx under the cx bar

## Interrogate rounds

- **Round 1** (full diff since dd7f044): 2 defects — `upload-transport.ts`
  cx 65 and `deploy-nginx.ts` cx 57, both over the cx<50 bar. Fixed in commits
  10 and 11 with byte-identical moves and a stronger guard pin. (Earlier
  per-commit interrogation catches, fixed before landing: an unused
  `WsExecModule` type import at commit 3, a dropped `UploadProjectResult`
  interface at commit 7, a truncated `DeployCheckResult` interface at
  commit 9 — each caught by typecheck/eslint/mechanical diff before the gate
  run completed.)
- **Round 2** (post-rebalance, whole diff): **zero findings.** Verified: the
  public-face export set is byte-identical to dd7f044 (33 value + 3 type
  exports, compared both as parsed source exports and as runtime
  `Object.keys` of the loaded face); the whole-family mechanical sweep
  resolves all 78 original top-level declarations to exactly one canonical
  home; every touched file below cx 50; import discipline clean (no zod/SDK,
  no face imports from siblings, no cycles); the guard diff is
  same-strength-plus (regexes verbatim, +2 face pins, family-wide sweep);
  compiled-tree and bundle layout probes pass; all gates green.

## Deliberate deviations from byte-identity (both documented, both benign)

- `const __dirname = dirname(fileURLToPath(import.meta.url));` exists in TWO
  siblings (`ws-exec-loader.ts`, `upload-transport.ts`) — the repo's
  established per-module derivation pattern (telemetry.ts, skill-disclosure.ts
  each derive their own); both are same-depth src/sandbox modules so the
  three-layout resolution is identical to the original single derivation, and
  the one-climb structure guard covers both.
- `createTunnelSession`'s signature reflowed to multiple lines — the added
  `export` keyword pushed the single-line signature past prettier's
  printWidth 120. The body is byte-identical (verified line-for-line).

## Anything deliberately NOT done

- No AGENTS.md edit — it documents the sandbox family only at directory level
  and names no session-manager internals; nothing went stale.
- No changes to `devbridge-tunnel.ts`, `packs/sandbox/tools.ts`, or any test
  file's imports — the face contract held without touching consumers.
- `.jscpd-baseline.json` not regenerated — the moves created no new clones
  and the in-sync gate inside `npm test` stayed green.
- `devbridge-gateway.ts` reports "0 files analyzed" under jscpd (a
  constants-only file below the tool's default minTokens floor) — trivially
  compliant with cx < 50; noted rather than forcing an artificial measurement.
- The legacy `docs/sandbox-upload-design.md` references to `session-manager.mjs`
  are historical design docs (AGENTS.md: trust the filesystem, not the docs)
  and were left untouched.
