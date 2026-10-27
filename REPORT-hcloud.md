# auth/credentials.ts modularization — wave report

Branch `creds-split`, base `aa83ba6`. Goal: land the 593-line
`plugins/huaweicloud-core/src/auth/credentials.ts` monolith (jscpd cx 199)
below the complex-file bar (cx < 50 per file) via an internal module split
with a STABLE public face — same exported names, same import path, same
behavior (the safety-policy.ts precedent). Zero human interaction; all
decisions per documented doctrine.

## Final per-file cx (`npx jscpd <file> --complexity --reporters ai`)

| File (plugins/huaweicloud-core/src/auth/) | tokens/lines | cx  |
| ----------------------------------------- | ------------ | --- |
| credentials.ts (the face)                 | 113/53       | 1   |
| credential-placeholder.ts                 | 135/36       | 12  |
| s1-store.ts                               | 1093/214     | 47  |
| codearts-context.ts                       | 769/139      | 39  |
| sts-expiry.ts                             | 495/58       | 31  |
| obs-config.ts                             | 256/42       | 12  |
| credential-resolver.ts                    | 842/140      | 47  |
| runtime-credentials.ts                    | 145/44       | 9   |
| missing-credential-error.ts               | 190/41       | 3   |

Every touched file is below cx 50. The former monolith: 3473 tokens / 593
lines / cx 199 → a 53-line pure re-export face at cx 1 plus eight siblings.

## Module map

- `src/auth/credentials.ts` — the stable re-export face: all 35 public names,
  re-exported in five groups (S1 store + placeholder; CodeArts + STS + OBS;
  resolver + runtime). Verified mechanically against the pre-split export
  set after every extraction: 35/35, no losses, no additions. The face holds
  zero local definitions (pure `export … from` seam).
- `src/auth/s1-store.ts` — the S1 credential store: `StoredCredentials`,
  `globalCredentialsPath`/`baseHome`, `readGlobalCredentials`,
  `resolveStoredRefs` (the secret-vault ref seam),
  `readGlobalCredentialsResolved`, `StrictS1Read`/`readGlobalCredentialsStrict`
  (the seam every PROPAGATING consumer folds), `writeGlobalCredentials`,
  `setConfiguredBySession`, the last-sync family (`lastSyncPath`,
  `readLastSync`, `writeLastSync`, `LastSyncRecord`, `LastSyncMetadata`), and
  `backupGlobalCredentials`/`restoreGlobalCredentialsBackup`. Family-internal
  export: `ensurePrivateMode` (folded by the OBS config writer).
- `src/auth/credential-placeholder.ts` — the R11 placeholder/masked policy:
  `isPlaceholder` (public), `present` (family-internal, consumed by the
  CodeArts reader and the resolver).
- `src/auth/codearts-context.ts` — `CodeArtsCredentials`,
  `pickDevkitMcpServer`, `readWorkEnvironmentEntry` (private),
  `getParentCwd` (+ the `_parentCwd` cache), `isCodeArtsContext`,
  `readCodeArtsCredentials`.
- `src/auth/sts-expiry.ts` — `StsExpiryInput`, `parseStsExpiry`
  (epoch/ISO/JWT/base64 forms).
- `src/auth/obs-config.ts` — `obsConfigPath`, `WriteObsConfigInput`,
  `writeObsConfig` (the S4 obsutil mirror; folds `ensurePrivateMode` from
  s1-store and `makeError` from error-table).
- `src/auth/credential-resolver.ts` — `ResolvedCredentials`,
  `ResolveCredentialsOptions`, `resolveCredentials` (env > CodeArts >
  S1-with-refs, the R9 `configuredBySession` precedence, the sandbox
  STS-triplet rule, R11 placeholder skipping).
- `src/auth/missing-credential-error.ts` — the #900 onboarding error:
  `OnboardingHint`/`MissingCredentialError` (private types) and
  `missingCredentialError()` (family-internal; NOT re-exported by the face —
  the public surface gains nothing).
- `src/auth/runtime-credentials.ts` — the session-scoped runtime override:
  `runtimeCredentials` state, `setRuntimeCredentials`,
  `clearRuntimeCredentials`, `hasRuntimeCredentials`,
  `resolveCredentialsWithRuntime` (calls `resolveCredentials` across the
  sibling boundary — value import, one direction, no cycle).

Import discipline held by every sibling: node builtins + `lib/as-text` +
`lib/as-record` + `lib/secret-vault/store` + auth siblings — no zod, no SDK
(the structure walk over `src/auth/` auto-covers all of them; the
error-table sibling-free leaf guard is untouched). The family feeds BOTH
graphs (unbundled setup-cli + bundled mcp-server) exactly as before; `npm
run build` was run at every step the import graph changed and `dist/auth/`
carries all nine modules. Runtime/module state stays single-instance: the
`runtimeCredentials` override and the `_parentCwd` cache each live in
exactly one module, and nothing outside `src/auth/` imports any sibling
directly — every consumer (9 src files, 14 test files + 2 harnesses) keeps
the `src/auth/credentials.ts` path, imports NOT rewritten, per the behavior
pins.

## Gate results (final state)

- `npm run typecheck` — 0 errors (src + test projects).
- `npx eslint .` — 0 errors, 73 warnings (the pre-existing allowance; zero
  new).
- `npm run build` — green; `dist/auth/` carries all nine modules; the
  esbuild bundle rebuilds through the new import graph.
- `node --experimental-test-module-mocks --test "test/structure*.test.ts"` —
  114/114 pass (incl. the zod-free walk over the enlarged auth family and
  the jscpd baseline gate: zero new clones).
- `npm test` — 1412 tests, 1410 pass + 2 skip, 0 fail (the contract), run
  green after every extraction step.
- `npm run lint:dup` — exit 0, 179 clones (unchanged from the committed
  baseline; the moved readGlobalCredentials/readLastSync intra-file clone is
  content-fingerprinted, so no baseline regeneration was needed).
- Extra insurance: `npm run validate` (pack boundaries, skills sync) —
  green; `npm run format:check` — clean; `npm run lint:md` — 0 issues.
- Per-step family gates: the direct test importers of the face
  (auth-credentials, auth-onboarding, auth-status-onboarding, reconcile,
  secret-vault-credentials, tools-auth-switch, hcloud-cli-sts,
  hcloud-cli-run, tools-explain-error, hdkitservice-api,
  issue-1003-obs-cors-tool, cred-reconcile-mid/late/e2e) — 172/172 pass
  after every extraction.
- Telemetry stamp residue removed after every full `npm test` run.

## Commits

1. `f089a1a` — refactor(auth): extract the S1 store and placeholder policy;
   credentials.ts keeps the rest (+ the AGENTS.md S1-seam retarget and the
   structure walk's module-count comment, same-strength, same commit as the
   move)
2. `5db4f95` — refactor(auth): extract the CodeArts context, STS expiry,
   and OBS config families
3. `eefaff7` — refactor(auth): extract the resolver family; credentials.ts
   becomes the pure re-export face
4. (this commit) — docs: AGENTS.md module-map bullet + REPORT.md

## Interrogate rounds

Four adversarial passes (one per commit unit). Findings and resolutions:

- Round 1 (S1 store + placeholder): the orphaned "Narrow untrusted parsed
  JSON … collapse to an empty record" comment described a long-gone helper
  (the readers collapse to `null`, not `{}`) — dropped as dead comment noise
  instead of mis-attaching it. `ensurePrivateMode`/`present` became
  family-internal exports with the obsWriteHint-style note. One prettier
  wrap applied (line-length only; bodies re-verified byte-identical after).
- Round 2 (CodeArts/STS/OBS): all 11 moved blocks + 9 kept blocks verified
  byte-faithful; `_parentCwd` and module-state single-instance semantics
  confirmed through the face.
- Round 3 (resolver family): **credential-resolver.ts measured cx 58 — over
  the bar.** Rebalanced per the brief's measurement note (the run/run-once
  precedent): the runtime override tier and the #900 missing-credential
  error became their own modules (47/9/3). The error-path block moved
  verbatim (indent −4, `throw err` → `return err`); the call-site comment
  retargeted to the new module. Import-cycle check over the whole auth
  family: none. Verified nothing outside `src/auth/` imports siblings
  directly.
- Round 4 (final sweep, docs): grep for stale `credentials.ts` definition
  references — the live ones (AGENTS.md seam mention, structure walk count
  comment) were retargeted in the same commits as the moves; CHANGELOG
  mentions are historical and left alone; `src/lib/pack-state.ts` and
  `test/safety-text-command.test.ts` mention the face path, which stays
  valid. markdownlint/format:check on the docs commit.

## Deliberately NOT done

- No test-file import rewrites (the face is the contract; the brief pins the
  direct test importers to `src/auth/credentials.ts`).
- No structure-guard additions or assertion changes: no guard read the
  monolith's source text, so there was nothing to retarget; the only
  structure-test touch was the explanatory module-count comment (made
  truthful — "six of the seven" went stale the moment siblings landed); the
  `authModules.length >= 7` assertion is unchanged.
- No `CORE_VALUE_DIRS` change in `scripts/lib/pack-boundaries.mjs` —
  `src/auth/` was already a directory-scoped entry, so the pack import
  surface is unchanged.
- No `.jscpd-baseline.json` regeneration — zero new clones (the moved
  intra-file clone's fingerprint is content-based, location-independent).
- docs/CHANGELOG.md historical mentions left untouched; no CHANGELOG entry
  for a refactor wave (repo convention: entries ride the release flow).
- `s1-store.ts` lands at cx 47 — under the bar but close; splitting the
  last-sync sidecar out was considered and rejected: the brief's own cluster
  map lists it as S1 store IO, and 47 < 50 needs no rebalance.
