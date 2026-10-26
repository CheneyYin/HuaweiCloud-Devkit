import { DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER } from './devbridge-gateway.ts';
import { stripTerminalEscapes } from './sandbox-output.ts';
import { readDbField } from './devbridge-expose.ts';
import { runOneShot } from './devbridge-exec.ts';

// The fresh-session re-verify family (#919/#922), extracted from
// devbridge-tunnel: the second-exec GET script, its dedicated parser, and the
// persistence verdict. The marker comes from the gateway contract's canonical
// home; the field reader from the expose stdout grammar's.

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

export interface TunnelPersistenceVerdict {
  verifyHttpCode: string;
  verifyNotFound: boolean;
  persistent: boolean;
  warning: string | undefined;
}

// #919: re-verify with a real GET from a SECOND, independent exec session.
// The in-session health check inside the expose script cannot prove the host
// survived session teardown (setsid/nohup/disown make that likely, not
// certain). When the fresh-session GET fails, the URL will die with the
// deploying session — say so explicitly instead of returning a link the
// visitor cannot open. (v2 ordering: the recheck runs only on the usable-URL
// path — a dead URL already failed above it, so no fresh-session call is
// spent proving it.) The warning texts are the flow's verbatim 请勿分享 lines.
export async function verifyTunnelPersistence(
  workspaceId: string,
  tunnelUrl: string,
  username: string,
): Promise<TunnelPersistenceVerdict> {
  let verifyHttpCode = '';
  let verifyNotFound = false;
  try {
    const verifyResult = await runOneShot(workspaceId, buildDevbridgeVerifyScript(tunnelUrl), username, 30000);
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
  let warning: string | undefined;
  if (!persistent) {
    if (verifyNotFound) {
      warning = `复测返回 HTTP ${verifyHttpCode || '???'} 但 body 为 "tunnel not found"（原生假成功形态），访问链接实际未生效，请勿分享 (the recheck answered HTTP ${verifyHttpCode || '???'} with a "tunnel not found" body — the tunnel is NOT serving; do NOT share this URL).`;
    } else if (verifyHttpCode === '') {
      // The verify script always emits a code when it runs (curl prints 000 on
      // transport failure) — an empty code means the recheck exec itself
      // failed. Say that honestly instead of diagnosing the host as dead.
      warning =
        '复测会话执行失败，无法确认访问链接的持久性，请勿分享 (the independent recheck could not run — persistence unverified; treat the URL as non-persistent and do NOT share it).';
    } else {
      warning =
        '访问链接将在会话结束后失效，请勿分享 (the tunnel did NOT survive an independent exec-session recheck — do NOT share this URL; the host process is not persistent).';
    }
  }
  return { verifyHttpCode, verifyNotFound, persistent, warning };
}
