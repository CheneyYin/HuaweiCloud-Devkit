// One asRecord for the whole src tree: collapse an unknown parsed value to a
// record shape, arrays and null included, so follow-up property reads never
// throw. Six private copies existed across setup-cli, agent-registration,
// credential-validator, the hdkit api clients, and packs-policy before this
// became a jscpd clone family.
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
