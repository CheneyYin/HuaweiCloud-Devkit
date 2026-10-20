# KooCLI (hcloud) Installation & Authentication Guide

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
hcloud WAF --help        # should list Available Operations for WAF
hcloud AAD --help        # should list Available Operations for AAD
```

Keep KooCLI updated so WAF/AAD operation/parameter metadata stays current:

```bash
hcloud update -y
```

## 2. Authentication

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
- Use the most restrictive IAM identity that still allows the needed WAF/AAD operations (least privilege, see `references/iam-policies.md`).

## 3. Region and project

WAF operations take `--project_id` (path parameter) plus `--cli-region`. KooCLI automatically
uses the default project of the authenticated profile when `--project_id` is omitted; multi-project
accounts may append `--project_id=<project_id>` explicitly. AAD is region-based — `--cli-region`
carries the scope.

## 4. Verifying authentication

```bash
# Live read-only probe (project_id auto-resolved from the profile)
hcloud WAF ListPolicy --cli-region=cn-north-4
```

## 5. skill-quality-cli (OPTIONAL local wrapper)

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
