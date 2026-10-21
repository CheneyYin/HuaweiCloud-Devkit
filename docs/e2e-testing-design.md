# E2E Testing Design (agent-level suite)

The suite lives in `test/e2e/`, gated by `E2E_ENABLE=1` (`npm run test:e2e`),
and runs in CI on three lanes as a two-driver matrix (`E2E_AGENT` selects
the leg, default opencode): nightly on v2, every push to v2, and an opt-in
`run-e2e` label for same-repo PRs into v2 (never in the required PR gate).
It is the mechanism-verification tier of the agent-level test story; the
real-cloud guidance tier is `test/huaweicloud-agent-toolkit-test/` (see
Division of labor below).

## What is under test

The devkit's **observable outbound behavior** after a real tarball install,
driven by a real, unmocked code agent (opencode or codex headless, real
LLM) against the fake Huawei Cloud boundary. The agent layer is never
mocked; the Huawei Cloud boundary is fully fake but recording. Cases are
driver-agnostic data: every assertion surface works for both legs.

| Channel                            | Seam                                                                                                      | Owner                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| hcloud argv                        | `HCLOUD_BIN` + `HCLOUD_BIN_ARGS_JSON` + `HCLOUD_FAKE_LOG` (+ `HCLOUD_FAKE_SCRIPT`, `HCLOUD_FAKE_VERSION`) | env contract (long-standing)                                |
| HTTP (hdkitservice / IAM / hwlink) | `HDKITSERVICE_ENDPOINT`, `HW_IAM_ENDPOINT`, `HWLINK_ENDPOINT` → local `HttpFake`                          | env contract (long-standing)                                |
| gateway sidecar                    | `OPENMCP_BIN` (+ fixture knob `FAKE_POLICY`, recording `OPENMCP_FAKE_LOG`)                                | env contract (long-standing)                                |
| icons manifest                     | `HUAWEICLOUD_ICONS_OFFLINE=1` (forces the bundled snapshot; case-scoped `E2eCase.env`)                    | env contract (long-standing)                                |
| npm registry (update pack)         | `HUAWEICLOUD_NPM_REGISTRY` → local `HttpFake`, honored by `queryDistTags` on both faces                   | env contract (extended — see Known boundaries)              |
| tool-call trace                    | `HUAWEICLOUD_DEVKIT_TRACE` (see below)                                                                    | new contract, frozen                                        |
| disclosure events                  | same trace file, recorded at the stdio transport's outbound wire face                                     | new contract, frozen                                        |
| file artifacts                     | HOME-relative paths under the throwaway home                                                              | installer layout (pinned by cross-platform-install.test.ts) |

## Coupling classification (test → devkit dependency health)

Every assertion surface, classified:

- **(a) Stable public seam.** All env vars above; the MCP protocol surface
  (tool names, tools/list roster, tools/list_changed notification); pack
  posture via the operator channel (`install --packs`); the installed file
  layout. These survive behavior-preserving refactors by construction.
- **(b) Product feature that IS the test surface.** The plan → approval →
  run sequence and its token contract; pack trimming disclosure; the
  consent protocols (sandbox agreement, gateway policy refusal); credential
  persistence artifacts (S1 vault, `~/.obsutilconfig`, `hcloud configure set`
  argv). Tests here are SUPPOSED to break when the behavior changes.
- **(c) Frozen contract, deliberately promoted.** The
  `HUAWEICLOUD_DEVKIT_TRACE` record schema (see below). It lives in product
  code (`src/lib/call-trace.ts`), is versioned (`v: 1`), redaction-guaranteed,
  and pinned by `test/call-trace.test.ts` — changing it is a deliberate
  contract edit in the same change as the tests that read it.

Non-couplings, by design: hcloud argv flag ORDER is agent-authored (the
matcher is order-insensitive; only the Service/Operation head and
prompt-pinned flag values match literally); tool RESULT payloads are asserted
via outbound effects, never echoed text; agent free text is a soft
(non-gating) signal.

## The trace contract

`HUAWEICLOUD_DEVKIT_TRACE=<absolute path>` enables a JSONL append, one
object per line, two discriminated shapes, `v: 1`:

```
{ type: 'toolCall', v, ts, name, args, ok, error? }
{ type: 'disclosure', v, ts, event: 'toolsList'|'toolsListChanged', toolCount? }
```

- Redaction: args pass `redactSecrets` plus a supplemental `api_key` /
  `apiKey` denylist BEFORE the write; credentials never reach the file. The
  file is created 0600. Best-effort: a trace write error never fails a tool
  call.
- Scope: `toolCall` records only calls that reached `callTool`'s dispatch —
  SDK-level zod validation rejects a call BEFORE `callTool` and is
  deliberately not traced (that path is pinned by mcp-server.test.ts).
- **Emission ≠ delivery.** Recording `toolsListChanged` proves the server
  EMITTED the notification in a live stdio session. Client-side convergence
  (delivery) is covered by the in-memory unit tests (packs-configure.test.ts)
  and by the trimmed-disclosure E2E case observing the client-visible roster.

## Hermeticity contract

`test/e2e/env-policy.ts` is the single env assembly point (pin test:
`test/e2e-env-policy.test.ts`). Merge order is fixed: trimmed process env →
throwaway-home relocation (HOME/USERPROFILE/HOMEDRIVE/HOMEPATH/
HUAWEICLOUD_HOME + XDG_* + CODEX_HOME) → driver vars → seam vars →
case env → fixed posture overrides. Stripped: all six proxy spellings,
`HW_*` credentials, KooCLI config paths, `DEVKIT_PACKS` (posture rides
`install --packs` only), and the ambient agent-home override family
(`OPENCODE_CONFIG`, `HUAWEICLOUD_DEVKIT_HOME`, `ATOMCODE_HOME`,
`HERMES_HOME`, and siblings — the real-agents sandboxEnv precedent).
Pinned: `HUAWEICLOUD_DEVKIT_TELEMETRY=off`, `HUAWEICLOUD_DEVKIT_SKIP_UPDATE=1`,
`HUAWEICLOUD_INJECT_STS_CMD=0`, `NO_PROXY` for localhost. The HTTP boundary
env vars point at the local fake for EVERY case — scripted or not — so no
request can leave the machine (unknown paths answer 404 fast).

Auth: a dedicated E2E API key via env (`E2E_APIKEY` / `E2E_TEST_API_KEY`),
written into the throwaway home's opencode auth.json (0600; the codex leg
delivers it through its env_key + mcp-env.json path instead). Real auth
files are never copied. Local config: gitignored `test/e2e/.env`.

## Known boundaries

- **Windows**: compatible by construction (5-var home recipe, execPath shim,
  single-point case-insensitive env merge, npm.cmd, matcher normalization),
  but executed on Linux only. Windows behavior is unverified until a Windows
  runner exists. The codex driver is Linux-stricter still: its spawn of the
  bare `codex` binary cannot resolve npm's `.cmd` shim on win32, so the
  codex leg cannot even probe there until a shell-aware resolution lands.
  open-mcp cases skip on win32 with a recorded reason
  (`OPENMCP_BIN` resolution is path-only — no args-prefix seam; add
  `OPENMCP_BIN_ARGS_JSON` to lift).
- **Order sensitivity**: `hashArgs` keeps string-array order (product
  semantics, approval-tokens.ts), so a model that re-orders flags between
  plan and run gets "args do not match the approved plan". Prompts pin flag
  order; this remains a known retry-worthy jitter source.
- **ws-exec boundary: faked since P2.** The local hwlink fake
  (test/e2e/ws-fake/) speaks the product's binary protocol through the
  product's own codec and marker vocabulary, covers exec one-shot and
  session semantics, upload_file (b64 batches → decode → true-md5
  verification), upload_project (tunnel relay + in-fake HTTP file server),
  and the deploy probes/marker synthesis. Remaining unfaked: the real
  PTY's echo/canonical quirks (the fake never echoes input — a legal
  client-side mode), and devbridge itself (the tunnel URL is synthesized
  to satisfy the domain-pinned pattern, never fetched).
- **update pack**: covered since the registry seam landed. The earlier "no
  env seam" note was half-wrong: `HUAWEICLOUD_NPM_REGISTRY` existed but only
  the CLI face honored it — the MCP tool face's default query spawned
  `npm view` and ignored the var. The seam now delegates in `queryDistTags`
  itself, so both faces honor it; update cases relax exactly
  `HUAWEICLOUD_DEVKIT_SKIP_UPDATE` (the env-policy whitelist's only entry,
  type-level) and point the registry at the local HTTP fake. The npm child
  process is deliberately NOT intercepted (PATH shims would also capture the
  installer's own npm; `npm_config_registry` would hijack every session npm
  and depends on npm-internal endpoint shapes).
- **search_marketplace: no hermetic case possible.** `INDEX_URL` is
  hardcoded (search-market.ts) with an in-memory cache only — no env seam.
  Covering it needs a product seam (an `HUAWEICLOUD_MARKETPLACE_INDEX`-style
  override); until one lands, this tool has no E2E case.
- **LLM cost/latency**: a single case takes 1 to 4 min with an attempts cap
  of 2. A full opencode leg covers all 31 cases and measured ~34-40 min
  wall clock (first-attempt passes); the codex leg covers 29 cases plus 2
  recorded skips (the installPacks channel has no codex write path) with
  ~18.6k base tokens per model turn — timing extrapolated pending the
  first nightly. Per-attempt budget caps sum to 147 min single-pass /
  294 min worst case for opencode (139/278 for codex), which the CI job
  timeout of 330 min per leg covers. Failures attach per-attempt summaries
  (recorded call lists, transcripts, verdict evidence) to the JSON report
  for offline triage.

## The codex driver

`test/e2e/drivers/codex.ts`, spike-validated on codex-cli 0.162.1. The
mechanics that differ from opencode, all measured:

- **Server declaration.** An enabled plugin's `.mcp.json` server loads
  BESIDE any `mcp_servers` entry, and same-named tool calls dispatch
  nondeterministically to either — the plugin copy runs the real payload
  but is spawned bare, so its calls leave no trace and no fake-log
  recordings. The driver disables the plugin registration in config.toml
  (fail-loud on installer-output drift) and declares the installed
  plugin-cache server itself (`mcp_servers.hwc`): the payload under test
  stays the tarball-installed one, and the sole server is instrumented.
- **MCP child env.** codex strips MCP children to login vars plus the
  server's config env block. The full merged case env is delivered through
  a loader script fed by a per-attempt `mcp-env.json` written by runPrompt
  from `req.env`.
- **Model wire.** codex 0.162.1 is responses-only (chat hard-removed), so
  the provider must serve the Responses wire. A local shaping proxy
  (driver-owned, ephemeral port) strips the two request shapes the gateway
  rejects (`function_call.namespace`, array-form
  `function_call_output.output`) and mirrors the provider base URL's
  pathname so path-prefixed gateways reconstruct correctly. The
  `E2E_CODEX_PROXY_DUMP=<file>` knob dumps the shaped wire for triage.
  Auth rides the config.toml `env_key` naming `E2E_APIKEY` (the driver
  bridges the `E2E_TEST_API_KEY` spelling); the value reaches the MCP
  child via the 0600 mcp-env.json inside the throwaway home.
- **Posture.** danger-full-access: plain workspace-write denies every MCP
  tool call under exec's never-approval, and `--approve-for-me`'s guardian
  review dials an OpenAI model slug a custom gateway 404s. The trust level
  matches the opencode leg (equally unsandboxed headless). The env-level
  egress block (`https_proxy` to a closed port, both install and run envs)
  kills codex's startup curated-plugins catalog clone (~100 MB from github
  per fresh home) and every other codex https egress.
- **Escape residual (local runs only).** A model can unset the proxy vars
  and call the host's real hcloud by absolute path — measured, including
  reading the host's real credentials. CI runners install no real hcloud,
  so the escape target is absent there; local runs on machines with one
  carry this documented residual.
- **Egress-block residual.** The proxy env vars are model-visible; the
  whole serialized report (transcripts, hcloud argv, expectation evidence)
  passes the scrub for the two E2E key values, but ambient host secrets a
  model reads and echoes are out of scope (local-run residual).
- **finalText** comes from codex's `-o` file with no stdout fallback: the
  transcript carries prompts, commands, and reasoning, so keyword matches
  against it would pass cases the model turn never completed.

The two `installPacks` cases record a skip on the codex leg (the codex
install target is managed by the codex CLI and has no `--packs` write
path — the runner resolves the capability skip before any attempt spends
budget).

## Division of labor: this suite vs the nightly real-cloud harness

`test/huaweicloud-agent-toolkit-test/` (the devkit-test SKILL) answers "can
the plugin GUIDE an agent through real cloud operations" — real credentials,
real resources, cleanup discipline. This suite answers "does the devkit
initiate the right outbound behavior" — fake boundary, mechanism contracts,
hermetic, cheap enough for per-iteration runs. Case id vocabularies are
independent; a capability covered by both (CLI write flows) deliberately
differs in tier: consent mechanics here, guidance completeness there.

## Runner mechanics

Custom runner (not node --test) because gating, per-case budgets,
process-group teardown, and the JSON report shape are runner concerns, not
test-framework concerns. Serial by default. Each attempt gets a fresh
throwaway home + workdir + fake set; the agent is spawned in its own process
group and killed tree-wide on timeout; a startup sweep removes stale
`hwc-e2e-*` temp dirs older than a day (signal-death self-healing).
`selfcheck` subcommand proves the full chain (tarball → install → MCP server
→ callTool → fakes) without the LLM.

CI (`.github/workflows/e2e-nightly.yml`): the only required repository
setting is the `E2E_TEST_MODEL_APIKEY` secret. Provider/model/baseURL default
to the committed values in the workflow (an OpenAI-compatible gateway
serving BOTH wire shapes the legs need — chat for opencode, responses for
codex — plus glm-5.2, the model both legs share for verdict comparability)
and stay overridable via the `E2E_TEST_*` vars; a provider swap must keep
the responses route or the codex leg fails at its first model call
(measured: maas has no responses route). The preflight step fails fast on a
missing secret. Both agent CLIs are pinned to the versions the suite was
verified against (an upgrade is an explicit suite event; the codex pin is
shared with ci.yml's real-agent lane). Local runs read the gitignored
`test/e2e/.env` instead; the report records agent/model/agentVersion per
run so drift between the two sources is visible, not silent. Each leg's
run step greps the runner's driver echo so an `E2E_AGENT` wiring miss
fails loud instead of passing as a green duplicate of the other driver.

The workflow file must stay byte-identical on main and v2, and a drift-guard
step inside the run fails loud on skew once both copies exist — a missing
main copy is the bootstrap window (warn and pass). Land workflow changes
main first, then v2: main-side landings trigger no automatic lane (the cron
reads main's copy but fires once a night), while the v2-side push lane runs
immediately and goes green against the already-landed main copy. Schedule
and dispatch events read main's registered copy (schedule only fires from
the default branch) and check out v2 — the suite's bloodline — while push
and pull_request events read the pushed ref's own copy. PR runs are opt-in
via the `run-e2e` label (same-repo PRs only; fork PRs skip, they cannot see
the secret), and a labeled PR re-runs on every synchronize. Concurrency is
job-level so runs skipped by the label guard never cancel an in-flight
suite; each matrix leg (opencode, codex) serializes in its own group with
`fail-fast` off so a red leg never cancels its sibling's report.

Bootstrap closure (measured 2026-10-21: main has never carried the file,
so the nightly cron is dormant — schedule fires only from the default
branch). The first main landing activates the nightly as a two-leg matrix
(~80 min LLM per night) and arms the strict drift guard. While the window
is open the guard is lenient, so the safe sequence for THIS landing is:
merge the v2 PR (carrying code plus the workflow), validate the matrix on
the PR ref via the `run-e2e` label, then land the byte-identical workflow
on main — the cron activates against a v2 that already matches, so no
skew window exists. The steady-state main-first rule applies once both
copies exist.
