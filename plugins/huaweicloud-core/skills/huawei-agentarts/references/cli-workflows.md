# AgentArts CLI Workflows (agentarts-sdk 0.1.7)

Every command shape here is fixture-verified against agentarts-sdk 0.1.7
(`test/fixtures/agentarts/help-tree/`); every trap is measured
(`docs/agentarts-pr0-findings.md`). Do not invent flags — run
`agentarts <group> --help` for anything not listed.

## Prerequisites

- `pip install agentarts-sdk==0.1.7` (verify: `agentarts --version` prints
  "agentarts version: 0.1.7"). A venv install must be invoked by full path,
  or pointed to by `AGENTARTS_BIN`.
- Credentials are injected by the wrapper tools from the devkit runtime
  credential state (`huaweicloud_auth_init`). NEVER export AK/SK manually —
  see `huaweicloud-cli-and-auth`.
- Control plane is cn-southwest-2 only. The memory create/get/list/update/
  delete/status subcommands default to cn-north-4 — pass `--region` on those.

## Golden Path (deploy an agent)

```
1. agentarts init -n <name> -t basic -r cn-southwest-2
   (local tier — run via Bash; -r is REQUIRED, init prompts and aborts on EOF)
2. agentarts dev --port 8080      (local tier — background server; poll
   GET /ping until healthy, then kill; no wrapper involvement)
3. huaweicloud_agentarts_plan_cli_command
   args: ["config","set","base.region","cn-southwest-2"]   → approved
   → present command to user → run_approved_command
4. huaweicloud_agentarts_plan_cli_command
   args: ["launch"]                                        → approved (billing)
   → present → run_approved (docker build + SWR push + runtime create)
5. huaweicloud_agentarts_plan_cli_command
   args: ["invoke","{\"message\":\"hello\"}"]              → approved (execute)
   → present → run_approved (default 900s timeout)
6. huaweicloud_agentarts_plan_cli_command
   args: ["destroy"]                                       → approved; the plan
   canonicalizes to `destroy --yes` (non-interactive) — approve THAT form
   → present → run_approved
```

Pre-deploy yaml: `file_transfer_config.enabled` and
`invoke_config.url_match_type` defaults (`false` / `ACCURATE_MATCH`) must be
edited BEFORE deploy when file transfer or a custom path is needed; whether
post-deploy console edits work is unresolved (conflicting CLI-help vs SDK-doc
evidence) — treat pre-deploy as required.

## Read-only Inspection

```
huaweicloud_agentarts_run_readonly_command
  ["memory","list","--region","cn-southwest-2","--output","json"]
  ["memory","get","<space-id>","--region","cn-southwest-2"]
  ["memory","status","--space-id","<space-id>","--region","cn-southwest-2"]
  ["gateway","list"]
  ["gateway","get-target","<gateway-id>","<target-id>"]
```

Use `--output json` for machine parsing (default is a rich table).

## Wrapper Rules (why some commands hard-stop)

| Shape                              | Wrapper behavior                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bearer-token` / `-bt` anywhere  | Rejected at plan: argv is process-list visible                                                                                                                                        |
| bare `agentarts config`            | Hard stop: interactive wizard                                                                                                                                                         |
| `gateway delete` / `delete-target` | Hard stop: typer.confirm, NO skip flag exists — user terminal only                                                                                                                    |
| `memory install`/`uninstall`       | Plan requires an explicit target (hermes, claude, codex, opencode, openclaw) AND `--yes`; it writes credentials into the host agent's config — a user decision, never agent-initiated |
| `memory create`/`update`/`delete`  | Blocked this release (memory scenario ships later) — user terminal                                                                                                                    |
| `destroy`                          | Plan appends `--yes` (measured non-interactive flag); approval binds to that form                                                                                                     |

## Exit Codes Lie

agentarts 0.1.7 prints a full traceback and STILL exits 0 on failure. The
wrapper decides success by parsing output (`Traceback (most recent call last)`,
`- ERROR -`, `^Failed to …`, `^Aborted.`) — treat any `failureDetected:
true` or `ok: false` as failure regardless of `exitCode`.

## First-run HOME Writes

The FIRST agentarts invocation (even `--help`) writes `~/.bashrc` (tab
completion source line), `~/.bash_completions/agentarts.sh`,
`~/.agentarts/.completion_shown`, and `~/.huaweicloud/application_id` (a
36-byte telemetry UUID sent as `app/<uuid>` in every request's User-Agent).
Warn the user before first use in their home; the E2E harness isolates these
via a scratch HOME.

## config Family Traps

- All config subcommands resolve `.agentarts_config.yaml` from the CURRENT
  WORKING DIRECTORY (no path flag) — pass `cwd` in the wrapper call.
- `config set` rewrites the yaml destructively: comments stripped, keys
  reordered, defaults materialized.
- `config set-env` / `config remove-env` CRASH on basic-template projects in
  0.1.7 (`TypeError` on a null env list; pre-write, nothing persisted). Edit
  the yaml directly instead — or use a template that ships env entries.
- `config set-env` is the documented way to persist
  `HUAWEICLOUD_SDK_AK`-style credentials into the yaml: treat the whole
  config family as credential-bearing (approved tier).

## runtime Family (data plane)

All runtime subcommands are approved-tier with 900s wrapper timeouts
(invoke/upload/download). `exec-command` runs arbitrary commands inside the
deployed agent's sandbox (rce); `upload-files` moves local files to the
cloud (data-exfil); `download-files --recursive` can pull whole directories
(local-write). Sessions need `start-session` first; clean up with
`stop-session` even on failure paths.
