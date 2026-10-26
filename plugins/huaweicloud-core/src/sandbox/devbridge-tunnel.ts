import {
  DEVBRIDGE_BAD_GATEWAY_MARKER,
  DEVBRIDGE_MIGRATION_MARKER,
  DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER,
  DEVBRIDGE_TUNNEL_DOMAIN,
  DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER,
  stripTerminalEscapes,
} from './session-manager.ts';
import { asText } from '../lib/as-text.ts';
import {
  DEVBRIDGE_HOST_EXPIRY_HOURS,
  DEVBRIDGE_RENEW_HOURS,
  evaluateDevbridgeVersion,
  validateExpiryHours,
  validateTunnelId,
  validateTunnelPort,
} from './devbridge-validation.ts';
import { runOneShot, type OneShotResult } from './devbridge-exec.ts';
import { buildDevbridgeAuthProbe, parseDevbridgeAuthOutput } from './devbridge-auth.ts';

// The tunnel parameter policy (validators, lifetime constants, the 0.1.x
// version gate) lives in devbridge-validation.ts; re-exported as the public
// face (packs/sandbox/tools.ts and the tests import these names here).
export {
  DEVBRIDGE_HOST_EXPIRY_HOURS,
  DEVBRIDGE_MAX_EXPIRY_HOURS,
  DEVBRIDGE_RENEW_HOURS,
  evaluateDevbridgeVersion,
  validateExpiryHours,
  validateTunnelId,
  validateTunnelPort,
} from './devbridge-validation.ts';
export type { DevbridgeVersionVerdict } from './devbridge-validation.ts';
// The one-shot exec seam lives in devbridge-exec.ts; re-exported as the public
// face (the test harness imports _setOneShotForTests here).
export { _setOneShotForTests } from './devbridge-exec.ts';
// The DevBridge auth waterfall (probe script + stdout parser) lives in
// devbridge-auth.ts; re-exported as the public face.
export { buildDevbridgeAuthProbe, parseDevbridgeAuthOutput } from './devbridge-auth.ts';
export type { DevbridgeAuth } from './devbridge-auth.ts';

// The DevBridge expose-tunnel flow, extracted from session-manager so the
// tunnel helpers stay a cohesive unit with a pure-function test surface.
// Ported from main's v1.1.8/v1.1.9 session-manager.mjs with two deliberate v2
// deviations (adversarial-review rulings): a final attempt with no usable
// URL returns ok:false instead of ok:true-with-dead-URL, and loginOutput
// is truncated like hostLog (defense-in-depth on diagnostics). A third v2
// ordering deviation: the #919 fresh-session re-verify runs only on the
// usable-URL path — a dead URL already fails above it, so no extra exec is
// spent proving a failure. Ruling on the gateway-error family (documented so
// a future port does not "fix" it): after retry exhaustion, the 404 forms
// ("tunnel not found" / "port not configured") and the migration placeholder
// return ok:false (the gateway itself reports the URL dead), while 502 "bad
// gateway" deliberately returns ok:true-with-warning — the tunnel IS alive,
// the local service is not; the developer needs the URL to debug the service.

export interface ExposeTunnelResult {
  ok: boolean;
  publicUrl?: string;
  port: number;
  tunnelId?: string;
  authMode: string;
  httpCode?: string;
  verifyHttpCode?: string;
  verifyNotFound?: boolean;
  persistent?: boolean;
  expiresAt?: string;
  expiresInHours?: number;
  warnings?: string;
  hostLog?: string;
  error?: string;
  error_code?: string;
  version?: string;
  remediation?: string;
  keepalive?: {
    enrolled: boolean;
    tunnelCount: number | undefined;
    watchdogPid: string | undefined;
    logPath: string | undefined;
    error: string | undefined;
  };
  attempts?: Record<string, string>;
  hint?: string;
  loginOutput?: string;
}

// Start (or replace) a devbridge host bound to a single port, extract the public
// URL, and health-check it. Mirrors the huaweicloud-sandbox skill's Expose flow:
// pre-clean stale tunnels (quota 10006), start host in background, read the
// port-anchored "Tunnel URL: ..." from /tmp/host.log, curl-check, retry once on
// unreachable.
// The host MUST survive the exec session that started it (#919): setsid detaches
// it from the session's process group, `< /dev/null` drops the controlling tty
// stdin, and `disown` removes it from the shell's job table — without all three
// the host is reaped when the one-shot session ends and the tunnel dies
// immediately after a green in-session health check (the "假成功" bug).
export function buildDevbridgeExposeScript(port: number, expiryHours: number = DEVBRIDGE_HOST_EXPIRY_HOURS): string {
  const hostLog = '/tmp/host.log';
  // Port-anchored URL extraction: a multi-port host prints one "Tunnel URL:" line per
  // port, so a port-blind `sed | tail -1` can pick another port's URL. The pattern is
  // derived from the shared domain constant, never hardcoded.
  const domainLiteral = DEVBRIDGE_TUNNEL_DOMAIN.replace(/\./g, '\\.');
  return [
    // #999: the export rides the same first line as the pkill so the fake's
    // first-line recognizer (and any reader) sees one stable anchor — the
    // one-shot exec shell does NOT inherit the auth probe's PATH, and after
    // the Layer-3 install + dedup (or a reboot) the only surviving binary
    // lives at /workspace/.local/bin.
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; pkill -f "devbridge host" 2>/dev/null || true`,
    `sleep 2`,
    `devbridge delete-all > /dev/null 2>&1 || true`,
    // #922 (S8): setsid is unavailable on some sandbox images — fall back to a
    // bare nohup launch so the host still starts; persistence is then judged by
    // the independent re-verify in exposeTunnel, which emits the 请勿分享 warning
    // in the non-persistent case. disown is guarded: shells without the builtin
    // must not abort the script.
    `if command -v setsid > /dev/null 2>&1; then setsid nohup devbridge host -p ${port} -e ${expiryHours} > ${hostLog} 2>&1 < /dev/null & else nohup devbridge host -p ${port} -e ${expiryHours} > ${hostLog} 2>&1 < /dev/null & fi`,
    `disown 2>/dev/null || true`,
    // A2 (#935), v2-hardened: bounded URL-extraction retry instead of a flat
    // settle sleep — the host logs "Tunnel URL:" at its own pace (v2's old
    // 12s flat window existed for slow host logs), so re-grep up to 4 times
    // with 3s gaps (0/3/6/9s, early exit) before concluding the host never
    // logged a URL. Main's A2 uses a flat sleep 6 + single grep, which halves
    // the window v2 tuned for slow hosts — deliberate divergence, recorded.
    `TUNNEL_URL=""`,
    `for i in 1 2 3 4; do`,
    `  TUNNEL_URL=$(grep -oE "https://[A-Za-z0-9_-]+-${port}\\.${domainLiteral}" ${hostLog} | head -1)`,
    `  [ -n "$TUNNEL_URL" ] && break`,
    `  sleep 3`,
    `done`,
    // A2 (#935): probe with retries + backoff — 502/000 before the gateway is
    // ready is not a failure; the LAST probe decides reachability. Every probe
    // that receives an HTTP response rewrites the body file; a transport-failed
    // final probe leaves the previous body (inert — body verdicts are
    // status-gated on 404/502, never 000).
    // No `|| echo "000"`: curl's -w already prints 000 on transport-level
    // failure (DNS/refused/timeout) and exits non-zero, so `|| echo` appends a
    // second 000 to the captured output — a value no '000' sentinel check ever
    // equals. Early curl exits leave the field '' or '000' — both are handled
    // as unreachable.
    `HTTP_CODE="000"`,
    `if [ -n "$TUNNEL_URL" ]; then`,
    `  for i in 1 2 3 4; do`,
    // #1000: --noproxy — the sandbox injects an HTTP proxy that does NOT route
    // the tunnel domain; without it the probe returns 502/404 fakes and a
    // working tunnel is judged dead.
    `    HTTP_CODE=$(curl -s --noproxy '*' -o /tmp/.db_probe_body -w "%{http_code}" --max-time 10 "$TUNNEL_URL" 2>/dev/null)`,
    `    echo "DB_PROBE_$i=$HTTP_CODE"`,
    `    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "304" ]; then break; fi`,
    `    if [ "$i" != "4" ]; then sleep 5; fi`,
    `  done`,
    `fi`,
    `echo "DB_HOST_LOG="`,
    `tail -n 5 ${hostLog}`,
    `echo "DB_TUNNEL_URL=$TUNNEL_URL"`,
    `echo "DB_HTTP_CODE=$HTTP_CODE"`,
    `echo "DB_EXPIRY_HOURS=${expiryHours}"`,
    // First 64 bytes of the probe body (non-sensitive, newlines stripped so an
    // app body can never line-inject later DB_ verdict fields) — feeds the
    // exact gateway-error body matching.
    `echo "DB_TUNNEL_BODY=$(head -c 64 /tmp/.db_probe_body 2>/dev/null | tr -d '\\r\\n')"`,
    `rm -f /tmp/.db_probe_body`,
    // grep -c prints its 0 count itself on no-match (exit 1); `|| true` keeps
    // that stdout. A missing log leaves '' → parsed as no quota error. (The old
    // `|| echo 0` doubled the output: a stray second 0 line.)
    `echo "DB_QUOTA_ERROR=$(grep -c '10006' ${hostLog} 2>/dev/null || true)"`,
    // Migration-marker scan scoped to the HOST LOG ONLY (devbridge's own
    // output): the probe body is now echoed (DB_TUNNEL_BODY) for the
    // gateway-error classification, and an app page legitimately containing
    // the marker in its first bytes must not be misdiagnosed as a retired
    // pre-migration gateway placeholder.
    `echo "DB_MIGRATION=$(grep -c '${DEVBRIDGE_MIGRATION_MARKER}' ${hostLog} 2>/dev/null || true)"`,
  ].join('\n');
}

// Build the script for the SECOND, independent exec session that re-verifies the
// tunnel with a real GET (#919): the in-session health check inside
// buildDevbridgeExposeScript cannot prove the host survived session teardown —
// a GET from a fresh session can. #922 (B2): the response body is kept and
// checked for the native false-success form — a 200 whose body is "tunnel not
// found" — and the verdict is emitted as DB_VERIFY_NOT_FOUND so
// parseDevbridgeVerifyOutput can catch it. The URL is validated (https,
// URL-safe chars only) before being spliced into the shell command.
export function buildDevbridgeVerifyScript(tunnelUrl: string): string {
  const url = String(tunnelUrl || '');
  if (!/^https:\/\/[A-Za-z0-9:._/-]+$/.test(url)) {
    throw new Error(
      `sandbox expose tunnel: invalid tunnel URL ${JSON.stringify(url.slice(0, 80))}. Expected an https:// URL with URL-safe path characters (from the expose script's DB_TUNNEL_URL output).`,
    );
  }
  const bodyFile = '/tmp/devbridge_verify_body';
  return [
    // #1000: --noproxy — the injected proxy does not route the tunnel domain;
    // a proxied verify returns 502/404 fakes (working tunnel judged dead).
    `VERIFY_CODE=$(curl -s --noproxy '*' -o ${bodyFile} -w "%{http_code}" --max-time 10 "${url}" 2>/dev/null)`,
    // Exact whole-content body match (CRLF-tolerant, case-sensitive — the same
    // doctrine as the expose parser's === and deploy_check's probe): an app
    // page that merely MENTIONS the phrase never trips the false-success
    // verdict. tr strips \r/\n so both LF and CRLF gateway forms compare equal.
    // NB: never use grep -q here — command substitution captures stdout, and -q
    // prints none, so the verdict would be stuck at "not found = no" forever.
    `VERIFY_BODY=$(tr -d '\\r\\n' < ${bodyFile} 2>/dev/null)`,
    `if [ "$VERIFY_BODY" = '${DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER}' ]; then VERIFY_NOT_FOUND=1; else VERIFY_NOT_FOUND=0; fi`,
    `rm -f ${bodyFile} 2>/dev/null || true`,
    `echo "DB_VERIFY_HTTP_CODE=$VERIFY_CODE"`,
    `echo "DB_VERIFY_NOT_FOUND=$VERIFY_NOT_FOUND"`,
  ].join('\n');
}

export interface DevbridgeProbe {
  attempt: number;
  httpCode: string;
}

// A2 (#935): parse the probe sequence emitted by buildDevbridgeExposeScript.
// Each probe echo is `DB_PROBE_<n>=<code>`; reachability is decided by the
// LAST probe — intermediate 502/000 probes are gateway-not-ready noise, not
// failures, so they must not leak into the tool's verdict. NB: in production
// the verdict rides the DB_HTTP_CODE field (the loop variable's final value,
// emitted by the script) — finalHttpCode here is a diagnostic/test derivation
// for sequences parsed standalone.
export function parseDevbridgeProbeSequence(stdout: unknown): { probes: DevbridgeProbe[]; finalHttpCode: string } {
  const text = stripTerminalEscapes(stdout);
  const probes: DevbridgeProbe[] = [];
  for (const m of text.matchAll(/^DB_PROBE_(\d+)=(\S*)$/gm)) {
    probes.push({ attempt: Number(m[1]), httpCode: m[2] ?? '' });
  }
  const finalHttpCode = probes.length > 0 ? probes[probes.length - 1]!.httpCode : '';
  return { probes, finalHttpCode };
}

// A2 (#935): the reachability warning must come from the LAST probe's HTTP
// status, not from a single early curl — the old single-shot check warned
// "Tunnel reachable check returned HTTP (expected 200/304)" while the same
// log showed DB_HTTP_CODE=200. 200/304 = no warning; anything else surfaces
// as-is.
export function formatTunnelReachabilityWarning(httpCode: string): string | undefined {
  if (httpCode === '200' || httpCode === '304') return undefined;
  return `Tunnel reachable check returned HTTP ${httpCode || '000'} (expected 200/304). The URL may not be serving yet — the final probe decides.`;
}

export interface DevbridgeExpose {
  tunnelUrl: string;
  httpCode: string;
  quotaError: boolean;
  tunnelId: string;
  expiryHours: number | undefined;
  gatewayTunnelError: boolean;
  badGateway: boolean;
  migration: boolean;
  probes: DevbridgeProbe[];
}

// Anchored `^KEY=value` field reader over stripped multi-line text — the DB_*
// output grammar's single lookup rule, shared by the expose and verify parsers.
function readDbField(text: string, key: string): string {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? (m[1] ?? '').trim() : '';
}

// Parse the raw stdout of buildDevbridgeExposeScript into structured fields.
// `gatewayTunnelError` marks a URL the s2 gateway itself reports as dead
// (404 "tunnel not found" / "port not configured") — it can never serve content
// regardless of the app. `badGateway` (502 "bad gateway") means the tunnel is
// alive but the local service on the exposed port is not serving.
export function parseDevbridgeExposeOutput(stdout: unknown): DevbridgeExpose {
  // #946: strip OSC/CSI escapes + \r BEFORE the anchored ^DB_ lookups — otherwise
  // every field is lost on integration-enabled shells and a perfectly good tunnel
  // comes back as ok:true with publicUrl missing (and pointlessly re-built once).
  const text = stripTerminalEscapes(stdout);
  const tunnelUrl = readDbField(text, 'DB_TUNNEL_URL') || (text.match(/TUNNEL_URL:(https:\/\/[^\s]+)/) ?? [])[1] || '';
  const httpCode = readDbField(text, 'DB_HTTP_CODE');
  const body = readDbField(text, 'DB_TUNNEL_BODY');
  // Field-scoped verdicts (never scan the echoed probe body): quota and
  // migration are host-log facts, computed script-side by grepping the log.
  // Count-robust (`> 0`, not `=== '1'`): grep -c prints a LINE count, and a
  // retrying host can log the marker on several lines.
  const quotaError = Number(readDbField(text, 'DB_QUOTA_ERROR')) > 0;
  const migration = Number(readDbField(text, 'DB_MIGRATION')) > 0;
  const domainPattern = DEVBRIDGE_TUNNEL_DOMAIN.replace(/\./g, '\\.');
  const tunnelId =
    (tunnelUrl.match(new RegExp(`^https:\\/\\/([A-Za-z0-9_-]+)-\\d+\\.${domainPattern}`)) ?? [])[1] ?? '';
  const expiryHours = Number(readDbField(text, 'DB_EXPIRY_HOURS')) || undefined;
  // Exact-body match gated on the status code: an app's own 404/502 page is never misjudged.
  const gatewayTunnelError =
    httpCode === '404' && (body === DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER || body === DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER);
  const badGateway = httpCode === '502' && body === DEVBRIDGE_BAD_GATEWAY_MARKER;
  const { probes } = parseDevbridgeProbeSequence(text);
  return { tunnelUrl, httpCode, quotaError, tunnelId, expiryHours, gatewayTunnelError, badGateway, migration, probes };
}

export interface DevbridgeVerify {
  httpCode: string;
  notFound: boolean;
}

// Parse the raw stdout of buildDevbridgeVerifyScript into structured fields.
// Dedicated parser (#922 B1): the verify script emits DB_VERIFY_HTTP_CODE /
// DB_VERIFY_NOT_FOUND keys — the anchored ^DB_HTTP_CODE= lookup in
// parseDevbridgeExposeOutput never matches them, which used to leave
// verifyHttpCode empty and persistent always false.
export function parseDevbridgeVerifyOutput(stdout: unknown): DevbridgeVerify {
  // #946: strip OSC/CSI escapes + \r — the anchored DB_VERIFY_* lookups are blind
  // to them, leaving verifyHttpCode empty and persistent permanently false.
  const text = stripTerminalEscapes(stdout);
  const httpCode = readDbField(text, 'DB_VERIFY_HTTP_CODE');
  const notFoundCount = Number(readDbField(text, 'DB_VERIFY_NOT_FOUND')) || 0;
  const notFound = notFoundCount > 0;
  return { httpCode, notFound };
}

// Build the script that renews a tunnel's lifetime: `devbridge update <id> -e
// <hours>`. The expiry is a ROLLING WINDOW (measured 2026-10: renewal sets
// expiration = now + hours regardless of remaining time, so renewing before
// expiry keeps the same URL alive indefinitely). The absolute expiration
// (tunnelExpiration, Unix seconds) is surfaced via show -v so callers get a
// verifiable timestamp instead of a bare exit code.
export function buildDevbridgeRenewScript(tunnelId: unknown, expiryHours: unknown = DEVBRIDGE_RENEW_HOURS): string {
  const id = validateTunnelId(tunnelId);
  const hours = validateExpiryHours(expiryHours);
  return [
    // #999: data-disk-first PATH (the surviving binary location).
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"`,
    `devbridge update ${id} -e ${hours} > /tmp/db-renew-update.log 2>&1`,
    `DB_RENEW_EXIT=$?`,
    `DB_RENEW_ERROR=$(head -1 /tmp/db-renew-update.log 2>/dev/null)`,
    `rm -f /tmp/db-renew-update.log`,
    `DB_EXPIRATION=$(devbridge show ${id} -v 2>&1 | grep -oE 'tunnelExpiration[^0-9]+[0-9]+' | grep -oE '[0-9]+' | head -1)`,
    `echo "DB_RENEW_EXIT=$DB_RENEW_EXIT"`,
    `echo "DB_RENEW_ID=${id}"`,
    `echo "DB_RENEW_HOURS=${hours}"`,
    `echo "DB_EXPIRATION=$DB_EXPIRATION"`,
    `echo "DB_RENEW_ERROR=$DB_RENEW_ERROR"`,
  ].join('\n');
}

export interface RenewTunnelResult {
  ok: boolean;
  tunnelId: string;
  renewedForHours: number | undefined;
  expirationUnix: number | undefined;
  expiresAt: string | undefined;
  error: string | undefined;
}

// Parse the raw stdout of buildDevbridgeRenewScript into structured fields.
// A renewal is ok only when the update exit code is 0 AND show -v reports the
// absolute tunnelExpiration — the management plane can lose a tunnel's record
// (10002 "tunnel not found") while the data plane keeps serving, which a bare
// exit-code check would misread as success on the old process alone.
export function parseDevbridgeRenewOutput(stdout: unknown): RenewTunnelResult {
  const text = stripTerminalEscapes(stdout);
  const renewExit = readDbField(text, 'DB_RENEW_EXIT');
  const expirationUnix = Number(readDbField(text, 'DB_EXPIRATION')) || undefined;
  const ok = renewExit === '0' && expirationUnix !== undefined;
  const expiration = expirationUnix !== undefined ? new Date(expirationUnix * 1000).toISOString() : undefined;
  return {
    ok,
    tunnelId: readDbField(text, 'DB_RENEW_ID'),
    renewedForHours: Number(readDbField(text, 'DB_RENEW_HOURS')) || undefined,
    expirationUnix,
    expiresAt: expiration,
    error: ok
      ? undefined
      : readDbField(text, 'DB_RENEW_ERROR') ||
        (renewExit === '0'
          ? 'update succeeded but the absolute expiration could not be read back (management-plane record loss?) — treat as unverified'
          : `renewal failed (exit ${renewExit || 'unknown'})`),
  };
}

// Renew a tunnel's lifetime via `devbridge update <id> -e <hours>`. Returns ok,
// tunnelId, expiresAt (absolute ISO timestamp), renewedForHours. The URL does
// not change — renewal only extends the lifetime of the existing tunnel ID.
export async function renewTunnel(
  workspaceId: string,
  { tunnelId, expiryHours }: { tunnelId?: unknown; expiryHours?: unknown },
  username = 'root',
  timeoutMs = 60000,
): Promise<RenewTunnelResult> {
  if (!workspaceId) {
    throw new Error('sandbox renew tunnel: workspace_id is required.');
  }
  const script = buildDevbridgeRenewScript(tunnelId, expiryHours);
  const result = await runOneShot(workspaceId, script, username, timeoutMs);
  return parseDevbridgeRenewOutput(result.stdout);
}

export interface KeepaliveTunnel {
  tunnelId: string;
  url: string;
}

// Build the keepalive watchdog script for a set of known tunnels (the
// three-layer pattern proven in the 2026-10 tunnel-persistence test):
//   1. host watchdog — re-attach with `devbridge host <id>` when the host
//      process dies; the URL is bound to the tunnel ID, so it never changes
//   2. daily renewal — `devbridge update <id> -e 720` (29-day failure tolerance)
//   3. health check — curl each URL every 5 minutes, log on non-200/304
// URLs are HARDCODED per tunnel (tunnel IDs never change), NOT derived from
// `devbridge port list` — that table's lines are wrapped in OSC escapes on
// integration-enabled shells, so anchored greps silently fail and the
// constructed health URL 404s (measured 2026-10).
// v2 divergences from main's script (recorded): the PATH export is
// data-disk-first (#999); the health-check curl carries --noproxy '*'
// (#1000 — main's own keepalive missed it; without it the watchdog logs WARN
// 502/404 fakes for healthy tunnels) and drops main's `|| echo "000"` (the
// file's documented sentinel-doubling doctrine — an empty HC still WARNs);
// and the layer-1 probe matches BOTH host launch forms (main's single-form
// pgrep cannot see the -p-form host expose_tunnel itself launched and
// spuriously "restarts" it on the first tick).
export function buildDevbridgeKeepaliveScript(tunnels: unknown): string {
  if (!Array.isArray(tunnels) || tunnels.length === 0) {
    throw new Error('sandbox keepalive: tunnels must be a non-empty array of {tunnelId, url}.');
  }
  const entries = (tunnels as Array<Record<string, unknown>>)
    .map((t) => {
      const id = validateTunnelId(t?.tunnelId);
      const url = asText(t?.url ?? '');
      if (!/^https:\/\/[A-Za-z0-9:._/-]+$/.test(url)) {
        throw new Error(
          `sandbox keepalive: invalid tunnel URL ${JSON.stringify(url.slice(0, 80))} for the keepalive health check. Expected an https:// URL with URL-safe characters (from huaweicloud_sandbox_expose_tunnel's publicUrl).`,
        );
      }
      // The URL embeds the port (https://<id>-<port>.domain) — the layer-1
      // liveness probe needs BOTH host launch forms: expose_tunnel starts
      // `devbridge host -p <port>` (the ID does not exist at launch), the
      // re-attach form is `devbridge host <id>`. A single-form pgrep misses
      // the live -p-form host and spuriously "restarts" it on the first tick
      // (v2 fix — main's watchdog carries the single-form miss).
      const port = url.match(/-(\d+)\.[^.]+\.[^.]+\.[^.]+\/?$/)?.[1] ?? '';
      return port ? `${id}:${url}:${port}` : `${id}:${url}:`;
    })
    .join(' ');
  // Heredoc is single-quoted ('DB_KEEPALIVE_EOF') so the writer shell expands
  // nothing; all ${...} expansion happens inside the watchdog at runtime.
  const body = [
    `#!/bin/bash`,
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"`,
    `# entries: tunnelId:url (URLs are stable — tunnel IDs never change)`,
    `TUNNELS="${entries}"`,
    `declare -A LAST_RENEW`,
    `while true; do`,
    `  NOW=$(date -u +%s)`,
    `  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)`,
    `  for entry in $TUNNELS; do`,
    `    ID="\${entry%%:*}"; REST="\${entry#*:}"; URL="\${REST%:*}"; PORT="\${REST##*:}"`,
    `    if ! pgrep -f "devbridge host $ID" > /dev/null 2>&1 && ! pgrep -f "devbridge host -p $PORT" > /dev/null 2>&1; then`,
    `      if command -v setsid > /dev/null 2>&1; then setsid nohup devbridge host "$ID" > "/tmp/host-$ID.log" 2>&1 < /dev/null & else nohup devbridge host "$ID" > "/tmp/host-$ID.log" 2>&1 < /dev/null & fi`,
    `      echo "$TS host $ID restarted (same tunnel, URL unchanged)" >> /tmp/tunnel-keepalive.log`,
    `      sleep 8`,
    `    fi`,
    `    if [ $((\${LAST_RENEW[$ID]:-0})) -eq 0 ] || [ $((NOW - \${LAST_RENEW[$ID]})) -ge 86400 ]; then`,
    `      if devbridge update "$ID" -e ${DEVBRIDGE_RENEW_HOURS} > /tmp/keepalive-last-update.log 2>&1; then`,
    `        echo "$TS renew $ID ok (${DEVBRIDGE_RENEW_HOURS}h)" >> /tmp/tunnel-keepalive.log`,
    `      else`,
    `        echo "$TS renew $ID FAILED: $(head -1 /tmp/keepalive-last-update.log)" >> /tmp/tunnel-keepalive.log`,
    `      fi`,
    `      LAST_RENEW[$ID]=$NOW`,
    `    fi`,
    `    HC=$(curl -s --noproxy '*' -o /dev/null -w "%{http_code}" --max-time 10 "$URL/" 2>/dev/null)`,
    `    if [ "$HC" != "200" ] && [ "$HC" != "304" ]; then`,
    `      echo "$TS health $ID WARN http=$HC" >> /tmp/tunnel-keepalive.log`,
    `    fi`,
    `  done`,
    `  sleep 300`,
    `done`,
  ].join('\n');
  return [
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"`,
    `pkill -f "tunnel-keepalive.sh" 2>/dev/null || true`,
    `sleep 1`,
    `cat > /tmp/tunnel-keepalive.sh << 'DB_KEEPALIVE_EOF'`,
    body,
    `DB_KEEPALIVE_EOF`,
    `chmod +x /tmp/tunnel-keepalive.sh`,
    `bash -n /tmp/tunnel-keepalive.sh > /dev/null 2>&1`,
    `echo "DB_KEEPALIVE_SYNTAX=$?"`,
    `if command -v setsid > /dev/null 2>&1; then setsid nohup /tmp/tunnel-keepalive.sh > /dev/null 2>&1 < /dev/null & else nohup /tmp/tunnel-keepalive.sh > /dev/null 2>&1 < /dev/null & fi`,
    `disown 2>/dev/null || true`,
    `sleep 3`,
    `echo "DB_KEEPALIVE_PID=$(pgrep -f 'tunnel-keepalive.sh' | head -1)"`,
    `echo "DB_KEEPALIVE_LOG=/tmp/tunnel-keepalive.log"`,
  ].join('\n');
}

// Read the tunnel list of the INSTALLED watchdog (if any). The TUNNELS line in
// /tmp/tunnel-keepalive.sh is the single source of truth for what is currently
// protected; expose_tunnel reads it before installing so the new tunnel is
// MERGED into the existing protection instead of replacing it.
export function buildKeepaliveTunnelsReadScript(): string {
  return [
    `LINE=$(grep -m1 '^TUNNELS=' /tmp/tunnel-keepalive.sh 2>/dev/null | sed 's/^TUNNELS=//; s/^"//; s/"$//')`,
    `echo "DB_KEEPALIVE_TUNNELS=$LINE"`,
  ].join('\n');
}

// Parse the raw stdout of buildKeepaliveTunnelsReadScript. Empty output (no
// watchdog installed yet) yields [].
export function parseKeepaliveTunnelsOutput(stdout: unknown): KeepaliveTunnel[] {
  const text = stripTerminalEscapes(stdout);
  const m = text.match(/^DB_KEEPALIVE_TUNNELS=(.*)$/m);
  const line = m ? (m[1] ?? '').trim() : '';
  if (!line) return [];
  return line
    .split(/\s+/)
    .map((entry) => {
      const i = entry.indexOf(':');
      return i > 0 ? { tunnelId: entry.slice(0, i), url: entry.slice(i + 1) } : null;
    })
    .filter((t): t is KeepaliveTunnel => t !== null);
}

// Merge the current watchdog tunnels with the incoming ones: dedupe by
// tunnelId, incoming wins (same tunnel re-exposed refreshes its URL), existing
// order preserved, new tunnels appended. Known limit: the read and the install
// are two execs — two CONCURRENT expose_tunnel calls on the same sandbox can
// interleave them and last-writer-wins drops the other's tunnel (documented;
// single-sandbox concurrency is not a supported posture).
export function mergeKeepaliveTunnels(existing: unknown, incoming: unknown): KeepaliveTunnel[] {
  const byId = new Map<string, KeepaliveTunnel>();
  for (const t of (Array.isArray(existing) ? existing : []) as Array<Record<string, unknown>>) {
    if (t?.tunnelId && t?.url) byId.set(asText(t.tunnelId), { tunnelId: asText(t.tunnelId), url: asText(t.url) });
  }
  for (const t of (Array.isArray(incoming) ? incoming : []) as Array<Record<string, unknown>>) {
    if (t?.tunnelId && t?.url) byId.set(asText(t.tunnelId), { tunnelId: asText(t.tunnelId), url: asText(t.url) });
  }
  return [...byId.values()];
}

export interface KeepaliveWatchdogResult {
  ok: boolean;
  scriptPath?: string;
  logPath?: string;
  watchdogPid?: string;
  tunnels?: KeepaliveTunnel[];
  error?: string;
}

// Install the keepalive watchdog in the sandbox. Validates every tunnel ID and
// URL before splicing, aborts on a bash syntax error (DB_KEEPALIVE_SYNTAX != 0),
// and reports the watchdog PID. Replacing the watchdog (re-running the tool)
// kills the old loop first so two loops never double-renew.
export async function installKeepaliveWatchdog(
  workspaceId: string,
  { tunnels }: { tunnels: unknown },
  username = 'root',
  timeoutMs = 60000,
): Promise<KeepaliveWatchdogResult> {
  if (!workspaceId) {
    throw new Error('sandbox keepalive: workspace_id is required.');
  }
  const script = buildDevbridgeKeepaliveScript(tunnels);
  const result = await runOneShot(workspaceId, script, username, timeoutMs);
  const text = stripTerminalEscapes(result.stdout);
  const syntax = readDbField(text, 'DB_KEEPALIVE_SYNTAX');
  if (syntax !== '0') {
    return {
      ok: false,
      error: `keepalive watchdog script failed the bash -n syntax check (exit ${syntax || 'unknown'}).`,
    };
  }
  // The syntax gate alone is a weak success: the launch is unconditional, so a
  // watchdog that dies inside the 3-second window (noexec /tmp, spawn failure)
  // would report ok with no PID — a silent non-existence for a subsystem whose
  // whole point is unattended liveness. An empty PID is an honest failure.
  const pid = readDbField(text, 'DB_KEEPALIVE_PID');
  if (!pid) {
    return {
      ok: false,
      error:
        'keepalive watchdog passed the syntax check but no running PID was found after launch — the script may have died immediately (noexec /tmp? missing bash?). Inspect /tmp/tunnel-keepalive.log.',
    };
  }
  return {
    ok: true,
    scriptPath: '/tmp/tunnel-keepalive.sh',
    logPath: readDbField(text, 'DB_KEEPALIVE_LOG') || '/tmp/tunnel-keepalive.log',
    watchdogPid: pid,
    tunnels: ((Array.isArray(tunnels) ? tunnels : []) as Array<Record<string, unknown>>).map((t) => ({
      tunnelId: asText(t.tunnelId),
      url: asText(t.url),
    })),
  };
}

// Expose a sandbox port to a public DevBridge tunnel URL. `port` MUST be the
// ACTUAL port reported by deployNginx (deploy_nginx auto-increments on conflict),
// otherwise the tunnel is bound to a dead port. Returns ok, publicUrl, port,
// tunnelId, auth mode, expiresAt (tunnel lifetime from -e), and warnings; the
// tunnel is re-verified from a second independent exec session (#919) and the
// result carries verifyHttpCode + persistent so callers can tell a
// session-surviving URL from one that dies with the deploying session. v2
// deviation from main: a final attempt that yields no usable URL (empty
// tunnelUrl, or HTTP 000) returns ok:false — main returned ok:true with a dead
// publicUrl, which contradicted the skill's "the returned publicUrl is the
// deployment result" contract.
export async function exposeTunnel(
  workspaceId: string,
  { port, expiryHours, keepalive }: { port?: number | string; expiryHours?: number; keepalive?: boolean },
  username = 'root',
  timeoutMs = 90000,
): Promise<ExposeTunnelResult> {
  if (!workspaceId) {
    throw new Error('sandbox expose tunnel: workspace_id is required.');
  }
  const validatedPort = validateTunnelPort(port);
  const validatedExpiryHours = validateExpiryHours(expiryHours ?? DEVBRIDGE_HOST_EXPIRY_HOURS);

  const authScript = buildDevbridgeAuthProbe();
  const authResult = await runOneShot(workspaceId, authScript, username, 30000);
  const { authMode, attempts, version: authVersion } = parseDevbridgeAuthOutput(authResult.stdout);

  // #998: version gate BEFORE the expose loop. 0.1.x binaries' AK/SK tier still
  // logs in, so authMode alone would green-light an expose that can never work.
  // This must precede the authMode check — the structured too_old error names
  // the real cause where the auth-failure path would point at credentials.
  const versionCheck = evaluateDevbridgeVersion(authVersion);
  if (versionCheck.blocked) {
    return {
      ok: false,
      port: validatedPort,
      error: versionCheck.error,
      error_code: 'devbridge_too_old',
      version: authVersion,
      authMode,
      attempts,
      // The combined case (0.1.x AND no usable credential): the version is the
      // permanent blocker and keeps precedence, but the caller must not lose
      // the credential half of the diagnosis.
      remediation:
        versionCheck.remediation +
        (authMode === 'NO_CREDENTIAL' || authMode === ''
          ? ' Note: authMode ' +
            (authMode || '(none)') +
            ' indicates a SEPARATE credential issue — after upgrading, re-run huaweicloud_sandbox_credentials.'
          : ''),
    };
  }

  if (authMode !== 'API_KEY_KEYRING' && authMode !== 'AKSK_SUPPORTED' && authMode !== 'API_KEY_FILE') {
    // v2 deviation: truncation like hostLog — raw auth output is diagnostics,
    // and the auth script never echoes key values, but bound it anyway.
    const loginOutput = (String(authResult.stdout ?? '') + String(authResult.error ?? '')).slice(0, 400);
    return {
      ok: false,
      port: validatedPort,
      error: 'DevBridge authentication failed: no usable credential in the sandbox.',
      authMode: authMode || 'UNKNOWN',
      attempts,
      hint:
        'No DevBridge credential is available in this sandbox. Suggested next steps:\n' +
        '1) Re-run huaweicloud_sandbox_credentials once, then retry huaweicloud_sandbox_expose_tunnel — ' +
        'this refreshes the temporary AK/SK (most common quick fix when they simply expired) and rewrites /tmp/hw_creds.sh.\n' +
        '2) If it still fails, this sandbox was created on an older image and cannot auto-acquire an API Key ' +
        '(the image cannot be upgraded in place). One-time manual fallback: create an API Key at ' +
        'https://devstation.connect.huaweicloud.com/space/devbridge/apikey, run `export HW_API_KEY=<key>` locally, ' +
        're-run huaweicloud_sandbox_credentials, then retry.\n' +
        '3) The "attempts" field shows which tiers were tried and why they failed — include it when escalating to the platform team.',
      loginOutput,
    };
  }

  let result: OneShotResult | undefined;
  let attempt = 0;
  const maxAttempts = 2;
  while (attempt < maxAttempts) {
    attempt += 1;
    const exposeScript = buildDevbridgeExposeScript(validatedPort, validatedExpiryHours);
    // A2 budget guard: the script's worst case is ~63s of bounded waits
    // (2s settle + up to 9s URL-extraction + 4×10s probes + 3×5s backoff) plus
    // the delete-all round-trip, inside one one-shot exec — a ws-exec timeout
    // here must fold into the unreachable envelope (with the outer rebuild
    // retry) instead of throwing a raw WebSocketExecError out of the tool.
    let exposeFailed = false;
    try {
      result = await runOneShot(workspaceId, exposeScript, username, timeoutMs);
    } catch {
      exposeFailed = true;
      result = { stdout: '', exitCode: 124 };
    }
    const parsed = parseDevbridgeExposeOutput(result.stdout);

    // 10006 quota exceeded: clean up stale tunnels and retry.
    if (parsed.quotaError && attempt < maxAttempts) {
      continue;
    }
    // Unreachable (000 — including a timed-out or failed expose exec), a
    // migrated-gateway placeholder (host-log marker), or gateway-level tunnel
    // errors (404 "tunnel not found" / "port not configured"): one cleanup +
    // rebuild retry. 502 "bad gateway" (host alive, local service down) also
    // gets one retry to cover slow app starts.
    const unreachable = exposeFailed || parsed.httpCode === '000' || parsed.httpCode === '';
    const migration = parsed.migration === true;
    const gatewayTunnelError = parsed.gatewayTunnelError === true;
    const backendDown = parsed.badGateway === true;
    if (unreachable || migration || gatewayTunnelError || backendDown) {
      if (attempt === 1) {
        // best-effort cleanup before the retry; the expose script pre-cleans too.
        try {
          await runOneShot(
            workspaceId,
            // #999: same first-line export as the expose script (the cleanup
            // one-shot is a fresh shell too).
            `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; pkill -f "devbridge host" 2>/dev/null || true; sleep 2; devbridge delete-all > /dev/null 2>&1 || true`,
            username,
            20000,
          );
        } catch {
          // best-effort: cleanup failure must not mask the expose failure
        }
        continue;
      }
      // Retry exhausted: a URL the gateway itself reports as dead (or one pointing
      // at the retired pre-migration gateway) must NOT be handed over as a working
      // deployment link — a soft warning here used to read as a success.
      if (gatewayTunnelError || migration) {
        return {
          ok: false,
          port: validatedPort,
          error: gatewayTunnelError
            ? 'DevBridge gateway reports the fresh tunnel URL as dead (404 "tunnel not found" / "port not configured") — the host session is not registered on the gateway. A rebuild was already attempted.'
            : 'DevBridge gateway serves a migration placeholder page (服务已迁移) — the URL points at the retired pre-migration gateway and cannot work.',
          // #998: the migration marker is the 0.1.x signature (the retired
          // gateway is what 0.1.x hardcodes) — this branch preempts the
          // read-back, so the Step-0 remediation rides here directly.
          error_code: migration ? 'devbridge_too_old' : undefined,
          remediation: migration
            ? 'A 0.1.x devbridge produced this URL. Upgrade in place per the huawei-sandbox skill Step 0 (install 0.2.x with -p /workspace/.local/bin), then re-run huaweicloud_sandbox_expose_tunnel.'
            : undefined,
          authMode,
          httpCode: parsed.httpCode,
          hostLog: String(result.stdout ?? '').slice(0, 400),
        };
      }
    }

    const warnings: string[] = [];
    if (parsed.quotaError)
      warnings.push('DevBridge tunnel quota (10006) hit — stale tunnels were cleaned up and the host was retried.');
    if (parsed.badGateway)
      warnings.push(
        'Tunnel reachable but the gateway reports "bad gateway" — the local service on the exposed port is not serving.',
      );
    if (exposeFailed) {
      warnings.push(
        'The expose script exec failed or timed out — the probe loop never completed; the attempt failed as unobserved (see the error for the timeout taxonomy).',
      );
    }
    // v2 deviation (the Q2 ruling): a final attempt with no usable URL is a
    // failure — ok:true with a dead publicUrl misleads agents into treating
    // the deployment as complete. A migrated gateway serves its placeholder
    // with HTTP 200, so the marker counts as unusable exactly like 000/''.
    const usable = !migration && parsed.tunnelUrl !== '' && parsed.httpCode !== '000' && parsed.httpCode !== '';
    if (!usable) {
      // #998 read-back: a no-URL failure after retries needs the version in the
      // return body — the gate above catches 0.1.x upfront, but a binary that
      // changed mid-flow (or an empty probe version) lands here, and in the
      // measured incident a single version field would have saved the whole
      // credentials/network/port misdiagnosis. The command reuses the DB_VERSION
      // field grammar (echo + anchored parse through stripTerminalEscapes — the
      // #946 doctrine; a raw stdout read would be OSC-blind on exactly the
      // shells that lose the probe line in the first place).
      let noUrlVersion = authVersion;
      if (parsed.tunnelUrl === '') {
        try {
          const versionResult = await runOneShot(
            workspaceId,
            `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; echo "DB_VERSION=$(devbridge version 2>/dev/null | head -1)"`,
            username,
            15000,
          );
          const readBack =
            stripTerminalEscapes(versionResult.stdout)
              .match(/^DB_VERSION=(.*)$/m)?.[1]
              ?.trim() ?? '';
          noUrlVersion = readBack || authVersion;
        } catch {
          // best-effort: the auth probe's version stands
        }
      }
      const noUrlCheck = evaluateDevbridgeVersion(noUrlVersion);
      if (noUrlCheck.blocked) {
        warnings.push(
          `devbridge version is ${noUrlVersion} — too old to serve tunnels; upgrade per Step 0 before retrying.`,
        );
      }
      // #998 taxonomy: too_old (blocked) / no_tunnel_url (no URL observed —
      // host did not start, or the exec timed out before the log was read) /
      // tunnel_unreachable (URL present, probes exhausted). The timeout-fold
      // case gets its own hedged wording — a timeout lost the observation, it
      // did not prove the host never started.
      const timedOut = exposeFailed && parsed.tunnelUrl === '';
      return {
        ok: false,
        port: validatedPort,
        error: noUrlCheck.blocked
          ? noUrlCheck.error
          : timedOut
            ? 'Failed to expose a working DevBridge tunnel: the expose exec timed out or died before a Tunnel URL could be extracted — host state unknown (see warnings). Retry, or raise timeout_ms.'
            : parsed.tunnelUrl === ''
              ? 'Failed to expose a working DevBridge tunnel: the host log contains no Tunnel URL — the host did not start. Check the hostLog below for the real cause.'
              : 'Failed to expose a working DevBridge tunnel: no reachable public URL after retries.',
        error_code: noUrlCheck.blocked
          ? 'devbridge_too_old'
          : parsed.tunnelUrl === ''
            ? 'no_tunnel_url'
            : 'tunnel_unreachable',
        version: noUrlVersion || undefined,
        authMode,
        httpCode: parsed.httpCode,
        warnings: warnings.length > 0 ? warnings.join(' ') : undefined,
        remediation: noUrlCheck.blocked ? noUrlCheck.remediation : undefined,
        hostLog: String(result.stdout ?? '').slice(0, 400),
      };
    }

    // A2 (#935): the reachability warning rides the OK path only, from the
    // FINAL probe's HTTP status — the in-script retry loop already absorbed
    // gateway-not-ready 502/000 noise, and the exhausted/unusable path above
    // must not carry "may not be serving yet" retry phrasing.
    const reachabilityWarning = formatTunnelReachabilityWarning(parsed.httpCode);
    if (reachabilityWarning) warnings.push(reachabilityWarning);

    // #919: re-verify with a real GET from a SECOND, independent exec session.
    // The in-session health check above cannot prove the host survived session
    // teardown (setsid/nohup/disown make that likely, not certain). When the
    // fresh-session GET fails, the URL will die with the deploying session —
    // say so explicitly instead of returning a link the visitor cannot open.
    // (v2 ordering: the recheck runs only on the usable-URL path — a dead URL
    // already failed above, so no fresh-session call is spent proving it.)
    let verifyHttpCode = '';
    let verifyNotFound = false;
    try {
      const verifyResult = await runOneShot(workspaceId, buildDevbridgeVerifyScript(parsed.tunnelUrl), username, 30000);
      // #922 (B1): parse with the dedicated verify parser — the
      // DB_VERIFY_HTTP_CODE key is not visible to parseDevbridgeExposeOutput.
      const verify = parseDevbridgeVerifyOutput(verifyResult.stdout);
      verifyHttpCode = verify.httpCode || '';
      // #922 (B2): a native false-success form answers HTTP 200 with a
      // "tunnel not found" body — treat it as non-persistent.
      verifyNotFound = verify.notFound;
    } catch {
      // best-effort: a failed recheck leaves verifyHttpCode '' → persistent false,
      // and the warning below tells the developer not to share the URL.
    }
    // 000/'' = the fresh session could not reach the tunnel (host already dead
    // or gateway not serving); 200 with a "tunnel not found" body = the
    // gateway answered but the tunnel is gone; anything else is surfaced as-is.
    const persistent = verifyHttpCode !== '' && verifyHttpCode !== '000' && !verifyNotFound;
    if (!persistent) {
      if (verifyNotFound) {
        warnings.push(
          `复测返回 HTTP ${verifyHttpCode || '???'} 但 body 为 "tunnel not found"（原生假成功形态），访问链接实际未生效，请勿分享 (the recheck answered HTTP ${verifyHttpCode || '???'} with a "tunnel not found" body — the tunnel is NOT serving; do NOT share this URL).`,
        );
      } else if (verifyHttpCode === '') {
        // The verify script always emits a code when it runs (curl prints 000 on
        // transport failure) — an empty code means the recheck exec itself
        // failed. Say that honestly instead of diagnosing the host as dead.
        warnings.push(
          '复测会话执行失败，无法确认访问链接的持久性，请勿分享 (the independent recheck could not run — persistence unverified; treat the URL as non-persistent and do NOT share it).',
        );
      } else {
        warnings.push(
          '访问链接将在会话结束后失效，请勿分享 (the tunnel did NOT survive an independent exec-session recheck — do NOT share this URL; the host process is not persistent).',
        );
      }
    }
    const expiresAt =
      parsed.expiryHours !== undefined
        ? new Date(Date.now() + parsed.expiryHours * 3_600_000).toISOString()
        : undefined;
    // AUTO-ENROLL (see the return-shape comment below): read the installed
    // watchdog's tunnel list and merge the new tunnel into it.
    let keepaliveEnrollment: KeepaliveWatchdogResult | undefined;
    if (keepalive !== false && parsed.tunnelUrl && !parsed.tunnelId) {
      warnings.push(
        'Keepalive enrollment skipped: the tunnel ID could not be derived from the exposed URL — the tunnel works but will NOT be auto-renewed.',
      );
    }
    if (keepalive !== false && parsed.tunnelUrl && parsed.tunnelId) {
      try {
        const readResult = await runOneShot(workspaceId, buildKeepaliveTunnelsReadScript(), username, 20000);
        const existing = parseKeepaliveTunnelsOutput(readResult.stdout);
        const merged = mergeKeepaliveTunnels(existing, [{ tunnelId: parsed.tunnelId, url: parsed.tunnelUrl }]);
        keepaliveEnrollment = await installKeepaliveWatchdog(workspaceId, { tunnels: merged }, username, 30000);
        if (!keepaliveEnrollment.ok) {
          warnings.push(
            `Keepalive watchdog enrollment failed: ${keepaliveEnrollment.error || 'unknown error'} — the tunnel works but will NOT be auto-renewed. Retry with huaweicloud_sandbox_keepalive_watchdog.`,
          );
        }
      } catch (error) {
        warnings.push(
          `Keepalive watchdog enrollment failed (${error instanceof Error ? error.message : 'unknown error'}) — the tunnel works but will NOT be auto-renewed. Retry with huaweicloud_sandbox_keepalive_watchdog.`,
        );
      }
    }

    return {
      ok: true,
      publicUrl: parsed.tunnelUrl,
      port: validatedPort,
      tunnelId: parsed.tunnelId || undefined,
      authMode,
      httpCode: parsed.httpCode,
      verifyHttpCode: verifyHttpCode || undefined,
      verifyNotFound: verifyNotFound || undefined,
      persistent,
      expiresAt,
      expiresInHours: parsed.expiryHours,
      // AUTO-ENROLL: every tunnel exposed through this tool is enrolled into
      // the keepalive watchdog by default (user requirement: all devbridge
      // tunnels deployed to the sandbox must be keepalive-protected —
      // unattended renewal + host re-attach + health check). The new tunnel is
      // MERGED into the existing watchdog tunnel list, never replacing other
      // tunnels' coverage. keepalive:false opts out. Non-fatal: an enrollment
      // failure is surfaced as a warning, not a failed expose — the tunnel
      // itself is working.
      keepalive: keepaliveEnrollment
        ? {
            enrolled: keepaliveEnrollment.ok === true,
            tunnelCount: keepaliveEnrollment.ok ? (keepaliveEnrollment.tunnels ?? []).length : undefined,
            watchdogPid: keepaliveEnrollment.watchdogPid,
            logPath: keepaliveEnrollment.logPath,
            error: keepaliveEnrollment.ok ? undefined : keepaliveEnrollment.error,
          }
        : undefined,
      warnings: warnings.length > 0 ? warnings.join(' ') : undefined,
      hostLog: String(result.stdout ?? '').slice(0, 400),
    };
  }

  return {
    ok: false,
    port: validatedPort,
    error: 'Failed to expose a working DevBridge tunnel after retries.',
    authMode,
    hostLog: String(result?.stdout ?? '').slice(0, 400),
  };
}
