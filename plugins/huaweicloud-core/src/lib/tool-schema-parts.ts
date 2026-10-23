import { z } from 'zod';

// Zod schema building blocks shared between src/tool-schemas.ts (core tools)
// and the per-pack tool modules (src/packs/<id>/tools.ts). They live in lib/
// because a pack cannot value-import them from tool-schemas.ts: tool-schemas
// value-imports each pack's X_TOOL_SCHEMAS spread, so the reverse edge would
// be a fatal ESM cycle. This module imports only zod.

// number | "123" | null | undefined — the exact input space the old
// presence-only validation accepted for NUMERIC_ARG_KEYS fields.
export const numericArg = z.union([z.number(), z.string()]).nullable();

// Free-form object the tool narrows itself (env vars, deploy plans).
export const looseObject = z.record(z.string(), z.unknown());

// The vendor gate parameter, shared by every cloud-facing tool schema.
// Optional in the schema ON PURPOSE: a missing value must pass zod and
// reach callTool's gate, which throws the teaching rejection (SDK-level
// zod rejects happen before callTool and never carry a teaching message;
// a required field would silence the very consent instruction the gate
// exists to deliver). The gate, not the schema, is the enforcement —
// this part only renders the rule where the model reads tool contracts.
// Mirrors the approvedByUser attestation pattern the approval chain
// measured models honor (core-approval-negative green): an explicit
// user-context boolean the model must actively assert, with the
// availability-is-not-consent denial written into the description.
export const vendorConfirmed = z
  .boolean()
  .optional()
  .describe(
    "Vendor gate: true ONLY when the user's request or conversation establishes Huawei Cloud (explicit mention, hcloud/KooCLI artifacts, myhuaweicloud endpoints, Huawei region IDs, or earlier turns). The devkit being installed or this tool being available is NOT confirmation — and neither is service vocabulary: asserting true when the vendor is merely assumed is a FALSE claim about the user's intent. If the vendor is unknown, ask the user which cloud they mean instead of calling.",
  );

export const gitConfig = z.looseObject({
  repo_url: z.string().optional(),
  repo_branch: z.string().optional(),
  repo_name: z.string().optional(),
  target_path: z.string().optional(),
  open_type: z.string().optional(),
});

export const workspaceId = z
  .string()
  .optional()
  .describe(
    'Workspace ID from huaweicloud_sandbox_connect return value. Required - must be passed explicitly when HW_WORKSPACE_ID is not set.',
  );

export const username = z.string().optional().describe('Login username (default: root)');
