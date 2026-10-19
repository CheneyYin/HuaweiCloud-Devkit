# KooCLI Installation & Authentication Guide

## 1. Install KooCLI (hcloud)

Huawei Cloud CLI (KooCLI) is a single binary. See the official quickstart:
https://support.huaweicloud.com/qs-hcli/hcli_02_003.html

```bash
# Linux x86_64
curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh -o hcloud_install.sh
bash hcloud_install.sh

# Or via Python package manager
pip3 install huaweicloudcli
```

Verify:

```bash
hcloud version
hcloud CodeArtsDeploy --help        # should list Available Operations for CodeArtsDeploy
```

Keep KooCLI updated so CodeArtsDeploy operation/parameter metadata stays current:

```bash
hcloud update -y
```

## 2. Service name

The service name is `CodeArtsDeploy` (KooCLI metadata directory `codeartsdeploy`).
`CloudDeploy` and `Deploy` are NOT accepted — `hcloud CloudDeploy <op>` reports
`[USE_ERROR]Unsupported service: CloudDeploy.` on the default en locale
(`[USE_ERROR]不支持的服务名称` under `--cli-lang=cn`). Always verify with
`hcloud CodeArtsDeploy ListAllApp --cli-region=cn-north-4 --help`.

## 3. Authentication

Two supported ways (AK/SK never hardcoded in this skill):

### Option A — Local profile (recommended for interactive agents)

The agent must NOT write credentials on the user's behalf — never execute a credential-writing
command (e.g. `configure set`/`configure init`) for them, and never inspect the raw profile:
raw `hcloud configure show/list/get/export/init` is hook-blocked in agent tools.

Check whether a profile already exists with `huaweicloud_show_profile_redacted` (the devkit's
redacted status tool):

- If a profile exists, use it directly (status via the redacted tool; the agent never sees secrets).
- If no profile exists, tell the user to run `npx huaweicloud-devkit auth init` — the single
  credential entry point, which mirrors to KooCLI without AK/SK entering shell history.

### Option B — Environment variables (recommended for CI/agent runtimes)

KooCLI reads the following environment variables (among others):

| Variable                                           | Meaning                                         |
| -------------------------------------------------- | ----------------------------------------------- |
| `HUAWEICLOUD_SDK_AK` / `HUAWEI_ACCESS_KEY`         | Access Key ID                                   |
| `HUAWEICLOUD_SDK_SK` / `HUAWEI_SECRET_KEY`         | Secret Access Key                               |
| `HUAWEICLOUD_SDK_PROJECT_ID` / `HUAWEI_PROJECT_ID` | Project ID (optional; KooCLI can resolve it)    |
| `HUAWEICLOUD_SDK_SECURITY_TOKEN`                   | Security token (only for temporary credentials) |

Example:

```bash
export HUAWEICLOUD_SDK_AK=your-access-key
export HUAWEICLOUD_SDK_SK=your-secret-key
export HUAWEICLOUD_SDK_REGION=cn-north-4
```

### Security rules

- Never print, persist, or hardcode AK/SK — read them from the environment or the local profile only.
- Never write AK/SK with `configure set` from inside a skill document or script; the agent checks profile status only via `huaweicloud_show_profile_redacted`.
- Use the most restrictive IAM identity that still allows the needed CodeArtsDeploy operations (least privilege, see `references/iam-policies.md`).

## 4. Verifying authentication

```bash
# Read-only probe (a valid error JSON such as Deploy.00016902 项目不存在 also
# proves the CLI + credentials are functional — it means auth resolved and the
# API was reached)
hcloud CodeArtsDeploy ListAllApp --cli-region=cn-north-4 --project_id={project_id} --page=1 --size=10
```

## 5. Region and project

All CodeArtsDeploy APIs are region/project scoped. Always pass `--cli-region` (e.g.
`cn-north-4`) and `--project_id`. The project must be a CodeArts (DevCloud) project — an IAM
project alone returns `Deploy.00016902 项目不存在`.

## 6. OBS artifact check (obsutil)

Deployment tasks pull artifacts from OBS, and `hcloud obs <command>` is an obsutil passthrough
(raw CLI, not a KooCLI SDK API). Initialize obsutil once per machine/region:

- Devkit path: `huaweicloud_setup_obs_config` (owned by the `obs` pack) mirrors the
  authenticated credentials into `~/.obsutilconfig` — one call, no typing.
- Manual fallback (user-run; AK/SK are typed at the terminal and stay out of shell history —
  avoid the `-i=`/`-k=` command-line forms, which leak credentials into `ps aux`):

```bash
hcloud obs config -interactive
hcloud obs ls obs://{artifact_bucket}        # self-check with an explicit obs:// URI
```

If `hcloud obs` prints `Warn: Please set ak, sk and endpoint in the configuration file!`,
obsutil has not been configured yet.

## 7. skill-quality-cli (OPTIONAL local wrapper)

The wrapper is OPTIONAL — when absent, this skill's hcloud commands run bare with identical
semantics. The normalized v2 wrapper performs NO telemetry, NO network access, and NO
self-upgrade; it only wraps whitelisted `hcloud` commands.

```bash
bash scripts/ensure_cli.sh   # availability CHECK only (no install, no PATH persistence)
skill-quality-cli version    # verify it works, if installed
```

- Manual local deployment (offline): copy `scripts/cli/cli_entry.py` to
  `~/.local/bin/skill-quality-cli.d/` and create `~/.local/bin/skill-quality-cli` as a
  one-line wrapper executing `python3 ~/.local/bin/skill-quality-cli.d/cli_entry.py "$@"`.
- There is nothing to disable: the wrapper reports nothing and contacts nothing.
- If the wrapper is absent, run the inner `hcloud` command from the examples directly.
