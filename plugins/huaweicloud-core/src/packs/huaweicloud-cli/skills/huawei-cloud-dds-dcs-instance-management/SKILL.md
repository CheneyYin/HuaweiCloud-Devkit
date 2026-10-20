---
name: huawei-cloud-dds-dcs-instance-management
description: 'Huawei Cloud DDS (Document Database Service) and DCS (Distributed Cache Service) unified management skill. Provides 16 operations across five capability domains: (1) Query — list/get DDS/DCS instances, DCS node info, DCS custom templates; (2) Analysis — analyze DDS deployment architecture and DCS security posture; (3) DDS Management — create instance, add read-only/sharding nodes, create backup, delete instance; (4) DCS Management — create instance, create custom template, delete instance, restart instance; (5) Multi-mode execution using hcloud CLI for available operations and huaweicloudsdk Python SDK as fallback. Auth via AK/SK environment variables or hcloud profile. All mutating operations require explicit user confirmation. Triggers include: "DDS","DCS","文档数据库","分布式缓存","数据库实例","缓存实例","MongoDB","Redis","Memcached","DDS实例","DCS实例","数据库运维","缓存运维","文档数据库查询","分布式缓存查询","DDS管理","DCS管理","缓存节点","自定义模板","document database","distributed cache","DDS instances","DCS instances","MongoDB cluster","Redis cache","dds-dcs".'
tags: [huawei-cloud, dds, dcs, database, cache]
---

# Huawei Cloud DDS & DCS Management Skill

> Unified management skill for Huawei Cloud Document Database Service (DDS) and Distributed Cache Service (DCS) — covering instance query, deployment analysis, security assessment, and full lifecycle management.

---

<!-- cli-install-version: 3.9.0 -->

## Step 0: Optional command wrapper (skip freely)

> **The wrapper is OPTIONAL.** When `skill-quality-cli` is installed, the wrapped examples in this skill run as written; when it is absent, run the inner `hcloud` command bare — identical semantics (the devkit's safety layer classifies both forms the same way). Check availability with `bash scripts/ensure_cli.sh` (existence check only; no install, no PATH persistence, no network).

**Write-path routing**: `hcloud` write operations in this skill go through the devkit's approval chain — present the planned command with `huaweicloud_plan_cli_command`, then execute with `huaweicloud_run_approved_command` (raw Bash writes are hook-blocked). Read operations may run bare or wrapped.

## Overview

This skill provides comprehensive management for two Huawei Cloud middleware services:

| Service                             | Engine Types                | Category                       |
| ----------------------------------- | --------------------------- | ------------------------------ |
| **DDS** (Document Database Service) | DDS-Community, DDS-Enhanced | MongoDB-compatible document DB |
| **DCS** (Distributed Cache Service) | Redis, Memcached            | In-memory cache                |

### Capability Matrix

| #   | Action                              | Service | Mode    | Severity    |
| --- | ----------------------------------- | ------- | ------- | ----------- |
| 1   | `huawei_list_dds_instances`         | DDS     | CLI     | R3 Query    |
| 2   | `huawei_get_dds_instance`           | DDS     | CLI     | R3 Query    |
| 3   | `huawei_list_dcs_instances`         | DCS     | CLI     | R3 Query    |
| 4   | `huawei_get_dcs_nodes_information`  | DCS     | SDK     | R3 Query    |
| 5   | `huawei_list_dcs_custom_templates`  | DCS     | SDK     | R3 Query    |
| 6   | `huawei_analyze_dds_deployment`     | DDS     | CLI     | R3 Analysis |
| 7   | `huawei_analyze_dcs_security`       | DCS     | CLI+SDK | R3 Analysis |
| 8   | `huawei_create_dds_instance`        | DDS     | CLI     | R2 Mgmt     |
| 9   | `huawei_add_dds_readonly_node`      | DDS     | CLI     | R2 Mgmt     |
| 10  | `huawei_add_dds_sharding_node`      | DDS     | CLI     | R2 Mgmt     |
| 11  | `huawei_create_dds_backup`          | DDS     | CLI     | R2 Mgmt     |
| 12  | `huawei_create_dcs_instance`        | DCS     | SDK     | R2 Mgmt     |
| 13  | `huawei_create_dcs_custom_template` | DCS     | SDK     | R2 Mgmt     |
| 14  | `huawei_delete_dds_instance`        | DDS     | CLI     | R1 Mgmt     |
| 15  | `huawei_delete_dcs_instance`        | DCS     | CLI     | R1 Mgmt     |
| 16  | `huawei_restart_dcs_instance`       | DCS     | CLI     | R1 Mgmt     |

### Architecture

```
User Request → Action Router
  ├── DDS Actions → hcloud DDS CLI (all DDS operations)
  └── DCS Actions → hcloud DCS CLI (primary) → SDK fallback (create_instance,
       show_nodes_information, list_config_templates, create_custom_template)
       → Result Formatting → Analysis & Recommendations
```

---

**Dependency**: `hcloud` for CLI operations; the Python SDK package (`huaweicloudsdkdcs`) only for the DCS SDK fallback operations — the optional `skill-quality-cli` wrapper is a local convenience only (no telemetry, no network).

## Prerequisites

| Requirement         | Description                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| **hcloud CLI**      | Installed and authenticated. See `references/cli-installation-guide.md`                         |
| **Python 3.8+**     | For SDK fallback operations (DCS)                                                               |
| **SDK packages**    | `pip install huaweicloudsdkdcs huaweicloudsdkdds`                                               |
| **AK/SK Auth**      | `HUAWEICLOUD_SDK_AK`/`HUAWEICLOUD_SDK_SK` (or `HUAWEI_ACCESS_KEY`/`HUAWEI_SECRET_KEY`) env vars |
| **IAM Permissions** | DDS and DCS read/write perms. See `references/iam-policies.md`                                  |
| **Default Region**  | `cn-north-4` (override with `--cli-region`)                                                     |

- **`skill-quality-cli`** — OPTIONAL; `bash scripts/ensure_cli.sh` only checks availability (bare `hcloud` is equivalent). The normalized wrapper has no upgrade subcommand; the shipped `scripts/cli/cli_entry.py` is the current version (re-copy it to refresh a manual deployment).

## Workflow

> **Command format.** Each command below is shown in its canonical bare
> `hcloud DDS|DCS <Operation> ...` form — this is the syntax used for parameter
> discovery (`--help`) and for execution. When the OPTIONAL
> `skill-quality-cli` wrapper is installed, the equivalent wrapped form
> works identically (see Step 0); when it is absent, run the bare form.
>
> **Always run `hcloud DDS|DCS <Operation> --cli-region={region} --help` before constructing a command** to discover the exact parameter names and required flags for the current KooCLI version. Do not answer from general knowledge.

### Query (R3) — Instance Listing & Details

```bash
# List DDS instances (all, with optional filters)
hcloud DDS ListInstances --cli-region={region}
hcloud DDS ListInstances --cli-region={region} --datastore_type=DDS-Community
hcloud DDS ListInstances --cli-region={region} --id={instance_id}  # single instance
# Filter by deployment mode. NOTE: `--mode` shares its name with a KooCLI system
# parameter, so KooCLI prompts for confirmation. Interactive: type `b` (target API
# parameter) when prompted. Non-interactive/scripted: pipe the answer (verified):
echo b | hcloud DDS ListInstances --cli-region={region} --mode=ReplicaSet
# KooCLI-recommended alternative for non-interactive environments: pass the
# parameter via a JSON input file (verified; note --project_id is required
# on the cli-jsonInput path):
#   echo '{"query": {"mode": "ReplicaSet"}}' > /tmp/dds_mode.json
#   hcloud DDS ListInstances --cli-region={region} --project_id={project_id} --cli-jsonInput=/tmp/dds_mode.json
# Alternative without the prompt: list all and filter by `mode` client-side.
# Wrapped equivalent (the wrapper is OPTIONAL):
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DDS ListInstances --cli-region={region}

# List DCS instances
hcloud DCS ListInstances --cli-region={region}
hcloud DCS ListInstances --cli-region={region} --name={name}
hcloud DCS ListInstances --cli-region={region} --instance_id={id}
hcloud DCS ListInstances --cli-region={region} --status={status}
# Optional filter: --capacity={gb} (cache capacity in GB, per `DCS ListInstances --help`).
# Wrapped equivalent (the wrapper is OPTIONAL):
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DCS ListInstances --cli-region={region}
```

### Query (R3) — DCS Node Information (SDK)

> Fallback path when the CLI cannot be used. Requires `pip install huaweicloudsdkdcs`.

```python
# Service: DCS (huaweicloudsdkdcs.v2)
from huaweicloudsdkcore.auth.credentials import BasicCredentials
from huaweicloudsdkdcs.v2 import DcsClient
from huaweicloudsdkdcs.v2.model import ShowNodesInformationRequest
from huaweicloudsdkdcs.v2.region.dcs_region import DcsRegion

creds = BasicCredentials().with_ak('{ak}').with_sk('{sk}')
client = DcsClient.new_builder() \
    .with_credentials(creds) \
    .with_region(DcsRegion.value_of('cn-north-4')) \
    .build()

request = ShowNodesInformationRequest(instance_id='{instance_id}')
response = client.show_nodes_information(request)
print(response)
```

### Query (R3) — List Custom Templates (SDK)

```python
# Service: DCS (huaweicloudsdkdcs.v2)
from huaweicloudsdkcore.auth.credentials import BasicCredentials
from huaweicloudsdkdcs.v2 import DcsClient
from huaweicloudsdkdcs.v2.model import ListConfigTemplatesRequest
from huaweicloudsdkdcs.v2.region.dcs_region import DcsRegion

creds = BasicCredentials().with_ak('{ak}').with_sk('{sk}')
client = DcsClient.new_builder() \
    .with_credentials(creds) \
    .with_region(DcsRegion.value_of('cn-north-4')) \
    .build()

# `type` is required: 'user' for custom templates, 'sys' for system templates.
# `engine_version` and `cache_mode` are also required — omitting them returns
# DCS.4063 (missing required parameters).
request = ListConfigTemplatesRequest(
    type='user', engine='Redis', engine_version='5.0', cache_mode='single')
response = client.list_config_templates(request)
print(response)
```

### Analysis (R3) — Analyze DDS Deployment

Combines multiple queries to assess deployment architecture:

```bash
# Step 1: List all instances to understand topology
hcloud DDS ListInstances --cli-region={region} --limit=100

# Step 2: Check available flavors and storage types
hcloud DDS ListFlavors --cli-region={region} --engine_name=DDS-Community
hcloud DDS ListStorageType --cli-region={region}

# Step 3: For each instance, check config and backup policy
# `--entity_id` is required: pass the instance ID for replica set / single-node,
# or the group ID / node ID for cluster (sharding) instances.
hcloud DDS ShowEntityConfiguration --cli-region={region} --instance_id={id} --entity_id={entity_id}
hcloud DDS ShowBackupPolicy --cli-region={region} --instance_id={id}

skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DDS ListInstances --cli-region={region} --limit=100
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DDS ListFlavors --cli-region={region} --engine_name=DDS-Community
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DDS ListStorageType --cli-region={region}
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DDS ShowEntityConfiguration --cli-region={region} --instance_id={id} --entity_id={entity_id}
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DDS ShowBackupPolicy --cli-region={region} --instance_id={id}
```

### Analysis (R3) — Analyze DCS Security

```bash
# Step 1: List instances to inventory
hcloud DCS ListInstances --cli-region={region}

# Step 2: Check IP whitelist per instance
hcloud DCS ShowIpWhitelist --cli-region={region} --instance_id={id}

# Step 3: Check instance details (security group, SSL)
hcloud DCS ShowInstance --cli-region={region} --instance_id={id}

# Step 4: Check ACL accounts
hcloud DCS ListAclAccounts --cli-region={region} --instance_id={id}

# Step 5: (SDK fallback) Inspect SSL/connection details via SDK — see the
# "DCS Node Information (SDK)" example above; replace the request with ShowInstanceRequest.

skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DCS ListInstances --cli-region={region}
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DCS ShowIpWhitelist --cli-region={region} --instance_id={id}
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DCS ShowInstance --cli-region={region} --instance_id={id}
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DCS ListAclAccounts --cli-region={region} --instance_id={id}
```

### Management (R2) — Create DDS Instance

> ⚠️ Creates billable resources. **Always confirm with the user first.**

```bash
# Replica set (3 nodes)
# NOTE: `--region` and `--vpc_id` are required body parameters of DDS CreateInstance — keep them.
# KooCLI prints a harmless "cli-region/region coexist" notice; that is expected.
# `--mode` also shares a name with a KooCLI system parameter — when prompted,
# answer `b` (target API parameter); in non-interactive envs use the `echo b |` prefix.
hcloud DDS CreateInstance --cli-region={region} \
  --name=my-dds --region={region} \
  --availability_zone={az} \
  --datastore.type=DDS-Community \
  --datastore.version=5.0 --datastore.storage_engine=wiredTiger \
  --mode=ReplicaSet \
  --flavor.1.type=replica --flavor.1.num=3 \
  --flavor.1.spec_code={spec_code} \
  --vpc_id={vpc_id} --subnet_id={subnet} --security_group_id={sg}
# Non-interactive prompt workaround (answer `b` to the `--mode` prompt):
#   echo b | hcloud DDS CreateInstance --cli-region={region} ... (same args)
#   echo b | hcloud DDS CreateInstance --cli-region={region} --name=my-dds --region={region} --availability_zone={az} --datastore.type=DDS-Community --datastore.version=5.0 --datastore.storage_engine=wiredTiger --mode=ReplicaSet --flavor.1.type=replica --flavor.1.num=3 --flavor.1.spec_code={spec_code} --vpc_id={vpc_id} --subnet_id={subnet} --security_group_id={sg}
# Fully non-interactive alternative (no prompts, recommended for CI/automation):
# NOTE: KooCLI 7.2.12 requires the API params to be wrapped under a "body" key
# {vpc_id, subnet_id, security_group_id, region} are required body params besides
# the direct flags shown above; `--project_id` is required on the `--cli-jsonInput`
# path (unlike the bare form, where it is auto-resolved from the profile).
#   cat > /tmp/dds_create.json <<'JSON'
#   {"body":{"name":"my-dds","region":"{region}","availability_zone":"{az}","vpc_id":"{vpc_id}","subnet_id":"{subnet}","security_group_id":"{sg}",
#    "mode":"ReplicaSet","datastore":{"type":"DDS-Community","version":"5.0","storage_engine":"wiredTiger"},
#    "flavor":[{"type":"replica","num":3,"spec_code":"{spec_code}"}]}}
#   JSON
#   hcloud DDS CreateInstance --cli-region={region} --project_id={project_id} --cli-jsonInput=/tmp/dds_create.json

# Single node
hcloud DDS CreateInstance --cli-region={region} \
  --name=my-dds-single --region={region} \
  --availability_zone={az} \
  --datastore.type=DDS-Community \
  --datastore.version=5.0 --datastore.storage_engine=wiredTiger \
  --mode=Single \
  --flavor.1.type=single --flavor.1.num=1 \
  --flavor.1.spec_code={spec_code} \
  --vpc_id={vpc_id} --subnet_id={subnet} --security_group_id={sg}

```

### Management (R2) — Add DDS Read-only Node

> ⚠️ Adds billable nodes. Confirm with user.

```bash
# `--spec_code` is required (DDS AddReadonlyNode body param, e.g. dds.mongodb.c6.large.4.rr)
hcloud DDS AddReadonlyNode --cli-region={region} --instance_id={instance_id} --num=1 --spec_code={spec_code}
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DDS AddReadonlyNode --cli-region={region} --instance_id={instance_id} --num=1 --spec_code={spec_code}
```

### Management (R2) — Add DDS Sharding Node

> ⚠️ Modifies cluster capacity. Confirm with user.

```bash
hcloud DDS AddShardingNode --cli-region={region} --instance_id={instance_id} --type=shard --num=2 --spec_code={spec}

hcloud DDS AddShardingNode --cli-region={region} --instance_id={instance_id} --type=mongos --num=2 --spec_code={spec}
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DDS AddShardingNode --cli-region={region} --instance_id={instance_id} --type=shard --num=2 --spec_code={spec}
```

### Management (R2) — Create DDS Backup

```bash
hcloud DDS CreateManualBackup --cli-region={region} --backup.instance_id={instance_id} --backup.name={backup_name}
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DDS CreateManualBackup --cli-region={region} --backup.instance_id={instance_id} --backup.name={backup_name}
```

### Management (R2) — Create DCS Instance (SDK)

> ⚠️ Creates billable resources. Confirm with user. Requires `pip install huaweicloudsdkdcs`.

```python
# Service: DCS (huaweicloudsdkdcs.v2)
from huaweicloudsdkcore.auth.credentials import BasicCredentials
from huaweicloudsdkdcs.v2 import DcsClient
from huaweicloudsdkdcs.v2.model import CreateInstanceBody, CreateInstanceRequest
from huaweicloudsdkdcs.v2.region.dcs_region import DcsRegion

creds = BasicCredentials().with_ak('{ak}').with_sk('{sk}')
client = DcsClient.new_builder() \
    .with_credentials(creds) \
    .with_region(DcsRegion.value_of('cn-north-4')) \
    .build()

body = CreateInstanceBody(
    name="my-redis-instance",
    engine="Redis",
    engine_version="5.0",
    capacity=1,
    spec_code="{spec_code}",
    # no_password_access defaults to False, and with False the API REQUIRES a
    # password. True = VPC-internal access without a password (whitelist rules
    # still apply). Pick one explicitly.
    no_password_access=True,
    vpc_id="{vpc_id}",
    subnet_id="{subnet_id}",
    security_group_id="{sg_id}",
    az_codes=["{az_code}"],
)
request = CreateInstanceRequest(body=body)
response = client.create_instance(request)
print(response)
```

### Management (R2) — Create DCS Custom Template (SDK)

> ⚠️ Confirm with user. Requires `pip install huaweicloudsdkdcs`.

```python
# Service: DCS (huaweicloudsdkdcs.v2)
from huaweicloudsdkcore.auth.credentials import BasicCredentials
from huaweicloudsdkdcs.v2 import DcsClient
from huaweicloudsdkdcs.v2.model import CreateCustomTemplateBody, CreateCustomTemplateRequest
from huaweicloudsdkdcs.v2.region.dcs_region import DcsRegion

creds = BasicCredentials().with_ak('{ak}').with_sk('{sk}')
client = DcsClient.new_builder() \
    .with_credentials(creds) \
    .with_region(DcsRegion.value_of('cn-north-4')) \
    .build()

# Required body fields: name, engine, cache_mode; engine_version and template_id
# (source template) are strongly recommended. `type` = 'user' for custom templates.
body = CreateCustomTemplateBody(
    name="my-template",
    type="user",
    engine="Redis",
    engine_version="5.0",
    cache_mode="single",
    description="my custom template",
    params={"timeout": "300"},
    template_id="{source_template_id}",
)
request = CreateCustomTemplateRequest(body=body)
response = client.create_custom_template(request)
print(response)
```

### Management (R1) — Delete DDS Instance

> ⚠️ **Permanently deletes instance and ALL data. Double-confirm with user.**

```bash
hcloud DDS DeleteInstance --cli-region={region} --instance_id={instance_id}
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DDS DeleteInstance --cli-region={region} --instance_id={instance_id}
```

### Management (R1) — Delete DCS Instance

> ⚠️ **Permanently deletes cache and ALL data. Double-confirm with user.**

```bash
hcloud DCS DeleteSingleInstance --cli-region={region} --instance_id={id}
skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DCS DeleteSingleInstance --cli-region={region} --instance_id={id}
```

### Management (R1) — Restart DCS Instance

> ⚠️ Causes service interruption. `action=flush` deletes cached data.

```bash
# Force restart
hcloud DCS RestartOrFlushInstances --cli-region={region} --instances.1={instance_id} --action=restart

# Soft restart (process only)
hcloud DCS RestartOrFlushInstances --cli-region={region} --instances.1={instance_id} --action=soft_restart

# Restart multiple instances
hcloud DCS RestartOrFlushInstances --cli-region={region} --instances.1={id1} --instances.2={id2} --action=restart

skill-quality-cli run --skill-name huawei-cloud-dds-dcs-instance-management -- hcloud DCS RestartOrFlushInstances --cli-region={region} --instances.1={instance_id} --action=restart
```

---

## KooCLI Command Format Standard

The generic invocation shape is `hcloud DDS|DCS <Operation> --cli-region=<region> [--key=value ...]`
— this is a **format description only**: `<...>` and `[--key=value]` are placeholders, never executed verbatim.

| Feature       | Description                                                        | Example                                                   |
| ------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| Service       | Service name (uppercase)                                           | `DDS`, `DCS`                                              |
| Operation     | PascalCase                                                         | `ListInstances`, `CreateInstance`                         |
| Region        | `--cli-region=value`                                               | `cn-north-4`                                              |
| Simple param  | `--key=value`                                                      | `--instance_id=xxx`                                       |
| Indexed param | `--key.N=value`                                                    | `--flavor.1.num=3`                                        |
| Nested param  | `--parent.child=value`                                             | `--datastore.type=DDS-Community`                          |
| Verification  | Run `--help` first; parameter names come from `--help` output only | `hcloud DDS ListInstances --cli-region=cn-north-4 --help` |

`--project_id` is resolved automatically from the profile (or the region parent project) when not passed; include it explicitly only when the profile has no default project.

---

## Parameter Confirmation

See `references/related-commands.md` for detailed parameter tables per action.

| Key Parameter                                | Service | Required For                           | Description                                          |
| -------------------------------------------- | ------- | -------------------------------------- | ---------------------------------------------------- |
| `instance_id`                                | DDS/DCS | Show/Delete/AddNode/Restart            | Instance UUID                                        |
| `name`                                       | DDS/DCS | Create/List                            | Instance name                                        |
| `datastore.*`                                | DDS     | Create                                 | Database type, version, engine                       |
| `flavor.[N].*`                               | DDS     | Create/AddNode                         | Node type, count, spec                               |
| `vpc_id` / `subnet_id` / `security_group_id` | DDS     | Create                                 | Network: VPC, subnet, security group (all required)  |
| `spec_code`                                  | DDS     | AddReadonlyNode/AddShardingNode/Create | Instance/flavor spec code (required on DDS body ops) |
| `capacity`                                   | DCS     | Create                                 | Cache capacity (GB)                                  |
| `engine`                                     | DCS     | Create/Templates                       | `Redis` or `Memcached`                               |
| `type` (template)                            | DCS     | List/Create                            | Template scope: `sys` or `user`                      |
| `action`                                     | DCS     | Restart                                | `restart`, `soft_restart`, or `flush`                |

---

## Critical Warnings

| Action                                            | Warning                                                                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_dds_instance` / `create_dcs_instance`     | Creates billable resources. Always confirm with user.                                                                                                                                                                            |
| `create_dcs_instance` body                        | `spec_code` is required. `no_password_access` defaults to False, and with False the API requires `password` — pass `no_password_access=True` for VPC-internal instances (whitelist rules still apply) or an explicit `password`. |
| `add_dds_readonly_node` / `add_dds_sharding_node` | Adds billable nodes. Confirm count/spec with user.                                                                                                                                                                               |
| `delete_dds_instance` / `delete_dcs_instance`     | **Permanently deletes ALL data.** Double-confirm; recommend backup.                                                                                                                                                              |
| `restart_dcs_instance` with `action=flush`        | **Permanently deletes all cached data.** Confirm action type.                                                                                                                                                                    |

---

## Authentication

### Mode 1: AK/SK Environment Variables

```bash
export HUAWEICLOUD_SDK_AK=your-access-key
export HUAWEICLOUD_SDK_SK=your-secret-key
# HUAWEI_ACCESS_KEY / HUAWEI_SECRET_KEY are accepted aliases
```

### Mode 2: hcloud CLI Profile

The agent never writes or inspects credentials: profile status comes from
`huaweicloud_show_profile_redacted` (raw `hcloud configure show/list/get/export/init`
is hook-blocked in agent tools), and credential setup is the user's single entry
point `npx huaweicloud-devkit auth init` — it writes the unified
`~/.config/huaweicloud/credentials.json` and mirrors it to KooCLI without AK/SK
entering shell history.

## Reference Documents

- `references/iam-policies.md` — Least-privilege IAM policies
- `references/cli-installation-guide.md` — CLI install & config
- `references/verification-method.md` — Verification details
- `references/dataflow-diagram.md` — Data flow diagram
- `references/acceptance-criteria.md` — Acceptance criteria
- `references/related-commands.md` — Full command reference
