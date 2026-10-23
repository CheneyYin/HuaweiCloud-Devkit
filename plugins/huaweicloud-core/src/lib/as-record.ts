// Collapse an unknown parsed value to a record shape, arrays and null
// included, so follow-up property reads never throw. The canonical home for
// the setup-cli graph (setup-cli, agent-registration, packs-policy migrated);
// ~15 private copies remain elsewhere (auth/credentials, the hdkit clients'
// siblings, secret-vault, risk-rule-engine, ...) as baselined legacy —
// migrate them here when touched (a one-line import + delete).
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
