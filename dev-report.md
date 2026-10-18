# Dev Report — Issues #919 #920 #921 #922

Branch: `issue/919-922-1024-fixes` (from `upstream/dev` @ 366d6fd)
Commit: `4af7511` — pushed to `origin`.
Scope: code + skills changes only inside this repo; no PR created, no issue edits.

---

## Issue #919 — Sandbox expose persistence & tunnel durability

**Changed files**

- `plugins/huaweicloud-core/src/sandbox/session-manager.mjs`
  - `buildDevbridgeExposeScript` now backgrounds `devbridge host` with
    `setsid nohup devbridge host -p <port> -e 72 ... < /dev/null & disown`
    (constant `DEVBRIDGE_HOST_EXPIRY_HOURS = 72`) so the tunnel is not tied to
    the exec session's process group and is not killed when the session ends.
  - New `buildDevbridgeVerifyScript`: a second exec-session GET recheck of the
    tunnel URL; the URL is validated against `/^https:\/\/[A-Za-z0-9:._/-]+$/`.
  - `exposeTunnel` now returns `expiresAt`, `expiresInHours`, `verifyHttpCode`,
    `persistent`, and adds a "隧道将在会话结束后失效，请勿分享" warning when the
    fresh-session recheck fails (tunnel did not survive).
- `plugins/huaweicloud-core/skills/huawei-sandbox/SKILL.md`
  - Workspace URL vs public share link section: the authenticated workspace URL
    (`https://<port>-<container_id>.workspace.developer.huaweicloud.com/`)
    returns **401 Unauthorized** when opened logged-out — that is NOT an
    exposure failure; the only shareable link is the DevBridge tunnel URL.
  - Step 0: check `devbridge version` first and install/upgrade 0.1.x → 0.2.x
    in place (0.1.13 connects to a migrated gateway serving 「服务已迁移」).
  - Third install layer (GitHub release tar.gz
    `devbridge_linux_arm64_<ver>.tar.gz`), `setsid` scripts ×3, DevBridge API
    Key 前置引导 at workflow step 7 (before expose, not mid-expose).
- `test/session-manager.test.mjs` — 35/35 pass.

## Issue #920 — Credential sync honesty (`auth init`)

**Changed files**

- `plugins/huaweicloud-core/src/auth/reconcile.mjs` — new
  `runHcloudProfileDelete(profile)` (wraps `hcloud configure delete`).
- `plugins/huaweicloud-core/src/tools.mjs` — `persistCredentials` walks the
  delete/recreate path when `securityToken` is empty (a stale permanent-key
  profile must not survive a token-scoped re-auth); sets `hcloud.profileReset`.
- `plugins/huaweicloud-core/src/setup-cli.mjs` — `cmdAuthInit` now:
  1. resets the profile when no security token is present,
  2. prints Project ID resolution failure as a red ERROR with consequences and
     recovery commands,
  3. runs `verifyHcloudIdentity(region)` (`hcloud STS GetCallerIdentity`) and
     only prints "Credentials synchronized." when it passes; otherwise prints
     the error and sets `process.exitCode = 1`.
- `test/cred-reconcile-e2e.test.mjs` — 2 new tests ("24"/"24b"); 28/28 pass.
- `test/fixtures/fake-hcloud.mjs` — new `HCLOUD_FAKE_DELETE_ERROR` hook
  (registered in ENV_KEYS).

## Issue #921 — `ok`-verdict hardening & KooCLI pairing

**Changed files**

- `plugins/huaweicloud-core/src/hcloud-cli.mjs` — verdict is now
  `code === 0 || (isObsCommand && successText && !errorIndicators)`:
  - exit 0 + KooCLI parameter-error text → `ok:false` with `errorCode: 'PARAM_ERROR'`
    (KooCLI sometimes exits 0 while printing parameter errors);
  - OBS success heuristic narrowed: only for OBS (obsutil-style) commands with
    success text and no error indicators.
  - `test/hcloud-cli.test.mjs` — 3 new tests; 54/54 pass.
- `docs/safety-model.md` — **design decision recorded: session-level approval
  pass-through REJECTED.** An approval token minted in one session must not be
  replayable from another session/file; this would let a stale token authorize
  a write command the user never saw in the current context.
- `package.json` — **kooCliVersion bumped 7.2.12 → 7.3.12.** Decision rationale:
  the pinned 7.2.12 pairing was behind the current KooCLI release; all pinned
  OBS download URLs for 7.3.12 were verified to return HTTP 200 before the bump,
  and `npm run validate` confirms "Validated KooCLI version pairing: 7.3.12".
- `plugins/huaweicloud-core/skills/huaweicloud-cli-and-auth/SKILL.md` and
  `plugins/huaweicloud-core/skills/huawei-getting-started/SKILL.md` — install
  URLs re-pinned to `cli/7.3.12`.
- `skills/huawei-cloud-find-skills/SKILL.md` — Option C (`npx skills add` via
  GitCode) demoted to 实测失效 with a `git clone` + local-path-install bypass.

## Issue #922 — Pre-emptive balance gate & Windows SSH

**Changed files**

- `plugins/huaweicloud-core/src/tools.mjs` — new `Ecs.0707` risk rule with
  `Ecs` service alias; the balance gate is now **pre-emptive interception**
  (STOP when estimate > balance, including zero balance) instead of
  post-failure remediation.
- `plugins/huaweicloud-core/skills/huawei-iac/SKILL.md` — stage 5 gate rewritten:
  前置拦截 (实测 #922), STOP message with the Ecs.7000 code, recharge entry
  (`balanceRecharge`), voucher-first remedy, and explicit "完成后回复已充值/继续
  即可从本阶段续跑原配置" resume wording; CBC.0151 permission-degradation note.
  Critical Warnings table row added.
- `plugins/huaweicloud-core/skills/huawei-ecs/references/windows-ssh.md` — **new
  file.** All facts empirically verified on this Windows machine:
  - `ssh-keygen -N ''` fails in PowerShell ("option requires an argument -- N");
  - `-N '""'` sets a literal `""` passphrase (the trap);
  - `ssh-keygen --% ... -N ""` works (no passphrase).
    Plus: sshd-ready `Connection refused` retry, paramiko password automation
    (no `sshpass` on Windows), `scp` key upload, cloud-init `ssh_authorized_keys`
    injection (KooCLI has no `ImportKeypair`).
- `plugins/huaweicloud-core/skills/huawei-ecs/SKILL.md` — routing section to the
  new reference + References list entry; trap summary (passphrase literal `""`).
- `plugins/huaweicloud-core/skills/huawei-ecs/references/create-instance.md` —
  ssh-keygen per-shell forms + trap warning.
- `plugins/huaweicloud-core/skills/huawei-ecs/references/flavors.md` — flavor
  conflict rule section.
- `test/tools.test.mjs` — 2 new tests for the Ecs.0707 mapping and pre-emptive
  interception.

## Regression guard

`test/structure.test.mjs` — 4 new guards:

- huawei-iac stage-5 gate must match 前置拦截 + 续跑原配置 + `Ecs.7000` +
  `balanceRecharge`;
- huawei-ecs must route to `references/windows-ssh.md`, which must exist and
  cover paramiko / `Connection refused` retry / `ssh_authorized_keys`;
- huawei-sandbox must keep the workspace-URL 401 trap vs DevBridge tunnel
  distinction;
- find-skills must mark `npx skills add` 实测失效 and keep the git clone bypass.

---

## Test evidence

| Gate                                | Result                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `prettier --write .`                | clean (0 remaining format diffs)                                                                                               |
| ESLint                              | 0 errors (2 pre-existing `import/no-cycle` warnings)                                                                           |
| markdownlint-cli2                   | clean                                                                                                                          |
| `node --test` (full suite)          | **727 tests, 639 pass, 74 fail**                                                                                               |
| Failure set vs baseline             | **identical** (74 pre-existing env-related failures on this Windows box; baseline was 711/623/74 → +16 new tests, all passing) |
| `node scripts/validate-package.mjs` | "Validated HuaweiCloud DevKit with 29 skills. / Validated KooCLI version pairing: 7.3.12."                                     |

Per-file reruns during development:

- `test/session-manager.test.mjs` 35/35
- `test/cred-reconcile-e2e.test.mjs` 28/28
- `test/hcloud-cli.test.mjs` 54/54
- `test/structure.test.mjs` 54/54
- `test/tools.test.mjs` all except one pre-existing EPERM symlink failure (env)

## Key decisions

1. **kooCliVersion 7.2.12 → 7.3.12** — pairing was stale; all pinned OBS URLs
   for 7.3.12 verified HTTP 200 before the bump; validate passes.
2. **Session-level approval pass-through rejected** — recorded in
   `docs/safety-model.md`; approval tokens must not be replayable across
   sessions, otherwise a stale token could authorize unseen write commands.
3. **Balance gate moved from post-failure to pre-emptive interception** —
   an order that is known-doomed (Ecs.7000) should never be placed; the flow
   pauses and resumes with the same configuration after recharge.
4. **DevBridge persistence via `setsid nohup ... & disown`** — keeps the tunnel
   alive beyond the exec session, with an explicit post-session verification
   step and a "do not share" warning when persistence cannot be confirmed.
