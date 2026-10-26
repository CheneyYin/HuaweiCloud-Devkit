import { DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER } from './devbridge-gateway.ts';
import { stripTerminalEscapes } from './sandbox-output.ts';
import { readDbField } from './devbridge-expose.ts';

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
