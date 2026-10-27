# REPORT — proxy/proxy-config.ts modularization (prxcfg wave)

Branch `proxcfg-split`, base `89783468`. Task: bring
`plugins/huaweicloud-core/src/proxy/proxy-config.ts` (244 lines, jscpd cx 102) below the complex-file bar (cx < 50 per file) via an internal module
split with a stable public face — the safety-policy precedent, ninth
application.

## Outcome

`proxy-config.ts` is now an 18-line re-export face; the knowledge moved into
three siblings inside `src/proxy/` (the family dir the zod-free walk and
pack-boundaries `CORE_VALUE_DIRS` already list). Public surface unchanged:
same nine exported names (`ProxyConfigFile`, `ProxySettings`,
`proxyConfigPath`, `readProxyConfig`, `writeProxyConfig`, `clearProxyConfig`,
`shouldBypassProxy`, `getProxySettings`, `getProxyUrlForTarget`), same import
path (`src/proxy/proxy-config.ts`), same behavior — verified programmatically
(7 runtime exports importable; both type re-exports resolve through a strict
tsc probe) and by declaration-level diff: all 18 top-level declarations moved
verbatim modulo the `export` keyword on the three family-internal CIDR names.

## Module map

| Module               | Domain                                                                                                                                                                           | Lines | cx                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------- |
| `proxy-config.ts`    | stable re-export face                                                                                                                                                            | 18    | 1 (below jscpd's default 50-token analysis floor; `--min-tokens 10` shows 31 tokens / cx 1) |
| `proxy-config-io.ts` | the on-disk proxy.json store: `ProxyConfigFile`, `baseHome`, `proxyConfigPath`, `readString`, `readProxyConfig`, `writeProxyConfig`, `clearProxyConfig`                          | 73    | 16                                                                                          |
| `proxy-cidr.ts`      | the BigInt CIDR engine: `ipv4ToInt`, `groupsToBigInt`, `ipv6ToBigInt`, `ipv4MappedV6ToBigInt`, `CidrRule`, `parseCidr`, `ipInCidr` (IPv4 + IPv6 + mapped forms, both directions) | 98    | 40                                                                                          |
| `proxy-bypass.ts`    | the no_proxy policy + resolution tiers: `ProxySettings`, `shouldBypassProxy`, `getProxySettings`, `getProxyUrlForTarget`                                                         | 90    | 46                                                                                          |

Out of scope after measurement: `proxy-agent.ts` (cx 17, the undici
dispatcher — the one module allowed to touch undici) and `cli.ts` (cx 41,
the `proxy` command family) were already under the bar and untouched.

## Why three modules, not the natural two

The task outline's natural shape was io + bypass. Measured counterfactual:
the combined engine half (cidr + bypass bodies, comments intact, as one
file) measures **cx 86** — over the bar. Per the brief's measurement note
("rebalance when a module lands over the bar"), the CIDR primitives carved
out as the third sibling; every module then lands under 50 (16/40/46).
jscpd's cx is not additive across files and is comment-sensitive — measured
per file after every cut, never estimated.

## Import discipline

- Siblings are node-builtin-only (io: `node:fs`/`node:path`/`node:os`; cidr:
  none; bypass: two intra-family imports). No zod, no SDK, no undici —
  verified by the `structure-installer-cmds` recursive walk of `src/proxy/`,
  which picked the new siblings up automatically (no guard edits needed; the
  directory walk IS the guard).
- No `__dirname`/`import.meta.url` derivation anywhere in the family — no
  bundle depth trap; the depth-climb guard passes.
- `proxy-bypass.ts` imports `readProxyConfig` from `proxy-config-io.ts` and
  `parseCidr`/`ipInCidr` from `proxy-cidr.ts` (family-internal edges, no
  cycles). All six external consumers keep importing the face — none were
  rewritten: `src/hcloud-run-once.ts`, `src/mcp-server.ts` (dynamic),
  `src/setup-cli.ts`, `src/proxy/cli.ts`, `src/proxy/proxy-agent.ts`,
  `test/proxy-agent.test.ts`.

## Gate results (all green, run on the final tree)

| Gate                                                                     | Result                                                                                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                      | 0 errors (src + strict test projects)                                                                                                                    |
| `npx eslint .`                                                           | 0 errors, 73 warnings — exactly the pre-existing allowance, none in the proxy family                                                                     |
| `npm run build`                                                          | dist rebuilt; family compiled to `dist/proxy/{proxy-config,proxy-config-io,proxy-cidr,proxy-bypass}.js`; bundled `dist/mcp-server.js` carries the engine |
| `node --experimental-test-module-mocks --test "test/structure*.test.ts"` | 123/123 pass (matches base)                                                                                                                              |
| `npm test`                                                               | 1421 tests, 1419 pass + 2 skip (pre-existing KooCLI preinstall lock skips; matches base contract)                                                        |
| `npm run lint:dup`                                                       | exit 0; zero clones in the proxy family — no moved-not-deleted duplication (baseline untouched, no regen needed)                                         |
| `npm run validate` (extra)                                               | exit 0 — pack boundaries (28 modules) + skills sync                                                                                                      |
| `npm run pack:verify` (extra)                                            | exit 0 — 658 files, install OK                                                                                                                           |
| `npx prettier --check` (4 files)                                         | clean                                                                                                                                                    |
| Telemetry residue after full `npm test`                                  | 4 stamp files removed per common rules                                                                                                                   |

Behavior pins: `test/proxy-agent.test.ts` untouched — its 23-case bypass
matrix (IPv4/IPv6/mapped CIDR forms, malformed patterns, bracketed URL
hostnames, both env spellings, end-to-end dispatcher agreement) pins the
split and passed unmodified.

## Commits

1. `86971d77` — `refactor(proxy): split proxy-config into the io/cidr/bypass
family; proxy-config.ts becomes the re-export face` (4 files, +279/−244)
2. This commit — `docs(proxy): AGENTS.md family-map entry and the wave
report` (AGENTS.md bullet inserted after the auth face entry;
   REPORT-prxcfg.md)

## Interrogate rounds

- **Round 1** (over the refactor diff): one finding — the cidr module's
  header comment rewords the original file header ("CIDR matching for
  no_proxy (main 1.1.9)" → "The CIDR engine for no_proxy matching (main
  1.1.9)") with content preserved and a role note appended; adjudicated
  deliberate (function-inline behavior comments — the URL.hostname bracket
  note, the ::ffff: mapped-form note, the one-key-reads note — are verbatim,
  pinned by the declaration diff). No defects. Public surface, behavior,
  importers, guards, formatting, doctrine all verified clean.
- **Round 2** (counterfactuals + cross-references): zero findings. Probes:
  two-module counterfactual measurement (cx 86 → justifies the third
  sibling); skills/docs reference sweep (none); the only `no_proxy` consumer
  outside `src/proxy/` (`hcloud-run-once.ts`) imports the face; validate +
  pack:verify green.
- **Round 3** (over the docs diff): zero findings — markdownlint clean, the
  AGENTS.md entry matches the observed facts (numbers cross-checked against
  the measurements above).

## Deliberately NOT done

- No guard retargeting: no structure test reads `proxy-config.ts` source
  text by name — the load-bearing guard is the recursive `src/proxy/` walk
  in `structure-installer-cmds.test.ts`, which covers the new siblings with
  zero edits (coverage went 3 → 6 files on the same assertion strength). No
  test was added, weakened, or strengthened.
- No importer rewrites: all six direct importers keep their existing
  face-imports, per the task's behavior pins.
- `proxy-agent.ts` / `cli.ts` untouched (cx 17 / 41, under the bar).
- No baseline regeneration for lint:dup (no new clones; the moved code
  exists exactly once).
- The pack-state.ts comment listing `proxy-config` among modules that "may
  migrate here when next touched" left as-is: it names the face's future
  migration, not this split, and migrating the config base is out of scope.
