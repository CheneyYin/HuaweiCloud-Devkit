import { DEVBRIDGE_MIGRATION_MARKER, DEVBRIDGE_TUNNEL_DOMAIN, execOneShot } from './session-manager.ts';

// The DevBridge expose-tunnel flow, extracted from session-manager so the
// tunnel helpers stay a cohesive unit with a pure-function test surface.
// Ported from main's v1.1.8 session-manager.mjs with two deliberate v2
// deviations (adversarial-review rulings): a final attempt with no usable
// URL returns ok:false instead of ok:true-with-dead-URL, and loginOutput
// is truncated like hostLog (defense-in-depth on diagnostics).

export interface ExposeTunnelResult {
  ok: boolean;
  publicUrl?: string;
  port: number;
  tunnelId?: string;
  authMode: string;
  httpCode?: string;
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
  const text = typeof stdout === 'string' ? stdout : '';
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
// pre-clean stale tunnels (quota 10006), start host in background, read
// "Tunnel URL: ..." from /tmp/host.log, curl-check, retry once on unreachable.
export function buildDevbridgeExposeScript(port: number): string {
  const hostLog = '/tmp/host.log';
  return [
    `pkill -f "devbridge host" 2>/dev/null || true`,
    `sleep 2`,
    `devbridge delete-all > /dev/null 2>&1 || true`,
    `nohup devbridge host -p ${port} -e 8 > ${hostLog} 2>&1 &`,
    `sleep 12`,
    `TUNNEL_URL=$(sed -n 's/.*Tunnel URL: *//p' ${hostLog} | tail -1)`,
    `HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$TUNNEL_URL" 2>/dev/null || echo "000")`,
    `echo "DB_HOST_LOG="`,
    `tail -n 5 ${hostLog}`,
    `echo "DB_TUNNEL_URL=$TUNNEL_URL"`,
    `echo "DB_HTTP_CODE=$HTTP_CODE"`,
    `echo "DB_QUOTA_ERROR=$(grep -c '10006' ${hostLog} 2>/dev/null || echo 0)"`,
  ].join('\n');
}

export interface DevbridgeExpose {
  tunnelUrl: string;
  httpCode: string;
  quotaError: boolean;
  tunnelId: string;
}

// Parse the raw stdout of buildDevbridgeExposeScript into structured fields.
export function parseDevbridgeExposeOutput(stdout: unknown): DevbridgeExpose {
  const text = typeof stdout === 'string' ? stdout : '';
  const getField = (key: string): string => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? (m[1] ?? '').trim() : '';
  };
  const tunnelUrl = getField('DB_TUNNEL_URL') || (text.match(/TUNNEL_URL:(https:\/\/[^\s]+)/) ?? [])[1] || '';
  const httpCode = getField('DB_HTTP_CODE');
  const quotaError = getField('DB_QUOTA_ERROR') === '1' || text.includes('10006');
  const domainPattern = DEVBRIDGE_TUNNEL_DOMAIN.replace(/\./g, '\\.');
  const tunnelId =
    (tunnelUrl.match(new RegExp(`^https:\\/\\/([A-Za-z0-9_-]+)-\\d+\\.${domainPattern}`)) ?? [])[1] ?? '';
  return { tunnelUrl, httpCode, quotaError, tunnelId };
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
// tunnelId, auth mode, and warnings. v2 deviation from main: a final attempt
// that yields no usable URL (empty tunnelUrl, or HTTP 000) returns ok:false —
// main returned ok:true with a dead publicUrl, which contradicted the skill's
// "the returned publicUrl is the deployment result" contract.
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
    result = await runOneShot(workspaceId, exposeScript, username, timeoutMs);
    const parsed = parseDevbridgeExposeOutput(result.stdout);

    // 10006 quota exceeded: clean up stale tunnels and retry.
    if (parsed.quotaError && attempt < maxAttempts) {
      continue;
    }
    // Unreachable (000) or a migrated-gateway placeholder: one retry.
    const unreachable = parsed.httpCode === '000' || parsed.httpCode === '';
    const migration = String(result.stdout ?? '').includes(DEVBRIDGE_MIGRATION_MARKER);
    if (unreachable || migration) {
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
    }

    const warnings: string[] = [];
    if (parsed.quotaError)
      warnings.push('DevBridge tunnel quota (10006) hit — stale tunnels were cleaned up and the host was retried.');
    if (parsed.httpCode !== '200' && parsed.httpCode !== '304') {
      warnings.push(
        `Tunnel reachable check returned HTTP ${parsed.httpCode} (expected 200/304). The URL may not be serving yet.`,
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
        error: migration
          ? 'Failed to expose a working DevBridge tunnel: the gateway served a migration placeholder page (treat the URL as unreachable).'
          : 'Failed to expose a working DevBridge tunnel: no reachable public URL after retries.',
        authMode,
        httpCode: parsed.httpCode,
        warnings: warnings.length > 0 ? warnings.join(' ') : undefined,
        hostLog: String(result.stdout ?? '').slice(0, 400),
      };
    }
    return {
      ok: true,
      publicUrl: parsed.tunnelUrl,
      port: validatedPort,
      tunnelId: parsed.tunnelId || undefined,
      authMode,
      httpCode: parsed.httpCode,
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
