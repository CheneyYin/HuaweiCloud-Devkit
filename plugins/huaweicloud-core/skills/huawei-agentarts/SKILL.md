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

| Workload                                   | Route to                                       | Why                                                        |
| ------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------- |
| Host/deploy an agent workload (production) | AgentArts (here)                               | Runtime hosting, memory, gateway, observability            |
| Free quick preview of a web app            | huawei-sandbox                                 | Sandbox previews web apps, not agent workloads             |
| Web app / API / static site hosting        | huawei-functiongraph / huawei-ecs / huawei-obs | Not agent runtimes                                         |
| Model training / inference                 | huawei-modelarts                               | ModelArts is the ML platform, AgentArts the agent platform |

`deploy an agent` is NOT a web-app hosting target: the Deployment Target Options web gate does not apply — route here directly.

## Prerequisites

- Python 3.10+ (per the SDK README) and `pip install agentarts-sdk==0.1.7 -i https://mirrors.huaweicloud.com/repository/pypi/simple` (pinned; Huawei Cloud PyPI mirror — if the mirror lags a newly pinned version, drop `-i` and install from official PyPI; verify with `agentarts --version`). CLI resolution: `AGENTARTS_BIN` > devkit-managed venv > PATH — a personal venv install needs its full path or `AGENTARTS_BIN`.
- Credentials: `HUAWEICLOUD_SDK_AK` / `HUAWEICLOUD_SDK_SK` env vars. NEVER let AK/SK enter shell history or the conversation — see huaweicloud-cli-and-auth
- Region: control plane is cn-southwest-2 only; the memory create/get/list/update/delete/status subcommands default to cn-north-4 (install/uninstall take no region flag) — pass `--region` explicitly on the six that have it

## Safety Tier Map (hook-enforced, wrapper-consumed)

| Tier                    | Commands                                                                                                                                     | Agent behavior                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local (Bash allowed)    | `--help` `--version` `init` `dev`                                                                                                            | Fine to run; `dev` is a long-running server the agent manages                                                                                                                       |
| readonly (Bash allowed) | `memory list/get/status`, `gateway get/list/get-target/list-targets`                                                                         | `huaweicloud_agentarts_run_readonly_command` (credential injection + redaction)                                                                                                     |
| approved (Bash blocked) | `launch`/`deploy`, `destroy`, `invoke`, `config` family, `runtime` family, `memory install/uninstall`, `gateway create/update/delete` family | `huaweicloud_agentarts_plan_cli_command` → present the exact command to the user → `huaweicloud_agentarts_run_approved_command` on explicit approval; otherwise the user's terminal |
| blocked (this release)  | `memory create/update/delete`                                                                                                                | Memory scenario deferred; user terminal only                                                                                                                                        |

## MCP Tools

- `huaweicloud_agentarts_plan_cli_command` — classify + canonicalize (adds `--yes` where measured-safe) without executing; returns the approval token for approved-tier writes
- `huaweicloud_agentarts_run_readonly_command` — read-only execution with runtime credential injection and output redaction
- `huaweicloud_agentarts_run_approved_command` — approved-tier execution bound to the plan's exact args and token

See references/cli-workflows.md for the golden path and the full trap list.

## Hard Rules

- `--bearer-token`/`-bt` on ANY command is forbidden — argv is process-list visible. Env-var auth only.
- The CLI can FAIL with exit code 0 (prints a traceback, still exits 0). Parse output, never trust exit codes.
- First run of any agentarts command writes `~/.bashrc`, `~/.bash_completions/`, `~/.agentarts/.completion_shown`, and `~/.huaweicloud/application_id` (a telemetry UUID sent in every request's User-Agent). Warn the user before first use.
- `memory install` persists credentials into the host agent's own config (e.g. `~/.hermes/.env` API key plus a config rewrite); per the SDK repo the plugin adds session capture and reply tracking to the host agent. A user decision — run in the user's terminal, never agent-initiated.
- Auth chain is env → `~/.huaweicloud/credentials` profile → metadata: without env vars the CLI may silently authenticate from a profile file. Credentials must come from explicit injection only.

## Measured Traps

| Trap                                                                         | Fix                                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `init` prompts for region and aborts on EOF                                  | Always pass `-n <name> -t <template> -r <region>`                                                    |
| Bare `agentarts config` is an interactive wizard                             | Always use a subcommand (`config set`, `config get`, …)                                              |
| `config set` rewrites the yaml destructively                                 | Comments stripped, keys reordered, defaults materialized                                             |
| `destroy` prompts; `gateway delete`/`delete-target` prompt with NO skip flag | Use `destroy --yes`; gateway deletes go to the user terminal                                         |
| `invoke` default timeout is 900s                                             | Budget time accordingly                                                                              |
| `config set-env` crashes on basic-template projects                          | 0.1.7 SDK bug (null env list); `config remove-env` crashes the same way — edit yaml directly instead |

## Cross-Skill References

- **Routing entry**: huaweicloud-core
- **AK/SK hygiene and credential setup**: huaweicloud-cli-and-auth
- **Web app preview contrast**: huawei-sandbox
- **General safety and output-redaction rules**: huaweicloud-safety

## External Docs

- AgentArts product: https://support.huaweicloud.com/agentarts/
- SDK: https://github.com/huaweicloud/agentarts-sdk-python
