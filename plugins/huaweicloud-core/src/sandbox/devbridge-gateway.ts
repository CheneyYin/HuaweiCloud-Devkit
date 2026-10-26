// The DevBridge s2 gateway's wire contract, extracted from session-manager so
// the tunnel-domain and gateway-error vocabulary has one canonical home in the
// sandbox family: deploy-check.ts splices these into its probe script, and the
// devbridge-tunnel family (devbridge-expose.ts / devbridge-verify.ts) consumes
// them directly (same exported names, same import path).

// Public tunnel URL domain for the DevBridge s2 gateway. The pre-migration Huawei Cloud
// bridge domain was retired in Sep 2026 and now serves a 「服务已迁移」 placeholder page with
// HTTP 200 — never construct tunnel URLs from it. Exported for the devbridge-tunnel
// family (the DevBridge-owned modules keep the single copy).
export const DEVBRIDGE_TUNNEL_DOMAIN = 'devbridge-s2.hwtunnel.com';
// Migration placeholder page marker — a tunnel URL returning this body must be treated as unreachable.
export const DEVBRIDGE_MIGRATION_MARKER = '服务已迁移';
// Gateway-level tunnel error bodies. "tunnel not found" was verified live
// against the s2 gateway (Oct 2026: 404, text/plain, body "tunnel not found\n");
// the other two are the gateway's documented contract:
//   404 "tunnel not found"    — no live host session on the gateway (host process dead or
//                               tunnel deleted); the tunnel RECORD may still exist in `list`
//   404 "port not configured" — the URL's port is not registered on the tunnel
//   502 "bad gateway"         — host session alive, but the registered port has no local service
// A bare status check cannot distinguish these from app-generated 404/502 responses, so the
// checks below match the exact body AND gate on the HTTP status code.
export const DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER = 'tunnel not found';
export const DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER = 'port not configured';
export const DEVBRIDGE_BAD_GATEWAY_MARKER = 'bad gateway';
