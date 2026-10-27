import { DEFAULT_POLICY } from './default-policy.ts';

// The secret-read vocabulary for the TEXT faces (joined args, raw text,
// quote-stripped shadow) is DERIVED from policy.blockedSecretOperations —
// the same source the py hook compiles SECRET_READ_RE from — so the layers
// share one vocabulary by construction instead of by editing discipline.
// Only entries that are a prefix of another entry (ShowSecret is a stem of
// ShowSecretVersion) get boundary guards: the stem must not substring-match
// longer operations or stem-containing resource names (ShowSecretsConfig,
// showsecret-demo), while self-specific entries keep substring semantics so
// quote-mangled shadows (download'secret') stay denied in both layers.
// Empty-string entries are dropped; an empty list yields a NEVER-MATCHING
// pattern so an absent/emptied field degrades like the py layer (which
// skips the gate entirely) instead of matching everything.
export function deriveSecretOperationAlternation(ops: readonly string[]): string {
  const entries = ops.filter((op) => op !== '');
  if (entries.length === 0) return '(?!)';
  return entries
    .map((op) => {
      const l = op.toLowerCase();
      // Identity compares the ORIGINAL strings (matching the py closure)
      // so case-variant duplicate entries cannot silently change guard
      // semantics in one layer only.
      const isStem = entries.some((other) => other !== op && other.toLowerCase().startsWith(l));
      const escaped = l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return isStem ? `(?<![A-Za-z0-9._/-])${escaped}(?![A-Za-z0-9._/-])` : escaped;
    })
    .join('|');
}

const SECRET_OP_ALTERNATION = deriveSecretOperationAlternation(DEFAULT_POLICY.blockedSecretOperations);
// Joined-args face: static value-shape extras plus the derived entries.
export const SECRET_ARGS_RE = new RegExp(`secret[_-]?string|secret[_-]?binary|${SECRET_OP_ALTERNATION}`, 'i');
// Raw-text face: derived entries plus the static value-shape extras.
export const SECRET_TEXT_RE = new RegExp(`${SECRET_OP_ALTERNATION}|secret_string|secret_binary`, 'i');
// Shadow face: derived entries only — the py layer has no secret_string
// vocabulary, so carrying the static extras here would split the layers.
export const SECRET_SHADOW_RE = new RegExp(SECRET_OP_ALTERNATION, 'i');
