---
name: huawei-cloud-cts-trace-management
description: 'Huawei Cloud CTS (Cloud Trace Service / 云审计服务) management and audit analysis via the hcloud CLI: tracker lifecycle (list/create/delete), audit trace query and analysis (filter by time/user/service), cloud service operation listing, key event notifications, trace resources, and retention compliance analysis (7-day default vs LTS long retention vs OBS delivery). Query and Analyze actions run automatically (R3); Create/Delete actions require preview and explicit user confirmation (R2/R1). NOT for: Cloud Eye monitoring alarms (use huawei-cloud-eye), LTS log analysis (use the LTS console/API). Triggers include: CTS, cts, Cloud Trace Service, 云审计服务, audit log, 审计日志, tracker, 追踪器, trace, 审计事件, operation record, 操作记录, notification, 通知规则, retention, 保留策略, compliance, 合规, audit, 审计, KooCLI, hcloud.'
tags: [huawei-cloud, cts, audit, tracker, trace]
---

# Huawei Cloud CTS (Cloud Trace Service)

<!-- cli-install-version: 3.9.0 -->

## Step 0: Optional command wrapper (skip freely)

> **The wrapper is OPTIONAL.** When `skill-quality-cli` is installed, the wrapped examples in this skill run as written; when it is absent, run the inner `hcloud` command bare — identical semantics (the devkit's safety layer classifies both forms the same way). Check availability with `bash scripts/ensure_cli.sh` (existence check only; no install, no PATH persistence, no network).

**Write-path routing**: `hcloud` write operations in this skill go through the devkit's approval chain — present the planned command with `huaweicloud_plan_cli_command`, then execute with `huaweicloud_run_approved_command` (raw Bash writes are hook-blocked). Read operations may run bare or wrapped.

## Overview

This skill operates Huawei Cloud CTS (Cloud Trace Service / 云审计服务) through the `hcloud` CLI.
CTS records operation traces (audit events) of cloud resources for security compliance, fault tracing,
and change auditing. The skill covers:

| Category     | Capabilities                                                                                                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Query**    | List trackers (`huawei_list_cts_trackers`), query audit traces (`huawei_list_cts_traces`), list cloud service operations (`huawei_list_cts_operations`), list key event notifications (`huawei_list_cts_notifications`), list trace resources (`huawei_list_cts_trace_resources`) |
| **Diagnose** | Aggregate audit events by user/time/operation (`huawei_analyze_cts_traces`), evaluate retention & compliance (`huawei_analyze_cts_retention`)                                                                                                                                     |
| **Manage**   | Create tracker (`huawei_create_cts_tracker`), create notification (`huawei_create_cts_notification`), delete tracker (`huawei_delete_cts_tracker`)                                                                                                                                |

> **Always run `hcloud CTS <Operation> --cli-region={region} --help` before constructing a command**
> to discover the exact parameter names and required flags for the current KooCLI version.
> Do not answer from general knowledge — follow the procedures in this document.

**Dependency**: none beyond `hcloud` — the optional `skill-quality-cli` wrapper is a local convenience only (no telemetry, no network).

### Critical Warnings

| Trap                            | Why                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tracker required for traces** | Audit traces are only recorded after a tracker exists. No tracker → no events. Check `ListTrackers` first.                                                       |
| **OBS bucket prerequisite**     | A tracker needs an OBS bucket (or LTS log stream) for log delivery. Creation fails if the bucket is missing or lacks permissions.                                |
| **7-day retention default**     | Trace data is retained for only **7 days** by default. Create an LTS-enabled tracker (`--is_lts_enabled=true`) or configure OBS delivery for longer retention.   |
| **Organization tracker**        | Cross-account auditing in an organization requires an organization tracker (`--is_organization_tracker=true`). A normal tracker only covers the current account. |

## Prerequisites

1. **hcloud CLI** installed and authenticated — see `references/cli-installation-guide.md`
2. **Authentication** — one of:
   - Environment variables `HUAWEICLOUD_SDK_AK` / `HUAWEICLOUD_SDK_SK` (or `HUAWEI_ACCESS_KEY` /
     `HUAWEI_SECRET_KEY`) — hcloud auto-detects them, or
   - a local KooCLI profile the **user** created (the agent never writes credentials — profile
     status comes from `huaweicloud_show_profile_redacted`; see `references/cli-installation-guide.md`)
3. **IAM permissions** — `CTS ReadOnlyAccess` for query/analyze; `CTS Administrator` (or equivalent `cts:*` on trackers/notifications) for create/delete — see `references/iam-policies.md`
4. **Region & project**: most CTS APIs are region/project scoped. Pass `--cli-region={region}`;
   KooCLI fills `--project_id` from the profile if omitted. `ListTraceResources` requires
   `--domain_id` (account ID).
5. **OBS bucket** (for OBS delivery) or **SMN topic** (for notifications) must exist in the target region before create operations.

- **`skill-quality-cli`** — OPTIONAL; `bash scripts/ensure_cli.sh` only checks availability (bare `hcloud` is equivalent). The normalized wrapper has no upgrade subcommand; the shipped `scripts/cli/cli_entry.py` is the current version (re-copy it to refresh a manual deployment).

## Workflow

```
1. Identify intent:
   ├── Query (R3 auto): list trackers/traces/operations/notifications/trace-resources
   ├── Analyze (R3 auto): aggregate traces, evaluate retention compliance
   └── Manage (R1/R2): create/delete tracker, create notification — ALWAYS preview + confirm
2. Gather scope: region, project_id (or domain_id for trace resources), time range, filters
3. Execute via hcloud CLI:
   ├── Query/Analyze → run command → return structured results
   └── Manage → show exact command + effect → wait for user confirmation → execute
4. Handle traps: no tracker → advise creating one; 7-day retention → advise LTS/OBS;
   org cross-account → advise organization tracker
5. Report results (JSON), masking AK/SK-like values in output
```

**Write-operation rule:** `huawei_create_cts_tracker`, `huawei_create_cts_notification` (R2) and
`huawei_delete_cts_tracker` (R1) MUST NOT execute without an explicit user confirmation after the
exact command and its effect are previewed.

## Core Commands

Service name is `CTS` (KooCLI metadata directory `cts`). Region parameter `--cli-region={region}`
is required on every command.

The required `--project_id` is **omitted from the examples below**: KooCLI automatically fills it
from the active profile when it is not passed (see Prerequisites). Pass it explicitly
(`--project_id=<your_project_id>`) only when your profile has no default project.
`ListTraceResources` is the exception — it requires `--domain_id` (account ID), shown as a
`{domain_id}` placeholder below; replace it with your own account ID (retrieve it via
`hcloud IAM KeystoneListProjects --cli-region={region}` or the account console).
Run each command as a **single line** (no `\` line continuations) so it stays directly copy-pasteable.

> **Command format.** Each command below is shown in its canonical bare
> `hcloud CTS <Operation> ...` form — this is the syntax used for parameter
> discovery (`--help`) and for execution. When the OPTIONAL
> `skill-quality-cli` wrapper is installed, the equivalent wrapped form
> works identically (see Step 0); when it is absent, run the bare form.

### Query — Trackers

```bash
# List all trackers of the tenant
hcloud CTS ListTrackers --cli-region={region}
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS ListTrackers --cli-region={region}

# List a specific tracker (by name/type)
hcloud CTS ListTrackers --cli-region={region} --tracker_name=system --tracker_type=system
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS ListTrackers --cli-region={region} --tracker_name=system --tracker_type=system
```

### Query — Audit Traces

```bash
# List recent traces (default: system traces, last hour)
hcloud CTS ListTraces --cli-region={region} --trace_type=system
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS ListTraces --cli-region={region} --trace_type=system

# Query traces in a time range (from/to are UTC millisecond timestamps, 13 digits, used together)
hcloud CTS ListTraces --cli-region={region} --trace_type=system --from=1725000000000 --to=1725600000000 --limit=50
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS ListTraces --cli-region={region} --trace_type=system --from=1725000000000 --to=1725600000000 --limit=50

# Filter by user, service, and trace status (normal|warning|incident)
hcloud CTS ListTraces --cli-region={region} --trace_type=system --user=alice --service_type=ECS --trace_rating=warning
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS ListTraces --cli-region={region} --trace_type=system --user=alice --service_type=ECS --trace_rating=warning

# Query a specific trace by ID (other criteria are ignored)
hcloud CTS ListTraces --cli-region={region} --trace_type=system --trace_id=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS ListTraces --cli-region={region} --trace_type=system --trace_id=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e
```

### Query — Operations, Notifications, Trace Resources

```bash
# List all cloud service operations recorded by CTS (optionally filter by service/resource type)
hcloud CTS ListOperations --cli-region={region}
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS ListOperations --cli-region={region}
hcloud CTS ListOperations --cli-region={region} --service_type=ECS --resource_type=vm
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS ListOperations --cli-region={region} --service_type=ECS --resource_type=vm

# List key event notifications (notification_type: smn|fun)
hcloud CTS ListNotifications --cli-region={region} --notification_type=smn
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS ListNotifications --cli-region={region} --notification_type=smn

# List resources involved in traces (NOTE: uses --domain_id, NOT --project_id);
# {domain_id} = your account ID (from IAM KeystoneListProjects / account console)
hcloud CTS ListTraceResources --cli-region={region} --domain_id={domain_id}
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS ListTraceResources --cli-region={region} --domain_id={domain_id}
```

### Manage — Create Tracker (R2, preview + confirm)

```bash
# Syntax check (--help, rc=0). Live R2 form (preview + confirm before execution):
#   hcloud CTS CreateTracker --cli-region={region} --tracker_name=system --tracker_type=system --obs_info.bucket_name={obs_bucket_name} --obs_info.is_obs_created=false --agency_name=cts_admin_trust
hcloud CTS CreateTracker --cli-region={region} --help
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS CreateTracker --cli-region={region} --help

# Live R2 alternatives (preview + confirm before execution):
#   --is_lts_enabled=true:        hcloud CTS CreateTracker --cli-region={region} --tracker_name=system --tracker_type=system --is_lts_enabled=true --agency_name=cts_admin_trust
#   --is_organization_tracker=true: hcloud CTS CreateTracker --cli-region={region} --tracker_name=system --tracker_type=system --is_organization_tracker=true --obs_info.bucket_name={obs_bucket_name} --obs_info.is_obs_created=false --agency_name=cts_admin_trust
```

> Before creating a tracker with OBS delivery, verify the target OBS bucket exists (CTS
> `CheckObsBuckets` — same credential domain as the tracker write) and that the account has
> permissions — otherwise creation fails. KooCLI's OBS face is obsutil-style, not API-style
> (`hcloud OBS ls`; see the `huawei-obs` skill for bucket listing and delivery teaching).

### Manage — Create Notification (R2, preview + confirm)

```bash
# Syntax check (--help, rc=0). Live R2 forms (preview + confirm before execution):
#   complete:   hcloud CTS CreateNotification --cli-region={region} --notification_name={notification_name} --operation_type=complete --topic_id={smn_topic_urn}
#   customized: hcloud CTS CreateNotification --cli-region={region} --notification_name={notification_name} --operation_type=customized --operations.1.service_type=ECS --operations.1.resource_type=vm --operations.1.trace_names.1=createServer --topic_id={smn_topic_urn} --agency_name=cts_admin_trust
hcloud CTS CreateNotification --cli-region={region} --help
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS CreateNotification --cli-region={region} --help
```

### Manage — Delete Tracker (R1, preview + confirm)

```bash
# Syntax check (--help, rc=0). Live R1 forms (preview + confirm before execution):
#   data tracker:  hcloud CTS DeleteTracker --cli-region={region} --tracker_name={data_tracker_name} --tracker_type=data
#   system tracker (disables): hcloud CTS DeleteTracker --cli-region={region} --tracker_name=system --tracker_type=system
hcloud CTS DeleteTracker --cli-region={region} --help
skill-quality-cli run --skill-name huawei-cloud-cts-trace-management -- hcloud CTS DeleteTracker --cli-region={region} --help
```

> **Note:** `DeleteTracker` deletes **data trackers**; the management (system) tracker cannot be
> deleted — it can only be disabled. Deleting a tracker does not affect traces already collected.

## Parameter Confirmation

All parameter names below were verified against `hcloud CTS <Operation> --help` (KooCLI 7.2.12; parameter surfaces re-checked identical on 7.3.12).
Values in `{}` are placeholders — replace with real values. **Do not invent parameter names.**

### Parameter Validation (Security — mandatory before execution)

Every user-supplied parameter value MUST pass a whitelist/type check before it is passed to `hcloud`.
Illegal input is **rejected outright** (never forwarded to the CLI, never interpolated into a command):

| Parameter                                                                  | Whitelist / type check                                                                                                 | Invalid input handling                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `--cli-region`                                                             | string; must be a real Huawei Cloud region code (e.g. `cn-north-4`)                                                    | reject, ask for a valid region             |
| `--trace_type`                                                             | enum: `system` \| `data`                                                                                               | reject anything else                       |
| `--notification_type`                                                      | enum: `smn` \| `fun`                                                                                                   | reject anything else                       |
| `--tracker_type`                                                           | enum: `system` \| `data`                                                                                               | reject anything else                       |
| `--operation_type`                                                         | enum: `complete` \| `customized`                                                                                       | reject anything else                       |
| `--trace_rating`                                                           | enum: `normal` \| `warning` \| `incident`                                                                              | reject anything else                       |
| `--limit`                                                                  | integer, 1–200                                                                                                         | reject non-integer / out-of-range          |
| `--from` / `--to`                                                          | 13-digit integer (epoch ms), used together                                                                             | reject malformed / mismatched pairs        |
| `--project_id` / `--domain_id`                                             | 32-hex-char string                                                                                                     | reject anything else                       |
| `--tracker_name`, `--notification_name`, `--topic_id` (any name/URN value) | plain string; no spaces, no shell metacharacters (semicolon, ampersand, dollar sign, backtick, quotes, angle brackets) | reject if it contains shell metacharacters |

Rule: if a value fails its whitelist/type check, return a `U` (user input) error and do **not**
execute the command. Never echo caller input into a command line without validation.

### ListOperations

| Parameter         | Required | Type   | Description                                           |
| ----------------- | -------- | ------ | ----------------------------------------------------- |
| `--project_id`    | Yes      | string | Project ID (path)                                     |
| `--resource_type` | No       | string | Resource type; if used, `--service_type` is mandatory |
| `--service_type`  | No       | string | Cloud service type (e.g. ECS)                         |

### ListTraces

| Parameter                                               | Required | Type    | Description                                                             |
| ------------------------------------------------------- | -------- | ------- | ----------------------------------------------------------------------- |
| `--project_id`                                          | Yes      | string  | Project ID (path)                                                       |
| `--trace_type`                                          | Yes      | string  | Trace type: `system` (default) or `data`                                |
| `--from` / `--to`                                       | No       | integer | UTC ms timestamps (13 digits), used together; default = last hour → now |
| `--limit`                                               | No       | integer | Number of traces, default 10, max 200                                   |
| `--next`                                                | No       | string  | Pagination marker (value of `marker` in response)                       |
| `--user`                                                | No       | string  | User name filter (system traces only)                                   |
| `--service_type`                                        | No       | string  | Cloud service acronym filter (system traces only)                       |
| `--resource_id` / `--resource_name` / `--resource_type` | No       | string  | Resource filters (system traces only)                                   |
| `--trace_id`                                            | No       | string  | Trace ID; if set, other criteria are ignored                            |
| `--trace_name`                                          | No       | string  | Trace name (system traces only)                                         |
| `--trace_rating`                                        | No       | string  | Trace status: `normal` \| `warning` \| `incident`                       |
| `--tracker_name`                                        | No       | string  | System traces: `system`; data traces: data tracker name                 |
| `--enterprise_project_id`                               | No       | string  | Enterprise project filter                                               |
| `--access_key_id`                                       | No       | string  | Access key used to query traces                                         |

### CreateTracker

| Parameter                                       | Required | Type    | Description                                             |
| ----------------------------------------------- | -------- | ------- | ------------------------------------------------------- |
| `--project_id`                                  | Yes      | string  | Project ID (path)                                       |
| `--tracker_name`                                | Yes      | string  | Tracker name (default `system` for system type)         |
| `--tracker_type`                                | Yes      | string  | `system` (management tracker) or `data` (data tracker)  |
| `--obs_info.bucket_name`                        | No*      | string  | OBS bucket for log delivery (*needed for OBS delivery)  |
| `--obs_info.is_obs_created`                     | No       | boolean | `true` = create new bucket, `false` = use existing      |
| `--obs_info.file_prefix_name`                   | No       | string  | File name prefix for OBS trace files                    |
| `--obs_info.compress_type`                      | No       | string  | `gzip` (default) or `json`                              |
| `--obs_info.bucket_lifecycle`                   | No       | integer | Retention days in OBS bucket (data tracker only)        |
| `--obs_info.is_sort_by_service`                 | No       | boolean | Sort transfer path by cloud service (default true)      |
| `--is_lts_enabled`                              | No       | boolean | Enable LTS trace analysis (long retention)              |
| `--is_organization_tracker`                     | No       | boolean | `true` = org tracker (cross-account dumps)              |
| `--is_support_trace_files_encryption`           | No       | boolean | Encrypt OBS trace files (with `--kms_id`)               |
| `--kms_id`                                      | No       | string  | KMS key ID (mandatory when encryption enabled)          |
| `--is_support_validate`                         | No       | boolean | Enable trace file verification                          |
| `--agency_name`                                 | No       | string  | `cts_admin_trust` auto-creates the cloud service agency |
| `--data_bucket.data_bucket_name`                | No       | string  | Bucket tracked by a data tracker                        |
| `--data_bucket.data_event.1`                    | No       | array   | Data tracker events: `WRITE` \| `READ`                  |
| `--management_event_selector.exclude_service.1` | No       | array   | Services excluded from dump (currently only KMS)        |

### ListTrackers

| Parameter        | Required | Type   | Description                          |
| ---------------- | -------- | ------ | ------------------------------------ |
| `--project_id`   | Yes      | string | Project ID (path)                    |
| `--tracker_name` | No       | string | Tracker name; omitted → all trackers |
| `--tracker_type` | No       | string | `system` or `data`                   |

### DeleteTracker

| Parameter        | Required | Type   | Description                               |
| ---------------- | -------- | ------ | ----------------------------------------- |
| `--project_id`   | Yes      | string | Project ID (path)                         |
| `--tracker_name` | No       | string | Tracker name; omitted → all data trackers |
| `--tracker_type` | No       | string | `data` (default) or `system`              |

### CreateNotification

| Parameter                          | Required | Type    | Description                                                                                                              |
| ---------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--project_id`                     | Yes      | string  | Project ID (path)                                                                                                        |
| `--notification_name`              | Yes      | string  | Notification name                                                                                                        |
| `--operation_type`                 | Yes      | string  | `complete` (all operations) or `customized`                                                                              |
| `--topic_id`                       | No       | string  | SMN topic URN or FunctionGraph function URN                                                                              |
| `--agency_name`                    | No       | string  | `cts_admin_trust` auto-creates agency                                                                                    |
| `--operations.1.service_type`      | No       | string  | Cloud service acronym (customized type)                                                                                  |
| `--operations.1.resource_type`     | No       | string  | Resource type (customized type)                                                                                          |
| `--operations.1.trace_names.1`     | No       | array   | Trace names (customized type)                                                                                            |
| `--notify_user_list.1.user_group`  | No       | string  | IAM user group                                                                                                           |
| `--notify_user_list.1.user_list.1` | No       | array   | IAM users                                                                                                                |
| `--filter.is_support_filter`       | No       | boolean | Enable advanced filter                                                                                                   |
| `--filter.condition`               | No       | string  | `AND` or `OR` between filter rules                                                                                       |
| `--filter.rule.1`                  | No       | array   | Filter rule, format `field rule value` (fields: api_version, code, trace_rating, trace_type, resource_id, resource_name) |

### ListNotifications

| Parameter             | Required | Type   | Description                                    |
| --------------------- | -------- | ------ | ---------------------------------------------- |
| `--project_id`        | Yes      | string | Project ID (path)                              |
| `--notification_type` | Yes      | string | `smn` or `fun` (path param)                    |
| `--notification_name` | No       | string | Notification name; omitted → all notifications |

### ListTraceResources

| Parameter     | Required | Type   | Description                              |
| ------------- | -------- | ------ | ---------------------------------------- |
| `--domain_id` | Yes      | string | Account (domain) ID — **not** project ID |

## Error Code Convention

| Prefix | Category      | Examples                                       |
| ------ | ------------- | ---------------------------------------------- |
| U      | User input    | U01 missing param, U03 no data found           |
| C      | Configuration | C01 missing AK/SK/env, C02 missing project_id  |
| N      | Network       | N01 timeout, N02 connection refused            |
| B      | Code bug      | B01 null pointer, B04 version mismatch         |
| P      | Platform      | P01 scheduler error, P02 resource insufficient |

## KooCLI Command Format Standard

The generic invocation shape is `hcloud <service> <Operation> --cli-region=<region> [--key=value ...]`
— this is a **format description only**: `<...>` and `[--key=value]` are placeholders, never executed verbatim.

| Feature           | Rule                                                               | Example                                                |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| Service name      | `CTS` (metadata directory `cts`; case-insensitive for invocation)  | `hcloud CTS ListTrackers`                              |
| Operation name    | PascalCase                                                         | `ListTrackers`, `CreateTracker`                        |
| Region parameter  | `--cli-region=<value>` always included                             | `--cli-region=cn-north-4`                              |
| Simple parameter  | `--key=value`                                                      | `--project_id=xxx`                                     |
| Indexed parameter | `--key.1=value1`                                                   | `--operations.1.service_type=ECS`                      |
| Nested parameter  | `--parent.child=value`                                             | `--obs_info.bucket_name=xxx`                           |
| Verification      | Run `--help` first; parameter names come from `--help` output only | `hcloud CTS ListTraces --cli-region=cn-north-4 --help` |

## Reference Documents

- `references/iam-policies.md` — Least-privilege IAM policies for CTS
- `references/cli-installation-guide.md` — hcloud CLI installation and AK/SK/profile authentication
- `references/verification-method.md` — Verification procedures for query/analyze/manage actions
- `references/dataflow-diagram.md` — Mermaid data flow diagrams
- `references/acceptance-criteria.md` — Acceptance criteria for this skill
- `templates/test-defaults.json` / `templates/test-vars.json` — CLI test-case definitions (query / syntax check)
- `scripts/ensure_cli.sh` — availability check for the OPTIONAL `skill-quality-cli` wrapper
