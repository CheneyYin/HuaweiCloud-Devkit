---
name: huawei-agentarts
description: 'Use when building, deploying, hosting, or operating AI agents on Huawei Cloud AgentArts (智果). Covers agent runtime hosting, deploy/invoke/destroy lifecycle, memory spaces and memory plugins, agent gateway. Triggers: AgentArts, 智果, agent platform, agent hosting, deploy an agent, agent runtime, agent memory, agent gateway. NOT for: ModelArts model training/inference (huawei-modelarts), web app hosting (huawei-ecs/huawei-cce/huawei-functiongraph), free sandbox preview (huawei-sandbox).'
version: 1
---

# Huawei Cloud AgentArts (智果)

**STOP - Do not answer from general knowledge.** AgentArts is newer than most training data. Follow this routing layer; measured facts live in the tier map and traps below.

## What AgentArts Is

Enterprise agent platform for Huawei Cloud: hosts agent runtimes (LangGraph/LangChain/custom code), memory spaces, agent gateway, and cloud runtime operations (command execution, file transfer, sessions). Product overview and usage modes: https://support.huaweicloud.com/productdesc-agentarts/agentarts_03_0002.html

## Scenario Routing

| Workload                                                       | Route to                                         | Why                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Host/deploy an agent workload (production)                     | AgentArts (here)                                 | Runtime hosting, memory, gateway, observability                                 |
| Managed Agents（托管智能体）                                   | AgentArts console — not measured by this toolkit | Console-only workflow; the 0.1.7 CLI surface has no such commands (43 fixtures) |
| 外部智能体观测评估 (external agent observability & evaluation) | AgentArts console — not measured by this toolkit | Console-only workflow; the 0.1.7 CLI surface has no such commands (43 fixtures) |
| 低代码编排 (low-code orchestration)                            | AgentArts console — not measured by this toolkit | Console-only workflow; the 0.1.7 CLI surface has no such commands (43 fixtures) |
| Free quick preview of a web app                                | huawei-sandbox                                   | Sandbox previews web apps, not agent workloads                                  |
| Web app / API / static site hosting                            | huawei-functiongraph / huawei-ecs / huawei-obs   | Not agent runtimes                                                              |
| Model training / inference                                     | huawei-modelarts                                 | ModelArts is the ML platform, AgentArts the agent platform                      |

`deploy an agent` is NOT a web-app hosting target: the Deployment Target Options web gate does not apply — route here directly. The four product usage modes (the console-only three above plus self-hosted runtime code, this skill's path) are documented at https://support.huaweicloud.com/productdesc-agentarts/agentarts_03_0002.html — only the CLI/SDK paths in this skill are measured by this toolkit.

## Prerequisites

- Python 3.10+ (per the SDK README) and `pip install agentarts-sdk==0.1.7 -i https://mirrors.huaweicloud.com/repository/pypi/simple` (pinned; Huawei Cloud PyPI mirror — if the mirror lags a newly pinned version, drop `-i` and install from official PyPI; verify with `agentarts --version`). Or run `npx huaweicloud-devkit install-agentarts` (devkit-owned venv, auto-resolved). CLI resolution: `AGENTARTS_BIN` > devkit-managed venv > PATH — a personal venv install needs its full path or `AGENTARTS_BIN`.
- Credentials: `HUAWEICLOUD_SDK_AK` / `HUAWEICLOUD_SDK_SK` env vars. NEVER let AK/SK enter shell history or the conversation — see huaweicloud-cli-and-auth
- Region: control plane is cn-southwest-2 only. The memory six (create/get/list/update/delete/status) CLAIM a cn-north-4 default in help text — the actual code fallback is cn-southwest-2 (constant.py:79, trap 15); an exported HUAWEICLOUD_SDK_REGION/HUAWEICLOUD_REGION/OS_REGION_NAME wins first in your own terminal (wrapper child envs strip them). Pass `--region` explicitly on the six regardless (install/uninstall take no region flag)

## Safety Tier Map (hook-enforced, wrapper-consumed)

| Tier                    | Commands                                                                                                                                                                    | Agent behavior                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local (Bash allowed)    | `--help` `--version` `init` `dev`                                                                                                                                           | Fine to run; `dev` is a long-running server the agent manages                                                                                                                       |
| readonly (Bash allowed) | `memory list/get/status`, `gateway get/list/get-target/list-targets`                                                                                                        | `huaweicloud_agentarts_run_readonly_command` (credential injection + redaction)                                                                                                     |
| readonly (SDK API only) | agent runtime listing — NO CLI command exists in 0.1.7                                                                                                                      | `huaweicloud_agentarts_list_agents` (degraded path: the console)                                                                                                                    |
| approved (Bash blocked) | `launch`/`deploy`, `destroy`, `invoke`, `config` family, `runtime` family, `memory create/update/delete`, `memory install/uninstall`, `gateway create/update/delete` family | `huaweicloud_agentarts_plan_cli_command` → present the exact command to the user → `huaweicloud_agentarts_run_approved_command` on explicit approval; otherwise the user's terminal |

## MCP Tools

- `huaweicloud_agentarts_plan_cli_command` — classify + canonicalize (per-operation flags: `--yes`/`--force`/`--output json` where measured-safe) without executing; returns the approval token for approved-tier writes; rejects `memory create` missing `--strategies` (server-side 400 + orphan API key — the error lists the legal values)
- `huaweicloud_agentarts_run_readonly_command` — read-only execution with runtime credential injection and output redaction
- `huaweicloud_agentarts_run_approved_command` — approved-tier execution bound to the plan's exact args and token
- `huaweicloud_agentarts_list_agents` — read-only agent runtime listing via the SDK Python API (0.1.7 has no list CLI command); region defaults to cn-southwest-2, optional agent_name fuzzy filter, omit limit/offset to keep SDK pagination defaults

See references/cli-workflows.md for the golden path and the full trap list, references/credentials.md for secret injection and the build-context leak, and references/langchain-maas-runbook.md for a worked LangChain + MaaS deploy (mirror-first, mainland-China).

## Hard Rules

- **Mirror-first (mainland-China default).** Pull Docker base images through a mirror (`docker.m.daocloud.io`) and retag to the canonical name; install/point pip at the Huawei Cloud mirror (`https://mirrors.huaweicloud.com/repository/pypi/simple`, fallback `https://repo.huaweicloud.com/...` on `429`). Fall back to docker.io/pypi.org only when a mirror is unavailable. See `references/cli-workflows.md` for the pre-warm recipe.
- **Keep `launch` inside the MCP client timeout (~300s).** `launch` builds on the local Docker daemon; a China-network build without pre-warming (base image + pip mirror + `.dockerignore`) can exceed the timeout, returning JSON-RPC `-32001` with lost output and an orphaned build container. Pre-warm first; treat `-32001` as "build too slow", check `docker ps -a` for an orphan and clean it up.
- **Never place a secret in a file inside the build context.** `COPY . .` bakes it into the image and `launch` pushes that image to SWR. Exclude `.agentarts_config.yaml` (and helper scripts) via `.dockerignore`; the runtime receives env vars from the CLI's YAML, not from the image. See `references/credentials.md`.
- `--bearer-token`/`-bt` on ANY command is forbidden — argv is process-list visible. Env-var auth only.
- The CLI can FAIL with exit code 0 (prints a traceback, still exits 0). Parse output, never trust exit codes.
- First run of any agentarts command writes `~/.bashrc`, `~/.bash_completions/`, `~/.agentarts/.completion_shown`, and `~/.huaweicloud/application_id` (a telemetry UUID sent in every request's User-Agent). Warn the user before first use.
- `memory install` persists credentials into the host agent's own config (e.g. `~/.hermes/.env` API key plus a config rewrite); per the SDK repo the plugin adds session capture and reply tracking to the host agent. A user decision — run in the user's terminal, never agent-initiated.
- Auth chain is env → `~/.huaweicloud/credentials` profile → metadata: without env vars the CLI may silently authenticate from a profile file. Credentials must come from explicit injection only.

## Measured Traps

| Trap                                                                         | Fix                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init` prompts for region and aborts on EOF                                  | Always pass `-n <name> -t <template> -r <region>`                                                                                                                                                                                                                                                                                                            |
| Bare `agentarts config` is an interactive wizard                             | Always use a subcommand (`config set`, `config get`, …)                                                                                                                                                                                                                                                                                                      |
| `config set` rewrites the yaml destructively                                 | Comments stripped, keys reordered, defaults materialized                                                                                                                                                                                                                                                                                                     |
| `destroy` prompts; `gateway delete`/`delete-target` prompt with NO skip flag | Use `destroy --yes`; gateway deletes go to the user terminal                                                                                                                                                                                                                                                                                                 |
| `invoke` default timeout is 900s                                             | Budget time accordingly                                                                                                                                                                                                                                                                                                                                      |
| `config set-env` crashes on basic-template projects                          | 0.1.7 SDK bug (null env list); `config remove-env` crashes the same way — edit yaml directly instead                                                                                                                                                                                                                                                         |
| `memory create` REQUIRES `--strategies` — the CLI help hides this            | Server rejects with HTTP 400 [AgentArts.01010400], and the CLI has already created an ORPHAN API key (key-before-space order). Pass at least one built-in: `--strategies semantic,episodic` (measured: semantic, episodic, user_preference, summary; event is enum-evidenced, not yet measured); the plan tool rejects a missing value before any cloud call |
| `memory create` prints its ONE-TIME api_key only in `--output json`          | The table branch prints Space ID/Status only — the key is lost forever. The wrapper canonicalizes to `--output json`, captures the key to a 0600 file `agentarts-memory-api-key-<space_id>.txt` (honors `HUAWEICLOUD_HOME`), and returns only the path; data plane consumes `HUAWEICLOUD_SDK_MEMORY_API_KEY` (see references/credentials.md)                 |
| `init -p <dir>` treats `<dir>` as a PARENT, not the project dir              | Project lands at `<dir>/<name>` (so `-p x -n x` nests `x/x`); pass `-p` = parent, or omit `-p` and run in the parent dir                                                                                                                                                                                                                                     |
| `dev` runs in the CLI's OWN venv (no framework deps)                         | langchain/langgraph/google-adk templates raise `ModuleNotFoundError`; smoke-test with the project venv instead (recipe in cli-workflows.md)                                                                                                                                                                                                                  |
| `destroy`/`invoke` outside the project dir fail / need the right flag        | There is no `--agent-id`; the flag is `--agent <name>` (or run from the dir holding `.agentarts_config.yaml`)                                                                                                                                                                                                                                                |
| `config`/`init` REGENERATE `Dockerfile` from a template (no pip mirror)      | A hand-patched mirror in the Dockerfile is silently reverted on the next `config`/deploy; encode it as `ARG PIP_INDEX_URL` and re-apply in the pre-warm step                                                                                                                                                                                                 |

## Cross-Skill References

- **Routing entry**: huaweicloud-core
- **AK/SK hygiene and credential setup**: huaweicloud-cli-and-auth
- **Web app preview contrast**: huawei-sandbox
- **General safety and output-redaction rules**: huaweicloud-safety

## External Docs

- AgentArts product: https://support.huaweicloud.com/agentarts/
- SDK: https://github.com/huaweicloud/agentarts-sdk-python
