// The STS expiry derivation, extracted from the credentials monolith (the
// stable src/auth/credentials.ts face re-exports parseStsExpiry): how a
// temporary credential set's expiry is read from env or decoded from the
// security token.
import { asText } from '../lib/as-text.ts';

export interface StsExpiryInput {
  securityToken?: unknown;
  expiresAtEnv?: unknown;
}

// Derive the expiry (epoch ms) of a temporary STS credential set.
// Priority: 1) HW_STS_EXPIRES_AT env (ISO8601 or epoch seconds); 2) decode the
// security token (JWT payload or bare URL-safe base64 JSON) reading common
// expiry fields (exp, timeout_at, expires_at, id_expires_at; issued_at+duration).
// Returns null when unknown/unparseable. Never throws.
export function parseStsExpiry({ securityToken, expiresAtEnv = process.env.HW_STS_EXPIRES_AT }: StsExpiryInput = {}):
  number | null {
  if (expiresAtEnv) {
    const v = asText(expiresAtEnv).trim();
    if (!v) return null;
    const asNum = Number(v);
    if (Number.isFinite(asNum) && asNum > 0) return asNum > 1e12 ? asNum : asNum * 1000;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
    return null;
  }
  if (!securityToken || typeof securityToken !== 'string') return null;
  const token = String(securityToken).trim();
  if (!token) return null;

  const payload: unknown = ((): unknown => {
    try {
      if (token.includes('.')) {
        const parts = token.split('.');
        const b64 = parts.length >= 2 ? parts[1] : null;
        if (!b64) return null;
        const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        return JSON.parse(Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      }
      const pad = token + '='.repeat((4 - (token.length % 4)) % 4);
      return JSON.parse(Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    } catch {
      return null;
    }
  })();
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const exp = Number(record.exp ?? record.expires_at ?? record.timeout_at ?? Number.NaN);
  if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  const issued = Number(record.issued_at ?? record.iat ?? Number.NaN);
  const duration = Number(record.duration ?? record.expires_in ?? record.lifetime ?? Number.NaN);
  if (Number.isFinite(issued) && issued > 0 && Number.isFinite(duration) && duration > 0) {
    return (issued + duration) * 1000;
  }
  return null;
}
