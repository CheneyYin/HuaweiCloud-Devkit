import { stripTerminalEscapes } from './session-manager.ts';
import {
  DEVBRIDGE_HOST_EXPIRY_HOURS,
  evaluateDevbridgeVersion,
  validateExpiryHours,
  validateTunnelPort,
} from './devbridge-validation.ts';
import { runOneShot, type OneShotResult } from './devbridge-exec.ts';
import { buildDevbridgeAuthProbe, parseDevbridgeAuthOutput } from './devbridge-auth.ts';
import {
  buildDevbridgeExposeScript,
  formatTunnelReachabilityWarning,
  parseDevbridgeExposeOutput,
  type ExposeTunnelResult,
} from './devbridge-expose.ts';
import { buildDevbridgeVerifyScript, parseDevbridgeVerifyOutput } from './devbridge-verify.ts';
import {
  buildKeepaliveTunnelsReadScript,
  installKeepaliveWatchdog,
  mergeKeepaliveTunnels,
  parseKeepaliveTunnelsOutput,
  type KeepaliveWatchdogResult,
} from './devbridge-keepalive.ts';

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
// The renew family (script, parser, renewTunnel flow) lives in
// devbridge-renew.ts; re-exported as the public face.
export { buildDevbridgeRenewScript, parseDevbridgeRenewOutput, renewTunnel } from './devbridge-renew.ts';
export type { RenewTunnelResult } from './devbridge-renew.ts';
// The keepalive watchdog family lives in devbridge-keepalive.ts; re-exported
// as the public face.
export {
  buildDevbridgeKeepaliveScript,
  buildKeepaliveTunnelsReadScript,
  installKeepaliveWatchdog,
  mergeKeepaliveTunnels,
  parseKeepaliveTunnelsOutput,
} from './devbridge-keepalive.ts';
export type { KeepaliveTunnel, KeepaliveWatchdogResult } from './devbridge-keepalive.ts';

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
