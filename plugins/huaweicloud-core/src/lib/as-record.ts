// Collapse an unknown parsed value to a record shape, arrays and null
// included, so follow-up property reads never throw. The canonical home for
// the whole src tree — the consolidation is complete (every byte-identical
// private copy migrated, including the hdkit clients, auth, the vault
// store, and the packs). lib/opencode-permission-seam.ts keeps its own
// isRecord type predicate (a guard, not a collapse) and imports this for
// the collapse itself.
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
