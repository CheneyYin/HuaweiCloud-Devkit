# KooCLI (hcloud) Installation & Authentication Guide

## 1. Install KooCLI

Requirements: Linux/macOS/Windows, Python 3.6+ (optional but recommended).

```bash
# One-line install (Linux/macOS)
curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh -o hcloud_install.sh
bash hcloud_install.sh

# Verify
hcloud version

# Keep it current — the GaussDB service metadata is refreshed with each release
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

KooCLI reads these environment variables when no profile is used (or as an override).
**The lines below are reference descriptions, not standalone commands** — set them
in your shell profile (e.g. `~/.bashrc`) once, and `hcloud` picks them up on its own:

```bash
# Environment-variable references (hcloud reads these automatically):
#   export HUAWEICLOUD_SDK_AK="your-access-key-id"
#   export HUAWEICLOUD_SDK_SK="your-secret-access-key"
#   export HUAWEICLOUD_SDK_PROJECT_ID="your-project-id"   # optional
```

Same keys are also accepted by the SDK layer without the `HUAWEICLOUD_SDK_` prefix:
`HUAWEI_ACCESS_KEY` / `HUAWEI_SECRET_KEY` (reference names only).

### Security rules

- Never print, persist, or hardcode AK/SK — read them from the environment or the local profile only.
- Never write AK/SK with `configure set` from inside a skill document or script; the agent checks profile status only via `huaweicloud_show_profile_redacted`.
- Use the most restrictive IAM identity that still allows the needed GaussDB operations (least privilege, see `references/iam-policies.md`).

## 3. Verifying authentication

```bash
# Real read-only smoke test for both GaussDB products
hcloud GaussDB ListGaussMySqlInstances --cli-region=cn-north-4 --limit=1
hcloud gaussdbforopengauss ListInstances --cli-region=cn-north-4 --limit=1
```

## 4. Service availability check

```bash
hcloud GaussDB --help                 # MySQL-compatible product (TaurusDB API)
hcloud gaussdbforopengauss --help     # openGauss distributed product
```

If `gaussdbforopengauss` is missing, run `hcloud update -y` and re-check.

## 5. Region endpoints

| Product                             | Endpoint pattern                               |
| ----------------------------------- | ---------------------------------------------- |
| GaussDB for MySQL (compatible)      | `gaussdb.<region>.myhuaweicloud.com`           |
| GaussDB for openGauss (distributed) | `gaussdb-opengauss.<region>.myhuaweicloud.com` |

## 6. skill-quality-cli (OPTIONAL local wrapper)

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
