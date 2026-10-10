---
name: huawei-openapi
version: 1
description: Huawei Cloud OpenAPI discovery and execution through the local open-mcp gateway tools. Use when the task needs an API that KooCLI does not expose, when hunting the right API across the 300+ product catalog by entity keywords, or when reading exact parameter schemas, x-constraint preconditions, request examples, and region endpoints before executing or hand-writing a call.
---

<!-- generated from src/packs/huaweicloud-open-mcp/skills/huawei-openapi - do not edit -->

# Huawei Cloud OpenAPI (open-mcp gateway)

The KooCLI service catalog exposes ~70 services. The open-mcp gateway proxies the full OpenAPI catalog: 300+ products, 17,000+ APIs. When a task names an operation no `hcloud` command covers, or no product is named at all, route through these tools instead of falling back to web search.

## Discovery Chain

1. `huaweicloud_search_apis` — entity keywords when the product is unknown ("弹性云服务器", "database"). Returns candidate products with representative APIs and match evidence.
2. `huaweicloud_list_apis` — the product's catalog with tag_groups for narrowing; paginate with search/limit/offset.
3. `huaweicloud_get_api` — the chosen API's full documentation: parameter requiredness/types/enums, x-constraint preconditions, response schema, region endpoint. Read this before any call.
4. `huaweicloud_get_api_examples` — official request examples for parameter construction.

`huaweicloud_list_products` and `huaweicloud_get_product` cover the product dimension (category, is_global — global services use a different auth model).

All discovery tools are read-only, need no credentials, and pass straight through.

## Generic Call Face

`huaweicloud_gateway_list_tools` shows the live gateway tool surface (names, schemas, drift from the devkit projection). `huaweicloud_gateway_call` calls any gateway tool with `tool` + `toolArgs`:

- **Read-only discovery tools** pass through with no approval.
- **State-changing tools** (`execute_api`, `manage_policy` grants, `transform_data`, `query_data`, anything unknown) return an `approvalToken` bound to the exact tool and arguments. Present the tool and arguments to the user, then re-send with `approvalToken` + `approvedByUser: true` and the original unredacted `toolArgs`.
- **Denied outright, no approval path**: secret reads (`ShowSecretVersion`-class operations), `manage_policy` permanent grants (permanent rules are an operator gesture, not an agent action — ask the operator to edit the policy file, which hot-reloads; the refusal envelope carries its path), `manage_policy remove` with a scope, file writes into devkit state.

Denial envelopes carry the fix in their text. A policy refusal names the exact grant line and scope options. A conflict refusal names the conflicting rule and the remove path. Read the error before re-planning.

## execute_api Approval Modes

`HUAWEICLOUD_OPENMCP_APPROVAL` selects the consent authority:

- **devkit** (default): every execute passes the token gate above; the bridge grants exactly the approved product:api for one call.
- **native**: `execute_api` delegates to the gateway's own policy engine. Policy grants still require a token (`manage_policy add/remove` are token-gated in both modes), but an already-granted API executes without per-call tokens. Scope labels translated: once/session/temporary grants live for this server process, shared across its HTTP sessions.

## Traps

| Trap                         | Why                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `region` mismatch            | `get_api`/`get_api_examples` default to cn-north-4. Pass the region you will execute in; endpoints differ per region.                                                                                                                                                                                                                                         |
| project-scoped APIs          | APIs with `{project_id}` in the path need the target region's project_id supplied in params on cross-region calls.                                                                                                                                                                                                                                            |
| params layout                | For `execute_api`, path and query parameters flatten into `toolArgs.params`; the request body goes in `toolArgs.params.body`. Discovery tools take top-level named args (`toolArgs.query`, `toolArgs.limit`, ...). Top-level keys outside a gateway tool's signature are dropped silently — required path params then fail only AFTER the approval was spent. |
| Read the x-constraint        | `get_api`'s x-constraint fields describe call preconditions (quota, dependency, state). Skipping them is the usual cause of a first-call failure.                                                                                                                                                                                                             |
| Data tools are not read-only | `query_data`/`transform_data` cost an approval each call; they read and write local files under the same consent rules.                                                                                                                                                                                                                                       |

## Cross-Skill References

- **API signing by hand**: See `huaweicloud-api-and-sdk` — prefer the gateway tools over manual HMAC signing.
- **CLI first when it covers the operation**: See `huaweicloud-cli-and-auth`; `hcloud` is simpler than the API face for the ~70 cataloged services.
