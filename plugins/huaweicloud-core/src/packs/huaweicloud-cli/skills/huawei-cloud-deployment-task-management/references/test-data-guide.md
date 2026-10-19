# Test Data Guide for huawei-cloud-deployment-task-management

How to supply real test data for live verification of this skill.

## Why command examples use placeholders

For security, this skill never embeds
a real 32-hex project ID / task ID / access key in code or templates. All command
examples use `{placeholders}` that must be replaced with concrete values belonging
to the executing environment before any **live** (non `--help`) execution.

Live runs must backfill the skill's command placeholders:
`{region}`, `{project_id}`, `{project_name}`, `{task_id}`, `{task_name}`, `{app_name}`,
`{app_id}`, `{template_id}`, `{artifact_bucket}`, `{artifact_object_path}` (plus
`{description}` / `{param_name}` / `{param_value}` where an example uses them).
Environment-derived values (`region`, IDs, buckets) come from the executing
environment; user-chosen names (`task_name` / `app_name`) are supplied at
confirmation time.

## Placeholders and how to fill them

| Placeholder                                    | Meaning                                              | How to obtain                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{region}`                                     | Region, e.g. `cn-north-4`                            | `huaweicloud_show_profile_redacted` (raw `hcloud configure list` is hook-blocked in agent tools)                                                                                                                                                    |     |
| `{project_id}`                                 | IAM (CodeArts) project ID                            | `hcloud IAM KeystoneShowProject` or the test account project page                                                                                                                                                                                   |
| `{project_name}`                               | CodeArts project name (same project as {project_id}) | `hcloud IAM KeystoneShowProject` or the test account project page                                                                                                                                                                                   |
| `{task_id}`                                    | Deployment task ID                                   | `hcloud CodeArtsDeploy ListDeployTasks --cli-region={region} --project_id={project_id} --page=1 --size=10`                                                                                                                                          |     |
| `{app_name}`                                   | Application (app) name                               | `hcloud CodeArtsDeploy ListAllApp --cli-region={region} --project_id={project_id} --page=1 --size=10`                                                                                                                                               |     |
| `{template_id}`                                | Template ID for `CreateDeployTaskByTemplate`         | No CLI list operation exists for deploy templates (`CodeArtsDeploy` has no `ShowTemplate`/`ListTemplates`) — copy the template ID from the **CodeArts Deploy console 模板库** when creating an app from a template, or from the template's page URL |
| `{artifact_bucket}` / `{artifact_object_path}` | OBS object referenced by the task artifact           | Task detail artifact config (`ShowDeployTaskDetail`)                                                                                                                                                                                                |

## Backfilling before automated runs

`templates/test-defaults.json` exposes `request_defaults` (currently
`{project_id}` / `{domain_id}` placeholders). For live write-path coverage, a test
runner must set these to the executing environment’s real values **in its own test
environment** (do not commit real IDs):

```json
{
  "request_defaults": {
    "project_id": "<real-32-hex>",
    "domain_id": "<real-32-hex>"
  }
}
```

Modifying `templates/test-defaults.json` or `templates/test-vars.json` inside this
skill directory with real IDs would defeat the placeholder discipline, so real
values are supplied only by the executing environment, never committed to the repo.

## Service-name trap (expected behavior, not a defect)

`hcloud CloudDeploy ...` legitimately fails with
`[USE_ERROR]Unsupported service: CloudDeploy.` (en locale;
`[USE_ERROR]不支持的服务名称:CloudDeploy` under `--cli-lang=cn`) because CodeArts Deploy is served by
KooCLI as `CodeArtsDeploy`. An automated harness must treat that "correct
rejection" as a **pass** (same semantics as the negative test `hcloud CloudDeploy
must fail`), not as a functional failure.

## OBS artifact check

`huawei_analyze_clouddeploy_artifact` uses `hcloud obs ...` (obsutil passthrough).
Before the first check on a machine, configure once and self-check:

```bash
# Interactive configuration (recommended) — AK/SK are typed at the terminal, never
# entered as command-line arguments, so they stay out of shell history / ps output:
hcloud obs config -interactive
# Devkit alternative (no typing): huaweicloud_setup_obs_config mirrors the
# authenticated credentials into ~/.obsutilconfig. Never pass AK/SK as -i=/-k=
# command-line arguments (shell history / ps aux leak vector).
hcloud obs ls obs://{artifact_bucket}
```

If `hcloud obs ls obs://{artifact_bucket}` prints
`Warn: Please set ak, sk and endpoint in the configuration file!`, obsutil is not
configured yet (environment dependency) - run the config + `hcloud obs ls obs://{artifact_bucket}` above.
