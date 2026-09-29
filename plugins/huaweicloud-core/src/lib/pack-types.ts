import type { z } from 'zod';

import type { ToolArgs, ToolName, CallToolOptions } from '../tools.ts';

// Shared pack vocabulary, hoisted from packs/registry.ts and
// packs/update/tools.ts so every pack imports the same contract types from one
// place. The module stays type-only: the zod import is `import type` (used in
// a typeof query), and importing ToolName/ToolArgs/CallToolOptions from
// tools.ts is a type-only edge, which verbatimModuleSyntax erases — so the
// existing tools.ts → registry → pack value chain gains no runtime cycle.
//
// Consumers:
//   - src/packs/registry.ts        (Pack, PackId)
//   - src/packs/<id>/pack.ts       (Pack)
//   - src/packs/<id>/tools.ts      (PackToolDefinition, LooseToolSchema)
//   - src/tool-schemas.ts          (LooseToolSchema, re-exported for callers)

// The runtime class behind z.looseObject (constructor name ZodObject): a
// constructed passthrough object schema. Named once so registry entries,
// accessor signatures, and the runtime guard all share it.
export type LooseToolSchema = ReturnType<typeof z.looseObject<Record<string, unknown>>>;

// One pack tool wires its four registration facts in a single place: identity
// (name/description), the zod input schema, and the callTool handler. The
// satisfies check on each pack's X_TOOLS turns a missing element into a
// compile error, so a pack entry can never ship half-wired.
export interface PackToolDefinition {
  name: ToolName;
  description: string;
  schema: LooseToolSchema;
  handler: (_args: ToolArgs, _opts: CallToolOptions) => Promise<unknown>;
}

export type PackId = 'core' | 'sandbox' | 'auth' | 'obs' | 'voucher' | 'update' | 'discovery';

export interface Pack {
  id: PackId;
  title: string;
  description: string;
  /** skills/ directory names this pack ships. */
  skills: string[];
  tools: ToolName[];
}
