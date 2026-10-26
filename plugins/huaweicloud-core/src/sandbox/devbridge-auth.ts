import { stripTerminalEscapes } from './sandbox-output.ts';

// The DevBridge auth waterfall, extracted from devbridge-tunnel so the auth
// probe script, its stdout parser, and (with the devbridge-tunnel
// modularization) the expose flow's auth/version gate form one cohesive auth
// concern. Imports the escape-stripping seam from its canonical home.

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
    // #999: /workspace/.local/bin FIRST — /workspace is the data disk and
    // survives sandbox reboots; ~/.huawei/bin lives on the system disk and is
    // wiped back to the image state on reboot. Prepended so a stale image
    // binary in /usr/local/bin never wins.
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"`,
    `export HOME="\${HOME:-/root}"`,
    // #998: probe the version in the SAME exec as the auth waterfall (no extra
    // round trip). 0.1.x binaries' AK/SK tier still logs in, so the auth probe
    // alone would green-light an expose that can never work — the version is
    // what names the real cause.
    `DB_VERSION=$(devbridge version 2>/dev/null | head -1)`,
    `echo "DB_VERSION=\${DB_VERSION}"`,
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
  version: string;
}

// Parse the raw stdout of buildDevbridgeAuthProbe into { authMode, attempts, version }.
// authMode is the LAST DB_AUTH_MODE line; attempts collects the non-sensitive
// DB_ATTEMPT_* diagnostics emitted by tiers that failed and fell through;
// version is the devbridge binary version probed in the same exec (#998).
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
  const version = text.match(/^DB_VERSION=(.*)$/m)?.[1]?.trim() ?? '';
  return { authMode, attempts, version };
}
