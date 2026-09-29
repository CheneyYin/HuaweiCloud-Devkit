import type { PackId } from '../lib/pack-types.ts';
import { PACKS } from './registry.ts';

// Pack enablement, resolved from the DEVKIT_PACKS environment variable.
//
// Resolution: DEVKIT_PACKS > every pack enabled. The variable holds a
// comma-separated pack id list ("sandbox,auth"); items are trimmed and empty
// items are dropped. An unset or blank value keeps the full default surface.
// Unknown ids throw immediately (boot fail-fast): a typo'd id must not
// silently shrink the tool surface.
//
// core is force-included either way. The approval chain
// (huaweicloud_run_approved_command) and the pack meta disclosure tools
// (huaweicloud_list_packs / huaweicloud_pack_info) live in core; trimming
// them would leave an agent that can execute writes without a reviewable
// approval path or disclose neither what it runs nor what was disabled.
// Listing core explicitly is redundant but harmless; an env that omits core
// gets it silently — the safety boundary is not configurable away.
//
// This file sits at the src/packs/ root next to registry.ts: both are
// composition files that only core modules (tools.ts, mcp-protocol.ts)
// import, so the pack boundary guard needs no whitelist entry — a pack
// module importing ../enable.ts is already rejected as a pseudo-sibling
// (scripts/lib/pack-boundaries.mjs treats any src/packs/<other> target as
// off limits).

const VALID_IDS: readonly string[] = PACKS.map((pack) => pack.id);
const VALID_ID_SET = new Set<string>(VALID_IDS);

// The simplest shape wins: callers consume the set directly, so no wrapper
// interface is exported. Pure function — env in, set out, no process state.
export function resolveEnabledPacks(env: NodeJS.ProcessEnv = process.env): ReadonlySet<PackId> {
  const raw = (env.DEVKIT_PACKS ?? '').trim();
  if (!raw) return new Set(PACKS.map((pack) => pack.id));
  const requested = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const unknown = requested.filter((id) => !VALID_ID_SET.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `DEVKIT_PACKS contains unknown pack id(s): ${unknown.join(', ')}. Valid pack ids: ${VALID_IDS.join(', ')}.`,
    );
  }
  return new Set(PACKS.filter((pack) => pack.id === 'core' || requested.includes(pack.id)).map((pack) => pack.id));
}
