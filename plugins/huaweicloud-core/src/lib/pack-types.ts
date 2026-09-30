import type { z } from 'zod';

import type { ToolArgs, ToolName, CallToolOptions } from '../tools.ts';

// Shared pack vocabulary, hoisted from packs/registry.ts and
// packs/update/tools.ts so every pack imports the same contract types from one
// place. The module's imports stay type-only (the zod import is `import type`,
// used in a typeof query, and importing ToolName/ToolArgs/CallToolOptions from
// tools.ts is a type-only edge, which verbatimModuleSyntax erases — so the
// existing tools.ts → registry → pack value chain gains no runtime cycle).
// PACK_IDS and PACK_BINARIES below are value exports, but they keep the
// module's runtime graph at zero imports on purpose: the installer
// (dist/setup-cli.js, plain tsc output — only dist/mcp-server.js is
// esbuild-bundled with zod inlined) imports this module to validate --packs
// and to read pack-declared binaries in doctor, and must not pull the
// zod-dependent registry chain.
//
// Consumers:
//   - src/packs/registry.ts        (Pack, PackId)
//   - src/packs/<id>/pack.ts       (Pack, PACK_BINARIES)
//   - src/packs/<id>/tools.ts      (PackToolDefinition, LooseToolSchema)
//   - src/tool-schemas.ts          (LooseToolSchema, re-exported for callers)
//   - src/setup-cli.ts             (PACK_IDS, PACK_BINARIES — installer side)

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

// The canonical pack id list. PackId derives from it, so the list and the
// union cannot drift apart; the registry's PACKS ids are pinned to this list
// by test/structure.test.ts, which keeps the installer's --packs validation
// honest against the registry truth.
// 'services' carries the twenty service skills with zero tools: a pack may
// own knowledge (skills) without owning callable surface, and the meta tools
// that disclose it (list_packs / pack_info / retrieve_skill) stay in core so
// an enabled pack can always be discovered.
export const PACK_IDS = ['core', 'services', 'sandbox', 'auth', 'obs', 'voucher', 'update', 'discovery'] as const;
export type PackId = (typeof PACK_IDS)[number];

// A binary a pack depends on. `scope` selects where it must exist: 'host'
// binaries run on the user's machine and are checked by doctor; 'sandbox'
// binaries live inside the cloud sandbox, where a host-side probe would
// target the wrong machine, so doctor leaves them alone. `versionFlag` is
// the argument that makes the binary print a version ('--version', or
// 'version' when the binary uses a subcommand).
export interface PackBinary {
  name: string;
  scope: 'host' | 'sandbox';
  versionFlag: string;
}

// Pack-declared binaries, keyed by pack id. The table lives here rather than
// inside the pack manifests (next to their zod-heavy tool tables) so the
// installer's doctor can read it without importing the registry chain; each
// pack manifest references its own entry, so the declaration stays attributed
// to the pack and a future entry takes effect in doctor immediately.
export const PACK_BINARIES = {
  // devbridge ships inside the cloud sandbox and reports its version via the
  // `version` subcommand, so it is declared sandbox-scoped: doctor's
  // host-side probe must not check it.
  sandbox: [{ name: 'devbridge', scope: 'sandbox', versionFlag: 'version' }],
} as const satisfies Readonly<Partial<Record<PackId, readonly PackBinary[]>>>;

export interface Pack {
  id: PackId;
  title: string;
  description: string;
  /** skills/ directory names this pack ships. */
  skills: string[];
  tools: ToolName[];
  /** Binaries this pack depends on; absent = none declared. */
  readonly binaries?: readonly PackBinary[];
}
