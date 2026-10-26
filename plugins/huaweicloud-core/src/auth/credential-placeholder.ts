// The R11 placeholder/masked-value policy for credential-shaped input,
// extracted from the credentials monolith (the stable src/auth/credentials.ts
// face re-exports isPlaceholder): template text a vendor/IDE marketplace
// pre-fills must never count as a configured credential, in any store.

// R11: Placeholder / masked credential values are treated as "not configured".
// A vendor/IDE marketplace that pre-fills mcp_settings env with template text
// (e.g. "<HW_ACCESS_KEY>" or "${SECRET_KEY}") must not shadow the user's real
// S1 vault. Real AK/SK are >=20 char alphanumeric strings, so none of the
// template/masked patterns below can match a genuine credential.
export function isPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  // <HW_ACCESS_KEY> / <your-ak> / <...>
  if (/^<[^>]*>$/.test(value)) return true;
  // ${HW_ACCESS_KEY}
  if (/^\$\{[^}]*\}$/.test(value)) return true;
  // YOUR_AK / ACCESS_KEY / SECRET_KEY / SECURITY_TOKEN / REGION (bare keyword)
  if (/^(YOUR_)?(AK|SK|ACCESS[_-]?KEY|SECRET[_-]?KEY|TOKEN|SECURITY[_-]?TOKEN|REGION)$/i.test(value)) return true;
  // placeholder / replace_me / change.me
  if (/\b(placeholder|replace[._-]?me|change[._-]?me)\b/i.test(value)) return true;
  // masked value: short alnum prefix + asterisk run (abc**** / token****) — the
  // S4 mirror writes the SK slot this way so the secret never lands in plaintext.
  if (/^[A-Za-z0-9]{3,8}\*+$/.test(value)) return true;
  // bare asterisks
  if (/^\*+$/.test(value)) return true;
  return false;
}

// Type guard so callers can narrow an untrusted value to a real, non-placeholder
// string and keep string plumbing later.
//
// Consumed by the CodeArts reader and the credential resolver; not part of
// the face's public surface.
export function present(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !isPlaceholder(v);
}
