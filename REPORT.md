# Wave 4 — cmdDoctor table-driven refactor: REPORT

Branch `doctor-refactor`, stacked on jscpd@d1833ef. 12 commits, all gates
green at every commit, doctor output pinned byte-for-byte throughout.

## Success criteria

| Criterion          | Target        | Measured (final)                                           |
| ------------------ | ------------- | ---------------------------------------------------------- |
| Every touched file | cx < 50       | max 48 (`agents/codex.ts`, `agents/officeace-registry.ts`) |
| `setup-cli.ts`     | cx < 400      | **379** (from 879; 3334 → 1560 lines)                      |
| Gates              | all green     | see below                                                  |
| Behavior           | byte-for-byte | goldens a/b/c exact at every commit                        |

## Per-file final cx (measured with `npx jscpd <file> --complexity --reporters ai`)

```
 379  src/setup-cli.ts                     (was 879)
  48  src/agents/codex.ts                  (was 90)
  48  src/agents/officeace-registry.ts     (new, split out of officeace.ts)
  47  src/agents/codex-desktop.ts          (new, split out of codex.ts)
  47  src/agents/hermes-hooks.ts           (new, split out of hermes.ts)
  44  src/agents/workbuddy.ts              (was 39, + candidate)
  44  src/agents/officeace.ts              (was 121)
  43  src/agents/officeace-sqlite.ts       (new, + packs writer)
  43  src/officeace-paths.ts               (was ~15, + path family)
  42  src/agents/hermes.ts                 (was 140)
  42  src/agents/dsh-patch.ts              (new, split out of dsh.ts + binding)
  42  src/doctor-native.ts                 (new)
  41  src/proxy/cli.ts                     (new)
  39  src/mcp-config-io.ts                 (was 37, + manifest writer)
  39  src/agents/opencode-config.ts        (new, split out of opencode.ts)
  38  src/auth/init-cli.ts                 (new)
  38  src/packs-cli/write-command.ts       (new)
  37  test/structure-deps.test.ts          (touched: retargets)
  36  src/agents/dsh.ts                    (was 73)
  36  src/install-prompts.ts               (new)
  36  src/agents/hermes-config.ts          (new, split out of hermes.ts)
  34  src/packs-cli/slots.ts               (new)
  33  src/packs-cli/writers.ts             (new)
  32  src/agents/opencode.ts               (was 49)
  32  src/install-plan.ts                  (new)
  32  src/packs-cli/report.ts              (new)
  31  src/mcp-config-io.ts — see above
  30  src/packs-cli/commands.ts            (new)
  29  src/agents/codearts-work.ts          (was 24, + candidate)
  28  src/auth/cli.ts                      (new)
  22  src/agents/atomcode.ts               (was 17, + candidate)
  21  src/auth/hcloud-profile.ts           (new)
  19  src/mcp-agent-config.ts              (new)
  19  src/packs-cli/doctor.ts              (new)
  15  src/agents/hermes-sdk.ts             (new, split out of hermes.ts)
  15  src/agents/codearts.ts               (was 10, + candidate)
  14  src/agents/openclaw.ts               (was 9, + candidate)
  13  src/agents/hermes-hook-plugin.ts     (new, split out of hermes.ts)
   6  src/doctor-payload.ts                (new)
   1  src/doctor-report.ts                 (new)
   1  src/lib/banner.ts                    (new)
  20  scripts/doctor-golden.mjs            (new capture CLI)
   8  scripts/lib/doctor-golden.mjs        (new harness, measured 20 for the CLI twin)
   9  test/doctor-golden.test.ts           (new)
  37/44/46/29  the four touched structure test files
```

## Golden status

All three fixtures are **byte-exact** on this machine at every commit:
(a) empty fake HOME, (b) fake HOME after a real `install --target opencode`,
(c) hermes + officeace markers staged (capabilities.json + dist marker +
sqlite DEVKIT_PACKS row). No fixture degraded to structural assertions.

Determinism contract (scripts/lib/doctor-golden.mjs, shared by the capture
CLI and `test/doctor-golden.test.ts`): fake-HOME env per the
doctor-helpers pattern; `HCLOUD_BIN` = node with
`HCLOUD_BIN_ARGS_JSON` pointing at a committed `fake-hcloud.mjs` shim
(mirrors `kooCliVersion` from package.json); the doctor run's cwd pinned to
the fixtures dir so the shell-spawned `"<node>" configure list` resolves the
extensionless `configure` entry (pins credentials-PASS); `PATH` = the
fixtures dir only (pins Hermes-SDK FAIL via unreachable python3, absent
codex attribution, and the open-mcp-gateway not-found WARN — on every
machine, Windows included); `HW_VAULT_MASTER_KEY` = fixed 32-byte env-tier
key (custody never probes the host keychain → the deterministic
"Secret vault ready (env custody, 0 secret(s))" PASS);
`HUAWEICLOUD_OPENCODE_PERMISSION_SEAM=on` at both install and doctor time.

Documented normalization list (the ONLY accepted diffs): ANSI escapes; the
banner's version line (pkgVersion changes width-dependent padding); the
hcloud `Version:` line. A pkgVersion/kooCliVersion bump is absorbed; any
other output change is a defect or a deliberate regen
(`node scripts/doctor-golden.mjs --regen`, documented in AGENTS.md).

Caveat, honestly stated: the goldens are designed cross-platform (the
node-launch shim and the extensionless `configure` entry work under
cmd.exe), but this run could not EXECUTE the suite on Windows — CI's
windows-latest lane is the proof. The suite (including the golden test)
passed here on linux/Node 24.

## Gate results (final tree, and at every commit)

- `npm run typecheck` — green (src + strict test projects).
- `npx eslint .` — 0 errors; 73 warnings vs the 74-problem pre-wave
  baseline (no new problems; two stale unused-vars in test files removed).
- `node --experimental-test-module-mocks --test "test/structure*.test.ts"`
  — 114 pass, 0 fail (113 pre-wave + the new chain-coverage guard).
- `npm test` — 1412 tests: 1410 pass + 2 skip (the pre-wave 1408/1406+2
  contract plus the 3 new golden tests and 1 new structure guard test).
- `npm run lint:dup` — green; 179 clones throughout, identical to
  baseline; the `.jscpd-baseline.json` was NOT regenerated (no
  moved-not-deleted clones were flagged at any step).
- Extra (AGENTS.md commit checklist): `npm run validate` ✓,
  `npm run pack:verify` ✓ (450 files, install OK — the new modules ship),
  `npm run format:check` ✓, `npm run lint:md` ✓.

## Commit list

1. `9907533` test(doctor): pin doctor output byte-for-byte; split
   agents/hermes under the cx bar — the golden pin (script + harness +
   fixtures + `test/doctor-golden.test.ts` joining the suite) lands together
   with the first refactor step (hermes → hermes-config/-hooks/-hook-plugin).
2. `1b90681` refactor(dsh): split the cordis.patch.yml managed-block family
   into agents/dsh-patch.ts.
3. `05e14e6` refactor(officeace): split the sqlite and registry families
   out of agents/officeace.ts (path family → officeace-paths.ts).
4. `7ec0ff6` refactor(codex): split the Codex Desktop family into
   agents/codex-desktop.ts.
5. `ec82b45` refactor(opencode): split the config writers and seam
   machinery into agents/opencode-config.ts.
6. `29d0135` refactor(doctor): bind the payload triple and native freshness
   to PAYLOAD_TARGETS rows (doctor-report/-payload/-native + the
   every-row-binds-a-doctor guard).
7. `bff6aa6` refactor(doctor): move the MCP-configured candidates, seam,
   and hermes SDK sections to their agent modules (+ chain-coverage guard).
8. `40b3b65` refactor(packs): extract the packs-cli family (slots, writers,
   union, doctor face, commands) — includes the `raw`/`countWarn` reporter
   additions (autosquash-fixed into this commit).
9. `f513c55` refactor(install): extract the install-planning family
   (detect, prompts, generic MCP config).
10. `47a6b18` refactor(auth): extract the auth CLI family (dispatch, init
    flow, profile helpers) + lib/banner.ts.
11. `cd77949` refactor(proxy): extract the proxy CLI family — setup-cli
    lands at cx 379.
12. `051c7aa` docs(AGENTS): describe the table-driven doctor and the
    extracted command families.

## Interrogate rounds

12 (one full adversarial pass per commit over the diff since the last
commit). Defects caught and fixed inside the loop, among others: hermes-hooks
over the cx bar (plugin family split out); codex-desktop over the bar after
its candidate (codexDesktopStatus relocated to the status-face module);
`import/no-duplicates` + unused-import churn; a `no-regex-spaces` error in
the new guard; four stale source-text guards (retargeted, none weakened);
the byte-exactness catch that the unknown-id advisory line is a RAW 8-space
line (not INFO) and that `renderSecretsPackNote` returns a warn COUNT the
shell must add — both fixed via the `raw`/`countWarn` reporter methods
before any golden-detectable drift; and one commit-hygiene defect found in
the final round — the reporter additions were never staged into the packs
commit, leaving it non-building in isolation — repaired with an
`--autosquash` fixup. The final (12th) pass over the complete diff yields
ZERO findings.

## Deliberately NOT done

- **No `dshMcpClientAvailable` doctor check.** The design bullet names it
  ("the dsh patch / mcp-client package checks"), but today's doctor has no
  such check, and the byte-for-byte golden contract forbids adding output.
  The dsh doctor section therefore covers the MCP-configured candidate
  (dshPatchConfigured) and the row's package-root binding — the surface
  that exists. `dshMcpClientAvailable` stays in dsh.ts for dshStatus.
- **No new officeace sqlite check.** Read the same way: the officeace
  section's "sqlite-connector check" is the existing PACK_SLOTS
  readOfficeaceDevkitPacks path; it is now pinned byte-exactly by golden
  fixture (c) (the "Packs (OfficeAce): core, huaweicloud-cli" line and the
  secrets WARN) instead of gaining a new check.
- **The `--clean-*` AccountLevelArtifact family untouched** (out of scope
  per the brief) — verified still in setup-cli verbatim.
- **cmdInstall / cmdStatus / cmdUninstall / cmdUpdate / main dispatch stay
  in setup-cli** — the cx-400 gate was reached without moving them, and the
  table + dispatch are doctrine-owned there.
- **The PACK_SLOTS family moved wholesale** (including the command bodies).
  The brief allowed this "only if it falls out naturally — do not force
  it": the doctor refactor moved the pack-status section INTO the family,
  leaving the slots/writers/report in setup-cli as an orphaned island while
  the mandated cx-400 gate still required ~145 more cx out — the family
  unity fell out at that point. Documented here as the one judgment call
  that went beyond the doctor design proper (auth/proxy/install-plan
  extractions were pure cx-budget needs, each a cohesive self-contained
  command family).
- **`rosterCore ?? []`** in doctor-native.ts — an unreachable-path type
  tweak (the shell runs freshness only inside its non-null corePack guard),
  documented inline; no reachable behavior change.
- **jscpd baseline not regenerated** — no new duplication was ever flagged.
- **Windows execution unverified locally** — see the golden caveat above.
