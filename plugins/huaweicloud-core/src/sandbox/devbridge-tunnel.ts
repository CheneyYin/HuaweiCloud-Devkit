import { stripTerminalEscapes } from './session-manager.ts';
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
import {
  buildDevbridgeExposeScript,
  formatTunnelReachabilityWarning,
  parseDevbridgeExposeOutput,
  readDbField,
  type ExposeTunnelResult,
} from './devbridge-expose.ts';
import { buildDevbridgeVerifyScript, parseDevbridgeVerifyOutput } from './devbridge-verify.ts';

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
// The expose attempt contract (script, stdout grammar, reachability warning,
// result interface) lives in devbridge-expose.ts; re-exported as the public
// face.
export {
  buildDevbridgeExposeScript,
  formatTunnelReachabilityWarning,
  parseDevbridgeExposeOutput,
  parseDevbridgeProbeSequence,
} from './devbridge-expose.ts';
export type { DevbridgeExpose, DevbridgeProbe, ExposeTunnelResult } from './devbridge-expose.ts';
// The fresh-session re-verify family (script + dedicated parser) lives in
// devbridge-verify.ts; re-exported as the public face.
export { buildDevbridgeVerifyScript, parseDevbridgeVerifyOutput } from './devbridge-verify.ts';
export type { DevbridgeVerify } from './devbridge-verify.ts';

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
