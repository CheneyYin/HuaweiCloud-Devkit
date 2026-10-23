import {
  DEVBRIDGE_BAD_GATEWAY_MARKER,
  DEVBRIDGE_MIGRATION_MARKER,
  DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER,
  DEVBRIDGE_TUNNEL_DOMAIN,
  DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER,
  execOneShot,
  stripTerminalEscapes,
} from './session-manager.ts';

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

// Tunnel lifetime for expose-created hosts, in hours. The report that motivated
// #919 uses -e 72 so the shared link survives long after the deploying session
// ends; the value is surfaced to callers via exposeTunnel's expiresAt field.
export const DEVBRIDGE_HOST_EXPIRY_HOURS = 72;

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
  attempts?: Record<string, string>;
  hint?: string;
  loginOutput?: string;
}

interface OneShotResult {
  stdout: string;
  exitCode: number;
  error?: string;
}

// Test seam: exposeTunnel is otherwise untestable end-to-end (execOneShot
// opens a real ws connection). Pure helpers stay seam-free.
let oneShotForTests:
  ((workspaceId: string, command: string, username: string, timeoutMs: number) => Promise<OneShotResult>) | null = null;

export function _setOneShotForTests(
  fn: ((workspaceId: string, command: string, username: string, timeoutMs: number) => Promise<OneShotResult>) | null,
): void {
  oneShotForTests = fn;
}

async function runOneShot(workspaceId: string, command: string, username: string, timeoutMs: number) {
  return (oneShotForTests ?? execOneShot)(workspaceId, command, username, timeoutMs);
}

// Build a shell snippet that authenticates devbridge via a verified waterfall:
//   Tier 1  keyring API Key  — hwcloud keyring get HW_DEVBRIDGE_API_KEY (platform-injected
//           on hd-space-ai-shell images; the value goes to STDERR so 2>&1 is mandatory and
//           the devbridge_ prefix filters "(not found)" / error text). A light revive step
//           (restart the D-Bus session bus + re-unlock the keyring daemon, no dnf) retries
//           once when the first read fails. Preferred: devbridge is deprecating AK/SK auth.
//   Tier 2  AK/SK            — image builds keep --access-key/--secret-key; STS credentials
//           from /tmp/hw_creds.sh need --security-token or the gateway rejects with 401
//           APIGW.0301; 0.1.x binaries additionally advertise --huaweicloud in help.
//   Tier 3  /tmp/hw_api_key  — release builds accept only --api-key; the file is written by
//           huaweicloud_sandbox_credentials from HW_API_KEY / the api_key param.
// Every tier performs a real `devbridge auth login` and verifies with `auth status`
// (must print "Logged in"); on failure the waterfall falls through to the next tier.
// DB_ATTEMPT_* lines are non-sensitive diagnostics for support escalation.
export function buildDevbridgeAuthProbe(): string {
  return [
    `export PATH="$HOME/.huawei/bin:$PATH"`,
    `export HOME="\${HOME:-/root}"`,
    `DB_OK=0`,
    `db_login_ok() { devbridge auth status 2>/dev/null | grep -q "Logged in"; }`,
    `db_diag() { echo "DB_ATTEMPT_$1=$2"; }`,
    ``,
    `# ---- Tier 1: API Key from the sandbox keyring (platform auto-injection) ----`,
    `HW_DB_KEY=""`,
    `if command -v hwcloud >/dev/null 2>&1; then`,
    `  export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/dbus-session}"`,
    `  HW_DB_KEY=$(hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1 || true)`,
    `  case "$HW_DB_KEY" in`,
    `    "devbridge_"*) : ;;`,
    `    *)`,
    `      # Light revive: bus down or a locked/absent keyring daemon — restart both, retry once.`,
    `      if ! pgrep -x dbus-daemon >/dev/null 2>&1 && command -v dbus-daemon >/dev/null 2>&1; then`,
    `        dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork --nopidfile >/dev/null 2>&1 || true`,
    `        sleep 1`,
    `      fi`,
    `      if command -v gnome-keyring-daemon >/dev/null 2>&1; then`,
    `        pkill -f gnome-keyring-daemon 2>/dev/null || true`,
    `        sleep 1`,
    `        printf '\n' | gnome-keyring-daemon --unlock >/dev/null 2>&1 || true`,
    `        sleep 1`,
    `        HW_DB_KEY=$(hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1 || true)`,
    `      fi`,
    `      case "$HW_DB_KEY" in "devbridge_"*) : ;; *) HW_DB_KEY="";; esac`,
    `      ;;`,
    `  esac`,
    `else`,
    `  db_diag KEYRING "hwcloud-not-installed"`,
    `fi`,
    `if [ -n "$HW_DB_KEY" ]; then`,
    `  devbridge auth login --api-key "$HW_DB_KEY" >/tmp/db_auth.log 2>&1`,
    `  if db_login_ok; then`,
    `    echo "DB_AUTH_MODE=API_KEY_KEYRING"`,
    `    DB_OK=1`,
    `  else`,
    `    db_diag KEYRING "login-failed"`,
    `  fi`,
    `else`,
    `  db_diag KEYRING "no-valid-key"`,
    `fi`,
    ``,
    `# ---- Tier 2: AK/SK from /tmp/hw_creds.sh (image builds; STS needs --security-token) ----`,
    `if [ "$DB_OK" -eq 0 ]; then`,
    `  source /tmp/hw_creds.sh 2>/dev/null`,
    `  if devbridge auth login --help 2>&1 | grep -q -- '--access-key' && [ -n "$HW_ACCESS_KEY" ]; then`,
    `    DB_TOKEN_ARGS=""`,
    `    [ -n "$HW_SECURITY_TOKEN" ] && DB_TOKEN_ARGS="--security-token \\"$HW_SECURITY_TOKEN\\""`,
    `    if devbridge auth login --help 2>&1 | grep -q -- '--huaweicloud'; then`,
    `      devbridge auth login --huaweicloud --access-key "$HW_ACCESS_KEY" --secret-key "$HW_SECRET_KEY" $DB_TOKEN_ARGS >/tmp/db_auth.log 2>&1`,
    `    else`,
    `      devbridge auth login --access-key "$HW_ACCESS_KEY" --secret-key "$HW_SECRET_KEY" $DB_TOKEN_ARGS >/tmp/db_auth.log 2>&1`,
    `    fi`,
    `    if db_login_ok; then`,
    `      echo "DB_AUTH_MODE=AKSK_SUPPORTED"`,
    `      DB_OK=1`,
    `    else`,
    `      db_diag AKSK "login-failed"`,
    `    fi`,
    `  else`,
    `    db_diag AKSK "binary-or-creds-unavailable"`,
    `  fi`,
    `fi`,
    ``,
    `# ---- Tier 3: API Key from /tmp/hw_api_key (release builds, user-provided) ----`,
    `if [ "$DB_OK" -eq 0 ]; then`,
    `  source /tmp/hw_api_key 2>/dev/null`,
    `  if [ -n "$HW_API_KEY" ]; then`,
    `    devbridge auth login --api-key "$HW_API_KEY" >/tmp/db_auth.log 2>&1`,
    `    if db_login_ok; then`,
    `      echo "DB_AUTH_MODE=API_KEY_FILE"`,
    `      DB_OK=1`,
    `    else`,
    `      db_diag APIKEY_FILE "login-failed"`,
    `    fi`,
    `  else`,
    `    db_diag APIKEY_FILE "no-file"`,
    `  fi`,
    `fi`,
    ``,
    `if [ "$DB_OK" -eq 0 ]; then`,
    `  echo "DB_AUTH_MODE=NO_CREDENTIAL"`,
    `fi`,
    `unset HW_DB_KEY HW_API_KEY DB_TOKEN_ARGS 2>/dev/null`,
    `devbridge auth status > /tmp/db_status.log 2>&1 || true`,
  ].join('\n');
}

export interface DevbridgeAuth {
  authMode: string;
  attempts: Record<string, string>;
}

// Parse the raw stdout of buildDevbridgeAuthProbe into { authMode, attempts }.
// authMode is the LAST DB_AUTH_MODE line; attempts collects the non-sensitive
// DB_ATTEMPT_* diagnostics emitted by tiers that failed and fell through.
export function parseDevbridgeAuthOutput(stdout: unknown): DevbridgeAuth {
  // #946: OSC 133 markers precede every line on integration-enabled shells; the
  // anchored ^DB_ATTEMPT_ regexes are blind to them without stripping first.
  const text = stripTerminalEscapes(stdout);
  const modes = text.match(/DB_AUTH_MODE=([A-Z_]+)/g) ?? [];
  const authMode = modes.length > 0 ? ((modes[modes.length - 1] ?? '').split('=')[1] ?? '') : '';
  const attempts: Record<string, string> = {};
  for (const m of text.matchAll(/^DB_ATTEMPT_([A-Z_]+)=(\S+)$/gm)) {
    attempts[m[1] ?? ''] = m[2] ?? '';
  }
  return { authMode, attempts };
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
    `pkill -f "devbridge host" 2>/dev/null || true`,
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

// Parse and validate a TCP port number destined for shell interpolation. Returns
// the integer when 1..65535; throws otherwise. Guards the `-p ${port}` shell
// splice in buildDevbridgeExposeScript against non-numeric / out-of-range input.
export function validateTunnelPort(port: unknown): number {
  const n = Number(port);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `sandbox expose tunnel: invalid port ${JSON.stringify(port)}. Expected an integer between 1 and 65535 (use the "port" value returned by sandbox_deploy_nginx).`,
    );
  }
  return n;
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
  { port }: { port?: number | string },
  username = 'root',
  timeoutMs = 90000,
): Promise<ExposeTunnelResult> {
  if (!workspaceId) {
    throw new Error('sandbox expose tunnel: workspace_id is required.');
  }
  const validatedPort = validateTunnelPort(port);

  const authScript = buildDevbridgeAuthProbe();
  const authResult = await runOneShot(workspaceId, authScript, username, 30000);
  const { authMode, attempts } = parseDevbridgeAuthOutput(authResult.stdout);

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
    const exposeScript = buildDevbridgeExposeScript(validatedPort);
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
            `pkill -f "devbridge host" 2>/dev/null || true; sleep 2; devbridge delete-all > /dev/null 2>&1 || true`,
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
        'The expose script exec failed or timed out — the probe loop never completed; the attempt was treated as unreachable.',
      );
    }
    // v2 deviation (the Q2 ruling): a final attempt with no usable URL is a
    // failure — ok:true with a dead publicUrl misleads agents into treating
    // the deployment as complete. A migrated gateway serves its placeholder
    // with HTTP 200, so the marker counts as unusable exactly like 000/''.
    const usable = !migration && parsed.tunnelUrl !== '' && parsed.httpCode !== '000' && parsed.httpCode !== '';
    if (!usable) {
      return {
        ok: false,
        port: validatedPort,
        error: 'Failed to expose a working DevBridge tunnel: no reachable public URL after retries.',
        authMode,
        httpCode: parsed.httpCode,
        warnings: warnings.length > 0 ? warnings.join(' ') : undefined,
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
