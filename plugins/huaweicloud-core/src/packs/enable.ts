import { PACK_IDS, type PackId } from '../lib/pack-types.ts';
import { parseDevkitPacks } from '../lib/dependency-model.ts';

// Pack enablement, resolved from the DEVKIT_PACKS environment variable.
//
// Resolution: DEVKIT_PACKS > every pack enabled. The variable holds a
// comma-separated pack id list ("sandbox,auth"); items are trimmed and empty
// items are dropped. An unset or blank value keeps the full default surface.
// Unknown ids throw immediately (boot fail-fast): a typo'd id must not
// silently shrink the tool surface. The parse and closure now delegate to
// src/lib/dependency-model.ts, the zod-free shared vocabulary, so doctor and
// the boot path share one parse + closure instead of doctor hand-rolling its
// own core force-include.
//
// core is force-included either way, and the rationale is disclosure: the
// pack meta tools (huaweicloud_list_packs / huaweicloud_pack_info) stay in
// core, so no trimming can hide what was disabled. Trimming the
// huaweicloud-cli pack removes the CLI execution face and its approval
// tools together. The open-mcp gateway face no longer carries devkit-side
// approval: authorization is delegated to the gateway's own policy engine
// (an empty policy file denies every execute_api, probed 2026-10-10), so a
// DEVKIT_PACKS=core,huaweicloud-open-mcp configuration keeps gateway writes
// whose control plane is the operator's policy file, and the devkit-side
// floors (secret operations, protected tree, manage_policy shape) load with
// the pack. Trimming is disclosure-level either way: a trimmed pack's
// handlers stay dispatchable through callTool. The PreToolUse hook keeps
// denying raw Bash writes regardless; it never reads pack state. Listing
// core explicitly is redundant but harmless; an env that omits core gets
// it silently — the disclosure surface is not configurable away.
//
// This file sits at the src/packs/ root next to registry.ts: both are
// composition files that only core modules (tools.ts, mcp-protocol.ts)
// import, so the pack boundary guard needs no whitelist entry — a pack
// module importing ../enable.ts is already rejected as a pseudo-sibling
// (scripts/lib/pack-boundaries.mjs treats any src/packs/<other> target as
// off limits).

const VALID_IDS: readonly string[] = PACK_IDS;

// The simplest shape wins: callers consume the set directly, so no wrapper
// interface is exported. Pure function — env in, set out, no process state.
// The parse and closure live in lib/dependency-model.ts; this file keeps only
// the boot-boundary policy: unknown ids throw fail-fast with the valid list.
export function resolveEnabledPacks(env: NodeJS.ProcessEnv = process.env): ReadonlySet<PackId> {
  const raw = (env.DEVKIT_PACKS ?? '').trim();
  if (!raw) return new Set(PACK_IDS);
  const { unknown, enabled } = parseDevkitPacks(raw);
  if (unknown.length > 0) {
    throw new Error(
      `DEVKIT_PACKS contains unknown pack id(s): ${unknown.join(', ')}. Valid pack ids: ${VALID_IDS.join(', ')}.`,
    );
  }
  return enabled;
}
