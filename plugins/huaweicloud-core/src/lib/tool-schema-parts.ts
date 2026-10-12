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
