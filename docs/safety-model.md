# Safety Model

The toolkit assumes coding agents can accidentally expose secrets or perform expensive/destructive cloud operations. V1 therefore defaults to read-only execution and explicit approval gates.

## Blocked By Default

- Reading `.hcloud` or `.huaweicloud` credential files.
- Printing cloud credential environment variables.
- Calling secret-value APIs that return plaintext secret strings or binary secrets.
- Running write operations such as create, delete, update, resize, start, stop, authorize, revoke, attach, detach, enable, or disable without explicit approval.
- Echoing password-like fields such as `adminPass` back into generated reports or command output without a shell-history warning.

## Enforcement

- `plugins/huaweicloud-core/skills/huaweicloud-safety/SKILL.md` teaches agents when to classify risk.
- `huaweicloud_hook_check_command`, `huaweicloud_hook_check_artifacts`, and `huaweicloud_hook_check_deploy_plan` let MCP-capable agents proactively inspect planned work.
- `plugins/huaweicloud-core/hooks/huaweicloud-safety.mjs` blocks command-stage deny rules for Codex native hooks without requiring Python.
- `plugins/huaweicloud-core/hooks/huaweicloud-safety.py` remains available for Hermes/Python hook compatibility.
- `plugins/huaweicloud-core/src/safety-policy.ts` (compiled to `dist/safety-policy.js`) handles Codex/OpenCode MCP paths and merges existing command safety with public cloud risk rules.
- `plugins/huaweicloud-core/safety/policy.json` stores hard safety vocabulary.
- `plugins/huaweicloud-core/safety/rules/cloud-risk-rules.json` stores generalized cloud risk rules.

## Write Operations

The default write path is planning: `huaweicloud_plan_cli_command` returns a command for review. The optional execution path is `huaweicloud_run_approved_command`, which requires an exact command string already shown to the user plus explicit approval. This is an agent workflow guardrail, not a substitute for IAM least privilege or human review.

## Gateway Face: Delegated Authorization

The open-mcp gateway face (`huaweicloud_gateway_call`) delegates authorization to the gateway's own policy engine. The devkit mints no consent on this face: every routed call forwards, and the engine's refusal reason is the consent instruction (it names the exact `manage_policy` grant shapes the agent may buy after confirming with the user). The CLI face keeps the plan-run token contract above.

Probed 2026-10-10 against huaweicloud-open-mcp v0.2.0a4 (report: `/tmp/opencode/openmcp-probe-report.json`, scratch copy; the probe script mirrors `sidecar.ts` spawn shape):

- An empty policy file makes the engine deny every `execute_api` with a consent-teaching reason. The delegated face is fail-closed out of the box.
- The engine itself accepts `scope=permanent` adds (writing the operator's policy file) and has no secret guard and no policy gate on `query_data`/`transform_data`. Its `ttl_seconds` acceptance with `scope=temporary` is known from the gateway's own error message ("ttl_seconds 仅支持 scope=temporary"), not from the probe — only the session-scope rejection was probed.

The devkit-side floors (`src/packs/huaweicloud-open-mcp/approval.ts`) are the barriers for what the engine does not enforce: secret operations deny outright; the structured `out.path`/`tables.*.path` fields cross the protected-tree check, while other path-like strings (SQL literals included) are denied only when credential-shaped — the residual recorded in the module comment; `manage_policy` accepts only canonical `list`/`add`/`remove` with ephemeral scopes and no `ttl_seconds`.

Accepted risks of the delegation (decision record in `docs/open-mcp-approval-delegation-design.md`):

- An agent can add session-scoped allows and remove operator rules through `manage_policy` (the engine resolves its in-memory overlay before the file layer and its remove is cross-layer).
- Local file reads and writes through `query_data`/`transform_data` outside the protected tree and credential patterns are un-gated.
- A malformed operator policy file is silently inert gateway-side (the engine keeps its last valid version).

`HUAWEICLOUD_OPENMCP_APPROVAL` is retired; setting it surfaces a tool error pointing at the operator policy file, which hot-reloads.

## Non-Goals

This is not a hard security boundary. Users still need IAM least privilege, audit logs, secure local credential storage, and review of generated commands or code.
