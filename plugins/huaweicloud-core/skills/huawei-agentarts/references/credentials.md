# AgentArts Credentials (agentarts-sdk 0.1.7)

## How credentials reach the CLI

The devkit runtime credential state (`huaweicloud_auth_init`) is the ONLY
injection source. When `huaweicloud_agentarts_run_readonly_command` or
`huaweicloud_agentarts_run_approved_command` spawns the CLI, it builds an
ALLOWLIST child environment (PATH, HOME, locale, proxy) and injects
`HUAWEICLOUD_SDK_AK` / `HUAWEICLOUD_SDK_SK` from the runtime state:

- The SK is never written to disk, never placed in the agent's own shell
  environment, and never echoed in tool output (redaction masks
  `ak:`/`sk:`/`api_key:` shapes).
- Ambient environment variables are NOT inherited: the child sees only the
  allowlist, so stray credentials or unrelated variables cannot leak in or
  out.
- `--bearer-token` / `-bt` is rejected outright by the wrapper: argv is
  process-list visible.

## The auth chain (measured)

`HUAWEICLOUD_SDK_AK/SK` env → `~/.huaweicloud/credentials` profile (or
`HUAWEICLOUD_SDK_CREDENTIALS_FILE`) → cloud metadata (last, 3s+3s). Two
consequences:

- Without devkit credentials the wrapper REJECTS the run outright (the
  env-or-fail contract): a clear error pointing at `huaweicloud_auth_init`,
  never a silent profile hit. When credentials ARE held, injection
  REPLACES, so commands run with exactly the credentials the devkit holds
  (and the profile chain is neutralized via
  HUAWEICLOUD_SDK_CREDENTIALS_FILE=/dev/null as defense in depth).
- A metadata 404 warning in output means env AND profile both failed — it is
  a failure signature, not noise.

## Degraded paths (when the wrapper cannot run)

- The user runs the command in their own terminal with their own credentials.
- `npx huaweicloud-devkit doctor` reports the agentarts environment
  (CLI presence, pinned version 0.1.7, Python 3.10+, Docker for launch).
- NEVER teach `export HUAWEICLOUD_SDK_AK=…` in a shell — that puts the SK
  into shell history and the agent transcript (see
  `huaweicloud-cli-and-auth`).

## Exfiltration trap: .agentarts_config.yaml

`agentarts config set-env` is the documented way to persist variables (its
own help example is `config set-env HUAWEICLOUD_SDK_AK your-ak`) into the
project-local yaml, and `launch` ships that yaml (including
`runtime.environment_variables`) to the cloud runtime. Therefore:

- Treat the whole config family as credential-bearing (approved tier).
- Model API keys and third-party secrets (e.g. `OPENAI_API_KEY`) placed in
  `environment_variables` are deployed to the cloud with the agent — only
  put there what the deployed agent genuinely needs, and say so to the user.
- Reading `.agentarts_config.yaml` via Bash is hook-blocked
  (credentialFilePatterns); the config subcommands are the supported path.
- 0.1.7 trap: `config set-env`/`remove-env` CRASH on basic-template projects
  (null env list) — edit the yaml directly in that case.

## Memory data-plane key (next release)

The per-Space `HUAWEICLOUD_SDK_MEMORY_API_KEY` (returned once at creation)
is out of scope this release — `memory create/update/delete` are blocked.
When the memory scenario ships, the key's lifecycle will follow the same
runtime-injection pattern as AK/SK. Echoing
`$HUAWEICLOUD_SDK_MEMORY_API_KEY` is already hook-blocked.
