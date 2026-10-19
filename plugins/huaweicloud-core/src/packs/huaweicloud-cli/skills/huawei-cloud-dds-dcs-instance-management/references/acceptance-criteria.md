# Acceptance Criteria

## Query Operations (R3)

| #   | Criteria                                                                      | Verification Method                        |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | `huawei_list_dds_instances` returns DDS instance list with pagination support | Execute CLI command and verify JSON output |
| 2   | `huawei_get_dds_instance` returns single DDS instance details by ID           | Execute CLI with `--id` filter             |
| 3   | `huawei_list_dcs_instances` returns DCS instance list with filtering          | Execute CLI command with various filters   |
| 4   | `huawei_get_dcs_nodes_information` returns node topology for DCS instance     | Execute SDK script and verify node list    |
| 5   | `huawei_list_dcs_custom_templates` returns list of custom config templates    | Execute SDK script with type filter        |

## Analysis Operations (R3)

| #   | Criteria                                                                            | Verification Method                                 |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| 6   | `huawei_analyze_dds_deployment` combines all DDS queries into deployment assessment | Run analysis workflow and validate output structure |
| 7   | `huawei_analyze_dcs_security` checks whitelist, SSL, ACL, and password policies     | Run security analysis workflow                      |

## Management Operations (R2)

| #   | Criteria                                                                   | Verification Method                         |
| --- | -------------------------------------------------------------------------- | ------------------------------------------- |
| 8   | `huawei_create_dds_instance` accepts valid parameters and creates instance | Confirm user, then execute with test params |
| 9   | `huawei_add_dds_readonly_node` adds nodes to replica set                   | Confirm user, then execute                  |
| 10  | `huawei_add_dds_sharding_node` adds shard/mongos to cluster                | Confirm user, then execute                  |
| 11  | `huawei_create_dds_backup` creates manual backup                           | Execute and verify backup list              |
| 12  | `huawei_create_dcs_instance` creates new cache instance via SDK            | Confirm user, then execute SDK script       |
| 13  | `huawei_create_dcs_custom_template` creates custom template via SDK        | Execute SDK script and verify template list |

## Management Operations (R1)

| #   | Criteria                                                      | Verification Method                              |
| --- | ------------------------------------------------------------- | ------------------------------------------------ |
| 14  | `huawei_delete_dds_instance` permanently deletes DDS instance | Double-confirm user, then execute                |
| 15  | `huawei_delete_dcs_instance` permanently deletes DCS instance | Double-confirm user, then execute                |
| 16  | `huawei_restart_dcs_instance` restarts DCS instance(s)        | Confirm user, then execute with `restart` action |

## Non-Functional Requirements

| #   | Criteria                                                     | Verification Method                                    |
| --- | ------------------------------------------------------------ | ------------------------------------------------------ |
| 17  | All CLI commands execute without error                       | Execute each command with `--help` against live KooCLI |
| 18  | SDK fallback scripts import and initialize without exception | Run Python import test                                 |
| 19  | No hardcoded credentials in any file                         | Grep for AK/SK patterns                                |
| 20  | Mutating operations always prompt for user confirmation      | Code review of workflow section                        |

## Wrapper scripts (normalized v2 form)

| #   | Criterion                                                                                                                                                                   | Verification                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 21  | `scripts/ensure_cli.sh` exists (availability check only; the wrapper is OPTIONAL)                                                                                           | `ls scripts/ensure_cli.sh`                  |
| 22  | `scripts/cli/cli_entry.py` ships the whitelist wrapper: `ALLOWED_COMMANDS = ("hcloud",)`, charset validation, passthrough stdio — no telemetry, no network, no self-upgrade | Read `scripts/cli/cli_entry.py`             |
| 23  | No reporting module ships (the guard asserts its absence); no quality-report E2E is required                                                                                | `ls scripts/cli/` shows only `cli_entry.py` |
| 24  | SKILL.md carries the optional-wrapper note and the approval write-path routing note                                                                                         | Review `SKILL.md` Step 0                    |
