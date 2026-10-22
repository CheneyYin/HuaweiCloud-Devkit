# AgentArts CLI Workflows (agentarts-sdk 0.1.7)

Every command shape here is fixture-verified against agentarts-sdk 0.1.7
(`test/fixtures/agentarts/help-tree/`); every trap is measured
(`docs/agentarts-pr0-findings.md`). Do not invent flags — run
`agentarts <group> --help` for anything not listed.

## Prerequisites

- `pip install agentarts-sdk==0.1.7 -i https://mirrors.huaweicloud.com/repository/pypi/simple`
  (verify: `agentarts --version` prints "agentarts version: 0.1.7"). The
  Huawei Cloud PyPI mirror is the default; if it lags a newly pinned
  version, drop `-i` and install from official PyPI. Or run
  `npx huaweicloud-devkit install-agentarts` (devkit-owned venv,
  auto-resolved). CLI resolution: `AGENTARTS_BIN` > devkit-managed venv >
  PATH — a personal venv install must be invoked by full path, or pointed
  to by `AGENTARTS_BIN`.
- Credentials are injected by the wrapper tools from the devkit runtime
  credential state (`huaweicloud_auth_init`). NEVER export AK/SK manually —
  see `huaweicloud-cli-and-auth`.
- Control plane is cn-southwest-2 only. The memory six (create/get/list/
  update/delete/status) help text CLAIMS a cn-north-4 default, but the
  actual code fallback is cn-southwest-2 (constant.py:79, findings trap
  15). Resolution chain: `HUAWEICLOUD_SDK_REGION` → `HUAWEICLOUD_REGION` →
  `OS_REGION_NAME` → cn-southwest-2 — wrapper child envs strip all three
  (wrapper runs always land on cn-southwest-2), but in your own terminal
  an exported `HUAWEICLOUD_SDK_REGION` wins, and some sibling skills'
  install guides export it. Always pass `--region` explicitly on the
  memory family regardless.

## Golden Path (deploy an agent)

```
1. agentarts init -n <name> -t <basic|langchain|langgraph|google-adk> -r cn-southwest-2
   (local tier — run via Bash; -r is REQUIRED, init prompts and aborts on EOF.
   NOTE: -p <dir> is a PARENT dir — the project lands at <dir>/<name>, so
   `-p foo -n foo` nests foo/foo. Omit -p to create ./<name> in cwd.)
2. (basic template) agentarts dev --port 8080  (local tier — background server;
   poll GET /ping until healthy, then kill; no wrapper involvement)
   (framework templates: `agentarts dev` cannot import framework deps — see
   "Framework Templates and `agentarts dev`" below and use the project venv.)
2b. PRE-WARM (mirror-first; keeps launch inside the ~300s client timeout):
   - base image via mirror + retag (see "Restricted Networks" below)
   - add .dockerignore (.venv/ __pycache__/ .git/ .agentarts_config.yaml + helpers)
   - ensure the Dockerfile pip step uses a mirror (ARG PIP_INDEX_URL=...)
3. huaweicloud_agentarts_plan_cli_command
   args: ["config","set","base.region","cn-southwest-2"]   → approved
   → present command to user → run_approved_command
4. huaweicloud_agentarts_plan_cli_command
   args: ["launch"]                                        → approved (billing)
   → present → run_approved (docker build + SWR push + runtime create)
5. huaweicloud_agentarts_plan_cli_command
   args: ["invoke","{\"message\":\"hello\"}"]              → approved (execute)
   → present → run_approved (wrapper default 900s; the CLI's own request
   timeout is also 900s)
6. huaweicloud_agentarts_plan_cli_command
   args: ["destroy"]                                       → approved; the plan
   canonicalizes to `destroy --yes` (non-interactive) — approve THAT form
   → present → run_approved
```

## Framework Templates and `agentarts dev`

`agentarts dev` imports the entrypoint in the CLI's OWN interpreter (the
devkit/managed venv), after `sys.path.insert(0, cwd)`. It does NOT use a
project venv, so `langchain` / `langgraph` / `google-adk` templates raise
`ModuleNotFoundError` (measured: `No module named 'langchain_core'`), and its
failure hint (`pip install -e .`) is misleading.

To smoke-test a framework template locally, run the same ASGI app from the
project venv and load env from the config:

```python
# local_dev.py — run as: cd <project> && .venv/bin/python local_dev.py
import os, sys
from pathlib import Path
import yaml
HERE = Path(__file__).resolve().parent
cfg = yaml.safe_load((HERE / ".agentarts_config.yaml").read_text())
agent = cfg.get("default_agent") or next(iter(cfg["agents"]))
for e in cfg["agents"][agent]["runtime"].get("environment_variables", []):
    if e.get("value") is not None:
        os.environ[e["key"]] = str(e["value"])
sys.path.insert(0, str(HERE))
from agent import app          # noqa: E402
import uvicorn                 # noqa: E402
uvicorn.run(app, host="127.0.0.1", port=8081)
```

Caveat: this uses the project venv's Python/resolved deps, which can differ
from the image (`python:3.10-slim`). Treat a green local run as a smoke test,
not proof the container works; the cloud `invoke` is the real verification.

## Error Signatures (parse output; exit codes lie)

| Signature                                  | Meaning                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `ModuleNotFoundError: No module named ...` | framework dep absent from the CLI venv during `dev` — use the project-venv recipe above         |
| JSON-RPC `-32001` on `launch`              | build exceeded the MCP client timeout (~300s); output lost — check `docker ps -a` for an orphan |
| `Namespace does not exists`                | first-run SWR org/repo auto-create (benign, followed by `Created ...`)                          |
| `- ERROR -` / `Failed to ...` / `× ERROR:` | operation failure despite exit 0 (see huaweicloud-safety)                                       |

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
  ["memory","status","<space-id>","--region","cn-southwest-2"]  (space_id is a
   POSITIONAL argument — a --space-id flag is rejected by the CLI)
  ["gateway","list"]
  ["gateway","get-target","<gateway-id>","<target-id>"]

huaweicloud_agentarts_list_agents (SDK API — 0.1.7 has NO list CLI command)
  {}                                  → all agents, SDK default pagination
  { "agent_name": "demo" }            → fuzzy name filter
  { "limit": 100 }                    → explicit page size when sweeping
```

Use `--output json` for machine parsing (default is a rich table). The
list-agents tool returns `agents[]` already parsed; omit `limit`/`offset`
unless sweeping — the SDK defaults are the single source of truth.

## Gateway Provisioning

```
1. plan ["gateway","create","--name","<name>"]              → approved (billing)
   → present → run_approved
   (omit --name and the CLI generates gateway-<random8>;
    omit --agency-name and the SDK auto-creates the IAM agency
    "AgentArtsCoreGateway" — a 409 (already exists) is tolerated and the
    create continues; SDK source, not yet cloud-measured)
2. verify: readonly ["gateway","list"] / ["gateway","get","<gateway-id>"]
3. plan ["gateway","create-target","<gateway-id>",
         "--target-configuration","<json>"]                  → approved
   (--target-configuration is REQUIRED; its JSON shape is not documented
    in help — do not invent it, run the command's own --help or use the
    console)
4. verify: ["gateway","get-target","<gateway-id>","<target-id>"] /
   ["gateway","list-targets","<gateway-id>"]  (list pagination: --limit
   default 50, --offset default 0)
```

Deletion: `gateway delete` / `delete-target` have NO skip flag
(typer.confirm) — the wrapper hard-stops them; the user runs them in their
own terminal. `--outbound-network-configuration` (JSON) defaults to unset
client-side; the server-side default for the unset case is not documented
in help — treat the network posture as a real decision, not an assumed
default.

## Runtime Sessions (data plane)

All runtime subcommands are approved-tier. `exec-command` runs arbitrary
commands inside the deployed agent's sandbox (rce); `upload-files` moves
local files to the cloud (data-exfil); `download-files --recursive` can
pull whole directories (local-write); the invoke family (invoke /
runtime invoke / upload / download) carries 900s wrapper timeouts.

`exec-command` shell semantics (fixture-measured): the backend runs the
command as a Docker exec-form JSON array — NO shell by default, so
operators (`>`, `|`, `;`, `&&`, `$()`) are not interpreted; when shell
operators are present the CLI auto-wraps as `["sh","-c","<command>"]`;
quote the whole command to pass it literally.

Timeout interplay for `exec-command` (the part that bites): the CLI's own
`--timeout` defaults to 60s (max 3600), while the wrapper's default for
exec-command is 120s. For anything long-running, raise BOTH: pass
`--timeout <seconds>` in args and `timeoutMs` of roughly
`(<seconds> + 30) × 1000` to the run tool — otherwise either the CLI
aborts at 60s or the wrapper SIGKILLs a still-legitimate request at 120s.

Session lifecycle: `start-session --agent <name>` returns the session id;
pass `--session` to exec-command/invoke/upload/download; stop with
`stop-session` even on failure paths.

## Memory Data Plane (SDK bridge — no CLI subcommands in 0.1.7)

The CLI stops at space management. All 12 data-plane methods run through
the SDK bridge tools; the one-time data-plane api_key is read from the
wrapper-captured 0600 key file and injected env-only (never argv, never
the transcript — see credentials.md).

The write loop (create → record → recall):

1. Create the space through the CLI pair (`memory create` captures the
   key file).
2. `huaweicloud_agentarts_memory_plan` with `create_session` and the
   user's `actor_id` (REQUIRED — the actor is the isolation unit).
   Approve, then `huaweicloud_agentarts_memory_write` with
   `approvedByUser: true`. Capture `result.id` (or pass your own
   `session_id` to create_session).
3. `memory_plan add_messages` with the session id and the message batch
   (roles user/assistant/system; ONE approval covers the whole batch;
   the request rides stdin, so batch size is not argv-limited). Approve,
   write.
4. Verify ingestion with `memory_read list_messages` (immediate). The
   natural next check, `memory_read search_memories`, LAGS: extraction
   is asynchronous, so an empty result right after a write is EXPECTED —
   do not re-write (duplicate) or churn `is_force_extract`; wait, or
   verify ingestion via list_messages.
5. Recall with `memory_read search_memories` using the SAME `actor_id`
   (required — server isolation is actor-level only).

Failure/retry semantics: a mismatched write rejects without consuming
the token; a SUCCESSFUL write consumes it, and replay returns
`already_processed` (verify with `memory_read` before re-planning
anything); a FAILED write burns the token — re-plan to retry, and pass
`idempotency_key` on add_messages retries (a timeout may have landed
server-side). `delete_memory` is irreversible; `delete_session` is a
soft delete — unreachable through this toolkit immediately, retained
server-side for async cleanup (90-365 days per the SDK), no in-toolkit
recovery.

Two retention/recall traps worth knowing before you lean on the data:

- **Message TTL is 7 days by default** (`message_ttl_hours: 168`, range
  1-8760, SDK source). Raw conversation messages a space stores through
  `add_messages` EXPIRE after a week unless the space was created with a
  higher `--ttl`; extracted MEMORIES persist independently. Use the
  bridge for durable facts (they become memories via extraction), not as
  a permanent conversation archive.
- **Search thresholds diverge across the official surfaces**: the hook
  path uses 0.3, the plugin's MCP path 0.7, the SDK/server default 0.5
  (min_score). The bridge passes min_score through untouched — omit it
  for the server default, lower it (e.g. 0.3) when a recall seems to be
  missing material.

Which path to use (the dual-path decision): the WRAPPER bridge
(memory_read/plan/write) is governed — approval tokens, redaction, the
0600 key channel — and works on every host, but captures nothing
automatically. The official PLUGIN (`memory install`, user terminal
only — host-trust: it writes the api_key into the host agent's config)
auto-captures conversations into a space but only covers five platforms
and its /recall /remember commands are broken in 0.1.7 (they curl an
HTTP server that does not exist). For cross-session memory on a
supported host: install the plugin (user's terminal), then use the
bridge tools for governed search/ops. For every other host or purpose:
the bridge alone.

## Wrapper Rules (why some commands hard-stop)

| Shape                              | Wrapper behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--bearer-token` / `-bt` anywhere  | Rejected at plan: argv is process-list visible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| bare `agentarts config`            | Hard stop: interactive wizard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `gateway delete` / `delete-target` | Hard stop: typer.confirm, NO skip flag exists — user terminal only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `memory install`/`uninstall`       | Plan requires an explicit target (hermes, claude, codex, opencode, openclaw) — the plan canonicalizes `--yes`; it writes credentials into the host agent's config — a user decision, never agent-initiated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `memory create`/`update`/`delete`  | Approved (PR11). create REQUIRES `--strategies` (server: HTTP 400 [AgentArts.01010400] without at least one built-in strategy — and the failed attempt orphans the API key the CLI created just before the space; the plan tool rejects a missing value and lists the legal built-ins: semantic, episodic, user_preference, summary, event — the first four e2e-measured, event enum-evidenced only). create canonicalizes to `--output json` and captures the one-time api_key to a 0600 file (payload stays redacted — see credentials.md); delete canonicalizes `--force` and carries the `irreversible` label. `memory update` also HAS `--strategies` (fixture), but its empty/missing semantics are unmeasured — no create-style rejection there |
| `destroy`                          | Plan appends `--yes` (measured non-interactive flag); approval binds to that form                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Worked example (space creation, the full canonical form):

```
agentarts memory create my-space --strategies semantic,episodic --region cn-southwest-2
# the plan tool canonicalizes to --output json and captures the one-time
# api_key to the 0600 key file; memory list/get/status verify it afterward
```

## Exit Codes Lie

agentarts 0.1.7 prints a full traceback and STILL exits 0 on failure. The
wrapper decides success by parsing output — measured signatures: Python
tracebacks, `- ERROR -` log lines, `Failed to …` operation errors,
`Aborted.` (EOF-aborted prompts), `× ERROR:` (the CLI's operation-error
echo: no data-plane endpoint, auth failure), and `Error building image:`
(deploy-stage docker build failure). Treat any `failureDetected: true` or
`ok: false` as failure regardless of `exitCode`.

## Restricted Networks — mirror-first (mainland-China default)

`launch` builds `FROM python:3.10-slim` on the LOCAL Docker daemon and the
generated Dockerfile pip-installs from pypi.org directly. On a China host,
mirror BOTH layers before launch (do not wait for a failure):

- Base image — pull via a mirror and retag to the canonical name so `FROM`
  resolves locally:
  `docker pull docker.m.daocloud.io/library/python:3.10-slim && docker tag docker.m.daocloud.io/library/python:3.10-slim python:3.10-slim`
  (a daemon-level `registry-mirrors` entry in `/etc/docker/daemon.json` is the
  cleaner default but needs sudo; the pull+retag works without it.)
- pip — point the build at the Huawei Cloud mirror via an overridable ARG in
  the Dockerfile:
  `ARG PIP_INDEX_URL=https://mirrors.huaweicloud.com/repository/pypi/simple`
  then `ENV PIP_INDEX_URL=${PIP_INDEX_URL}` (pip reads it automatically).
  Do NOT hardcode `-i <mirror>` inline: `agentarts config`/`init` REGENERATE
  the Dockerfile from a template with no mirror and will revert an inline edit.
  If the mirror returns `429`, use `https://repo.huaweicloud.com/repository/pypi/simple`.
- Add `.dockerignore` (`.venv/`, `__pycache__/`, `.git/`, `.agentarts_config.yaml`,
  helper scripts): smaller context, and it keeps the secret out of the image.

Why it matters beyond speed: the MCP client timeout is ~300s (opencode sets
`timeout: 300000` on the devkit server), while the wrapper allows `launch` 600s.
A cold build pulling from docker.io/pypi.org can exceed the client window,
returning JSON-RPC `-32001` with lost output and an ORPHANED build container
(the wrapper's own SIGKILL timer never fires because the client already gave
up). Pre-warming keeps `launch` well inside the window.

Runtime readiness after launch is asynchronous: an immediate invoke can
fail with "could not get access_endpoint" — retry after ~20s. With mirrors
warm, the docker build dominates deploy time (~1.5–3 min measured).

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

## Wrapper Timeout Defaults (measured)

`launch` 600s (the docker build dominates: ~2-3 min measured), `destroy`
300s, the invoke family 900s (upload/download included), everything else
120s (`exec-command`'s CLI-side `--timeout` default of 60s interacts with
this — see Runtime Sessions). Override per call with `timeoutMs`.
