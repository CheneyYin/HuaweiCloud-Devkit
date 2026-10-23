import { existsSync, readFileSync } from 'node:fs';

import { asRecord } from './lib/as-record.ts';
import { PACK_IDS } from './lib/pack-types.ts';

// The --packs install-time selection policy: how DEVKIT_PACKS is resolved
// from the CLI flag, computed per config entry, and carried into wholesale
// config rewrites. The officeace sqlite reader stays with the officeace
// adapter family (it is registry I/O, not policy).

// --- Install-time pack selection (--packs) ---------------------------------
//
// DEVKIT_PACKS selects the pack surface at server boot (src/packs/enable.ts).
// The installer writes it into each target's MCP config env layer — the same
// layer HUAWEICLOUD_AGENT_TOOLKIT_MODE already occupies — and the agent
// harness injects it into the server process. The registry itself is not
// importable here (its chain is zod-bundled into dist/mcp-server.js only),
// so the id list comes from the zod-free PACK_IDS vocabulary in
// lib/pack-types.ts, pinned to the registry by test/structure.test.ts.
//
// Flag semantics:
//   --packs <ids>  write DEVKIT_PACKS=<ids> unless the config already carries
//                  a value; a differing user-set value wins with a warning
//                  (the mergeEnv contract, issue #615)
//   --packs all    remove the DEVKIT_PACKS key (restore full enablement)
//   (no flag)      never write or remove the key

type PacksFlag = { kind: 'unset' } | { kind: 'all' } | { kind: 'ids'; value: string };

// The packs command family's id validation shares the same vocabulary set.
export const PACK_ID_SET = new Set<string>(PACK_IDS);

let packsFlagCache: PacksFlag | undefined;

// Parse and validate --packs once per process; bogus input exits non-zero on
// stderr with the unknown id(s) and the valid id list, mirroring --target.
// Call before any file is copied so a typo cannot half-install.
export function resolvePacksFlag(): PacksFlag {
  if (packsFlagCache) return packsFlagCache;
  const idx = process.argv.indexOf('--packs');
  let result: PacksFlag = { kind: 'unset' };
  if (idx >= 0) {
    const raw = process.argv[idx + 1];
    if (raw === undefined || raw === '' || raw.startsWith('--')) {
      console.error('Missing value for --packs (expected a comma-separated pack id list or "all")');
      console.error(`Valid pack ids: ${PACK_IDS.join(', ')} (or "all")`);
      process.exit(1);
    }
    if (raw.trim().toLowerCase() === 'all') {
      result = { kind: 'all' };
    } else {
      const ids = raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      const bogus = ids.filter((id) => !PACK_ID_SET.has(id));
      if (bogus.length > 0) {
        console.error(`Unknown pack id(s): ${bogus.join(', ')}`);
        console.error(`Valid pack ids: ${PACK_IDS.join(', ')} (or "all")`);
        process.exit(1);
      }
      result = { kind: 'ids', value: ids.join(',') };
    }
  }
  packsFlagCache = result;
  return result;
}

// The DEVKIT_PACKS value a config should carry after this run, given its
// current value. keptUserValue marks the case where a user-set value won.
export function packsWriteValue(current: string | null): {
  next: string | null;
  keptUserValue: boolean;
  requested: string;
} {
  const flag = resolvePacksFlag();
  if (flag.kind === 'unset') return { next: current, keptUserValue: false, requested: '' };
  if (flag.kind === 'all') return { next: null, keptUserValue: false, requested: 'all' };
  if (current !== null && current !== flag.value) {
    return { next: current, keptUserValue: true, requested: flag.value };
  }
  return { next: flag.value, keptUserValue: false, requested: flag.value };
}

export function warnPacksUserValueKept(label: string, current: string, requested: string): void {
  console.log(
    `  \x1b[33m[WARN]\x1b[0m ${label}: config already sets DEVKIT_PACKS="${current}"; keeping it (--packs would set "${requested}"). Run with --packs all to clear it.`,
  );
}

// The env field + current DEVKIT_PACKS value one MCP entry carries — the
// shared read both policy functions derive from, so the entry-shape
// narrowing lives once.
function readPacksEnv(
  entry: unknown,
  envKey: 'env' | 'environment',
): { existingEnv: Record<string, unknown> | null; current: string | null } {
  const rawEnv: unknown = asRecord(entry)[envKey];
  const existingEnv: Record<string, unknown> | null =
    rawEnv !== null && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
      ? (rawEnv as Record<string, unknown>)
      : null;
  const current =
    existingEnv !== null && typeof existingEnv.DEVKIT_PACKS === 'string' ? existingEnv.DEVKIT_PACKS : null;
  return { existingEnv, current };
}

// Apply the packs policy to one merged MCP entry. `envKey` is the env field
// the target's harness reads ('env' for .mcp.json-style entries,
// 'environment' for OpenCode and CodeArts Work). Returns true when the entry
// changed, so callers can fold it into their "unchanged" short-circuit.
// The single warning site: a kept user value warns here, exactly once —
// packsEntryPending is pure and never warns.
export function applyPacksToEntry(entry: Record<string, unknown>, envKey: 'env' | 'environment', label: string): boolean {
  const flag = resolvePacksFlag();
  if (flag.kind === 'unset') return false;
  const { existingEnv, current } = readPacksEnv(entry, envKey);
  const { next, keptUserValue, requested } = packsWriteValue(current);
  if (keptUserValue) {
    warnPacksUserValueKept(label, current ?? '', requested);
    return false;
  }
  if (next === current) return false;
  if (next === null) {
    if (existingEnv === null || !Object.hasOwn(existingEnv, 'DEVKIT_PACKS')) return false;
    delete existingEnv.DEVKIT_PACKS;
    if (Object.keys(existingEnv).length === 0) delete entry[envKey];
    return true;
  }
  entry[envKey] = { ...(existingEnv ?? {}), DEVKIT_PACKS: next };
  return true;
}

// Whether the packs policy would rewrite DEVKIT_PACKS in an entry shaped
// like `existing`, and why not when it would not. For writers whose merge
// path rebuilds the env object from the raw existing entry (CodeArts Work):
// the "unchanged" short-circuit must account for the packs write before
// that rebuild discards it. Pure — the caller decides whether the
// kept-user-value case warrants the warning (the mutating
// applyPacksToEntry owns the warning on apply paths).
export interface PacksEntryStatus {
  pending: boolean;
  keptUserValue: boolean;
  current: string | null;
  requested: string;
}

export function packsEntryPending(entry: unknown, envKey: 'env' | 'environment'): PacksEntryStatus {
  if (resolvePacksFlag().kind === 'unset') {
    return { pending: false, keptUserValue: false, current: null, requested: '' };
  }
  const { current } = readPacksEnv(entry, envKey);
  const { next, keptUserValue, requested } = packsWriteValue(current);
  return { pending: !keptUserValue && next !== current, keptUserValue, current, requested };
}

// For writers that regenerate their config wholesale (YAML blocks, the
// OfficeAce sqlite row): resolve the DEVKIT_PACKS value to carry forward.
export function packsCarryValue(label: string, current: string | null): string | null {
  const { next, keptUserValue, requested } = packsWriteValue(current);
  if (keptUserValue) warnPacksUserValueKept(label, current ?? '', requested);
  return next;
}

// Read the DEVKIT_PACKS value one MCP config entry carries, trying both env
// field spellings agents accept. Null when the file/entry/key is absent.
export function readDevkitPacksFromJson(configPath: string, mapKey: 'mcp' | 'mcpServers'): string | null {
  if (!existsSync(configPath)) return null;
  try {
    const entry = asRecord(
      asRecord(asRecord(JSON.parse(readFileSync(configPath, 'utf8')))[mapKey])['huaweicloud-devkit'],
    );
    for (const envKey of ['environment', 'env']) {
      const value = asRecord(entry[envKey]).DEVKIT_PACKS;
      if (typeof value === 'string') return value;
    }
    return null;
  } catch {
    return null;
  }
}

export function readDevkitPacksFromYaml(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  try {
    const match = readFileSync(configPath, 'utf8').match(/^\s*DEVKIT_PACKS:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
    return match ? match[1]!.trim() : null;
  } catch {
    return null;
  }
}
