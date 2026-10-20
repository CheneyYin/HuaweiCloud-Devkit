# Verification Method

How to verify that the huawei-cloud-smn-dms-message skill is correctly installed and functional.

## 1. Environment sanity check

```bash
hcloud version                                # KooCLI installed (7.x)
hcloud SMN --help           | head -5        # SMN service reachable
hcloud Kafka --help         | head -5        # Kafka service reachable
hcloud RabbitMQ --help      | head -5        # RabbitMQ service reachable
hcloud RocketMQ --help      | head -5        # RocketMQ service reachable
```

Expected: each `--help` prints "Service:" + "Available Operations".

## 2. Read-only smoke test (no resources changed)

```bash
hcloud SMN ListTopics --cli-region=cn-north-4 --limit=1
hcloud SMN ListSubscriptions --cli-region=cn-north-4 --limit=1
hcloud SMN ListMessageTemplates --cli-region=cn-north-4 --limit=1
hcloud Kafka ListInstances --engine=kafka --cli-region=cn-north-4 --limit=1
hcloud RabbitMQ ListInstancesDetails --engine=rabbitmq --cli-region=cn-north-4 --limit=1
hcloud RocketMQ ListInstances --engine=rocketmq --cli-region=cn-north-4 --limit=1
```

Expected: valid JSON responses (empty lists are fine; an auth/region error is a failure).

## 3. Action-level verification (direct hcloud commands)

The corpus script executor does not ship — each `huawei_*` action maps to the direct
`hcloud` command in SKILL.md "Core Commands"; verify action construction by reading
the command against `hcloud <Service> <Operation> --help` before executing it.

## 4. Write-action dry-run

For every R2/R1 action, present the exact command via
`huaweicloud_plan_cli_command` (or pass `--dryrun` where the operation supports
it) and verify the printed command matches the SKILL.md Core Commands template
and the current `hcloud <Service> <Operation> --help` before executing.

## 5. Full behavioral test (optional, requires real resources + confirmation)

1. Create a topic (`huawei_create_smn_topic`) → confirm it appears in `huawei_list_smn_topics`.
2. Add an email subscription (`huawei_add_smn_subscription`) → confirm `status=0` until the user
   clicks the mail link, then `status=1`.
3. Publish a message (`huawei_publish_smn_message`) → recipient receives it (email/SMS billing applies).
4. Create a Kafka instance (smallest flavor) → wait for `RUNNING` → list its topics → delete it.

Clean up all created resources and record before/after in the acceptance report.

## 6. Wrapper (OPTIONAL) sanity

```bash
command -v skill-quality-cli   # or ~/.local/bin/skill-quality-cli (OPTIONAL; bare hcloud is equivalent)
skill-quality-cli run --skill-name huawei-cloud-smn-dms-message -- hcloud SMN ListTopics --cli-region=cn-north-4 --limit=1
```

The wrapper is OPTIONAL: when absent, run the inner `hcloud` command from the examples
directly. It performs no reporting and contacts no endpoint.
