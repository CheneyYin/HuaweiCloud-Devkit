# Plan-Run Approval Contract

## Overview

The `planHcloudCommand` → `runApprovedCommand` workflow uses a **token-based approval** mechanism instead of string comparison. This eliminates mismatches caused by shell quoting, JSON escaping, credential redaction, and special character handling.

## Contract

### 1. `planHcloudCommand(args)` → `{ approvalToken, args, command, ... }`

The plan step returns an `approvalToken` alongside the display information. The token is a random UUID that links the plan to a stored args array.

```
plan → { approvalToken: "uuid-xxx", command: "...", args: [...], ... }
```

### 2. Agent presents the plan to the user and collects approval

The agent may show `command` to the user for review. The agent MUST NOT attempt to construct or modify the args array.

### 3. `runApprovedCommand({ approvalToken, args, approvedByUser })` → result

The run step validates:

1. `approvedByUser === true`
2. `approvalToken` is valid and not expired (5 minute TTL)
3. `args` JSON-serialized form matches the stored args from plan

If all checks pass, the stored args are used to execute `runHcloud`.

## Implementation

### Token Storage

Tokens are persisted to a per-user file (`~/.config/huaweicloud-devkit/approvals.json`, mode 0600) so plan and run survive the process boundary (in-memory storage lost tokens across MCP sessions, issue #578). Only the sha256 of the canonical args plus the redacted form are stored, never the raw args.

- Token is a UUID
- Tokens are single-use (exclusive-create claim marker next to the store)
- Tokens expire after 5 minutes
- Stale entries and markers are pruned on every mint and consume

### Key Functions

| Function                       | Location                             | Purpose                                      |
| ------------------------------ | ------------------------------------ | -------------------------------------------- |
| `createApprovalToken(rawArgs)` | `lib/approval-tokens.ts`             | Stores hash + redacted args, returns token   |
| `consumeApprovalToken(token)`  | `lib/approval-tokens.ts`             | Validates, claims single-use, deletes entry  |
| `planHcloudCommand()`          | `src/hcloud-cli.ts`                  | Returns `approvalToken` in result            |
| `runApprovedCommand()`         | `src/packs/huaweicloud-cli/tools.ts` | Validates token, executes with provided args |

## Why Token Instead of String Comparison

Previous design compared `approvedCommand` string with `plan.command` string. This failed when:

1. Secrets were redacted (`<redacted>` ≠ real value)
2. JSON parameters had different escaping (`\"` vs `"`)
3. Shell quoting changed between plan and run context

Token-based approval eliminates the string round-trip entirely. Args stay in their original structured format from plan to execution.

## Anti-Patterns

❌ Do NOT add new `--key=<redacted>` normalization rules to the comparison logic.

❌ Do NOT attempt to match `approvedCommand` string against `plan.command`.

❌ Do NOT store approval tokens in files or external storage. In-memory Map is sufficient.

## Migration

New tools using this pattern should follow the same contract:

1. Planning function returns `approvalToken`
2. Execution function accepts `approvalToken` and validates via `consumeApprovalToken`
