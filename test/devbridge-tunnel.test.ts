import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import {
  _setOneShotForTests,
  buildDevbridgeAuthProbe,
  buildDevbridgeExposeScript,
  buildDevbridgeVerifyScript,
  DEVBRIDGE_HOST_EXPIRY_HOURS,
  exposeTunnel,
  formatTunnelReachabilityWarning,
  parseDevbridgeAuthOutput,
  parseDevbridgeExposeOutput,
  parseDevbridgeProbeSequence,
  parseDevbridgeVerifyOutput,
  validateTunnelPort,
} from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';

test('D: buildDevbridgeAuthProbe implements the verified waterfall (keyring → AK/SK → file)', () => {
  const script = buildDevbridgeAuthProbe();
  // Tier 1: keyring API Key — stderr capture (2>&1), devbridge_ prefix filter, env self-heal
  assert.match(script, /hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1/);
  assert.match(script, /"devbridge_"\*\)/);
  assert.match(script, /DB_AUTH_MODE=API_KEY_KEYRING/);
  assert.match(script, /DBUS_SESSION_BUS_ADDRESS.*unix:path=\/run\/dbus-session/);
  assert.match(script, /HOME.*:-\/root/);
  // Tier 1 light revive: bus restart + unlocked keyring daemon, no package installs
  assert.match(script, /dbus-daemon --session/);
  assert.match(script, /gnome-keyring-daemon --unlock/);
  assert.ok(!script.includes('dnf install'), 'waterfall must not install packages at runtime');
  // Tier 2: AK/SK — STS token is mandatory (401 APIGW.0301 without it), 0.1.x --huaweicloud is conditional
  assert.match(script, /devbridge auth login --help.*--access-key/s);
  assert.match(script, /--access-key "\$HW_ACCESS_KEY" --secret-key "\$HW_SECRET_KEY"/);
  assert.match(script, /DB_TOKEN_ARGS="--security-token \\"\$HW_SECURITY_TOKEN\\""|DB_TOKEN_ARGS=.*--security-token/);
  assert.match(script, /grep -q -- '--huaweicloud'/);
  assert.match(script, /DB_AUTH_MODE=AKSK_SUPPORTED/);
  // Tier 3: user-provided file fallback
  assert.match(script, /source \/tmp\/hw_creds\.sh/);
  assert.match(script, /source \/tmp\/hw_api_key/);
  assert.match(script, /--api-key "\$HW_API_KEY"/);
  assert.match(script, /DB_AUTH_MODE=API_KEY_FILE/);
  // All tiers verified via real login + auth status; diagnostics emitted; final failure mode
  assert.match(script, /db_login_ok\(\) \{ devbridge auth status.*Logged in/);
  assert.match(script, /DB_ATTEMPT_/);
  assert.match(script, /DB_AUTH_MODE=NO_CREDENTIAL/);
  // Secrets are not left in the environment after the probe
  assert.match(script, /unset HW_DB_KEY HW_API_KEY DB_TOKEN_ARGS/);
});

test('D: parseDevbridgeAuthOutput extracts the final auth mode and per-tier attempt diagnostics', () => {
  const stdout = [
    'DB_ATTEMPT_KEYRING=no-valid-key',
    'DB_ATTEMPT_AKSK=binary-or-creds-unavailable',
    'DB_ATTEMPT_APIKEY_FILE=no-file',
    'DB_AUTH_MODE=NO_CREDENTIAL',
  ].join('\n');
  const parsed = parseDevbridgeAuthOutput(stdout);
  assert.equal(parsed.authMode, 'NO_CREDENTIAL');
  assert.equal(parsed.attempts.KEYRING, 'no-valid-key');
  assert.equal(parsed.attempts.AKSK, 'binary-or-creds-unavailable');
  assert.equal(parsed.attempts.APIKEY_FILE, 'no-file');

  const success = parseDevbridgeAuthOutput('DB_ATTEMPT_KEYRING=no-valid-key\nDB_AUTH_MODE=AKSK_SUPPORTED\n');
  assert.equal(success.authMode, 'AKSK_SUPPORTED');
  assert.equal(success.attempts.KEYRING, 'no-valid-key');
  assert.equal(success.attempts.AKSK, undefined);

  const empty = parseDevbridgeAuthOutput('');
  assert.equal(empty.authMode, '');
  assert.deepEqual(empty.attempts, {});
});

test('D: buildDevbridgeExposeScript starts a session-surviving host with port-anchored URL extraction', () => {
  const script = buildDevbridgeExposeScript(8081);
  assert.match(script, /devbridge delete-all/);
  assert.match(script, /pkill -f "devbridge host"/);
  // #919/#922: setsid-detached launch with the guarded fallback + guarded disown,
  // 72-hour expiry echoed for the expiresAt field.
  assert.match(
    script,
    /if command -v setsid > \/dev\/null 2>&1; then setsid nohup devbridge host -p 8081 -e 72 > \/tmp\/host\.log 2>&1 < \/dev\/null & else nohup devbridge host -p 8081 -e 72 > \/tmp\/host\.log 2>&1 < \/dev\/null & fi/,
  );
  assert.match(script, /^disown 2>\/dev\/null \|\| true$/m);
  assert.doesNotMatch(script, /-e 8\b/);
  // Port-anchored extraction (multi-port hosts print one URL line per port).
  // The domain is derived from the shared constant, not hardcoded.
  assert.ok(
    script.includes('grep -oE "https://[A-Za-z0-9_-]+-8081\\.devbridge-s2\\.hwtunnel\\.com" /tmp/host.log | head -1'),
  );
  assert.match(script, /DB_TUNNEL_URL=/);
  assert.match(script, /DB_HTTP_CODE=/);
  assert.match(script, /DB_EXPIRY_HOURS=72/);
  // First 64 bytes of the probe body feed the exact gateway-error body matching
  // — newlines stripped so an app body can never line-inject later DB_ fields.
  assert.match(script, /DB_TUNNEL_BODY=\$\(head -c 64 \/tmp\/\.db_probe_body 2>\/dev\/null \| tr -d '\\r\\n'\)/);
  assert.match(script, /rm -f \/tmp\/\.db_probe_body/);
  // No `|| echo "000"`: curl's -w already prints 000 on transport failure and
  // exits non-zero, so `|| echo` CONCATENATES a second 000 → "000000", which
  // slips past every '000' sentinel check (review round 1, consensus critical).
  assert.doesNotMatch(script, /\|\| echo "000"/);
  // The default expiry is the 72h constant and is overridable.
  assert.equal(DEVBRIDGE_HOST_EXPIRY_HOURS, 72);
  const custom = buildDevbridgeExposeScript(8081, 8);
  assert.match(custom, /-e 8 /);
  assert.doesNotMatch(custom, /-e 72/);
});

test('D: buildDevbridgeVerifyScript emits a fresh-session GET with the not-found body check', () => {
  const url = 'https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com';
  const script = buildDevbridgeVerifyScript(url);
  assert.ok(script.includes(`curl -s -o /tmp/devbridge_verify_body -w "%{http_code}" --max-time 10 "${url}"`));
  // Exact whole-content body match via tr (CRLF-tolerant) — NOT a grep -q form:
  // command substitution captures stdout, and -q prints none, so the verdict
  // would be stuck at "not found = no" forever (round-2 review critical).
  assert.match(script, /VERIFY_BODY=\$\(tr -d '\\r\\n' < \/tmp\/devbridge_verify_body/);
  assert.match(
    script,
    /if \[ "\$VERIFY_BODY" = 'tunnel not found' \]; then VERIFY_NOT_FOUND=1; else VERIFY_NOT_FOUND=0; fi/,
  );
  assert.match(script, /DB_VERIFY_HTTP_CODE=\$VERIFY_CODE/);
  assert.match(script, /DB_VERIFY_NOT_FOUND=\$VERIFY_NOT_FOUND/);
  assert.match(script, /rm -f \/tmp\/devbridge_verify_body/);
  // No `|| echo "000"` (same sentinel-doubling defect as the expose script).
  assert.doesNotMatch(script, /\|\| echo "000"/);
  // URL validation before the shell splice: non-https, schemes, and shell
  // metacharacters are rejected.
  for (const bad of [
    '',
    'http://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'https://evil.com"; rm -rf /',
    "https://evil.com'$(pwn)'",
    'ftp://x/y',
  ]) {
    assert.throws(() => buildDevbridgeVerifyScript(bad), /invalid tunnel URL/, `expected rejection for ${bad}`);
  }
  // URL-safe path characters are accepted (the tunnel URLs we build are bare,
  // but the validator must not over-reject ports and paths).
  assert.doesNotThrow(() => buildDevbridgeVerifyScript('https://host.example.com:8443/some/path'));
});

test(
  'D: the verify script body-check executes correctly under /bin/sh (behavioral pin)',
  { skip: process.platform !== 'linux' },
  () => {
    // Round-2 review found the grammar pin one-directional: a `grep -q` form
    // emitted nothing and the not-found verdict was dead code in production
    // while the suite stayed green. This pin EXECUTES the real script's body
    // logic through /bin/sh (curl stubbed, body file redirected into a
    // registered fixture dir) and parses the emitted keys with the product
    // parser — the behavior, not just the shape, is pinned. Linux-only: the CI
    // test matrix includes windows-latest, where /bin/sh does not resolve.
    const dir = fixtureDir('dbverify-');
    const bodyFile = join(dir, 'devbridge_verify_body');
    const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
    const runWithBody = (body: string | null) => {
      if (body === null) {
        writeFileSync(bodyFile, '');
      } else {
        writeFileSync(bodyFile, body);
      }
      const script = buildDevbridgeVerifyScript(url)
        .replace(/^VERIFY_CODE=.*$/m, 'VERIFY_CODE=200')
        .replaceAll('/tmp/devbridge_verify_body', bodyFile);
      return parseDevbridgeVerifyOutput(execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }));
    };
    // The live gateway form (LF).
    assert.equal(runWithBody('tunnel not found\n').notFound, true);
    // CRLF form compares equal (tr strips \r).
    assert.equal(runWithBody('tunnel not found\r\n').notFound, true);
    // Case-sensitive doctrine: the gateway serves lowercase.
    assert.equal(runWithBody('TUNNEL NOT FOUND\n').notFound, false);
    // An app page that merely MENTIONS the phrase never trips the verdict.
    assert.equal(runWithBody('<html>Docs: handling tunnel not found errors</html>\n').notFound, false);
    // Healthy body / empty body.
    assert.equal(runWithBody('hello from the app\n').notFound, false);
    assert.equal(runWithBody(null).notFound, false);
  },
);

test('D: parseDevbridgeVerifyOutput reads the dedicated DB_VERIFY_* keys', () => {
  const parsed = parseDevbridgeVerifyOutput('DB_VERIFY_HTTP_CODE=200\nDB_VERIFY_NOT_FOUND=0\n');
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.notFound, false);
  const notFound = parseDevbridgeVerifyOutput('DB_VERIFY_HTTP_CODE=200\nDB_VERIFY_NOT_FOUND=1\n');
  assert.equal(notFound.httpCode, '200');
  assert.equal(notFound.notFound, true);
  // The script emits 0/1 through the exact-body if/else; a missing field
  // (exec died before emitting) must not read as found.
  const zero = parseDevbridgeVerifyOutput('DB_VERIFY_HTTP_CODE=404\nDB_VERIFY_NOT_FOUND=0\n');
  assert.equal(zero.notFound, false);
  const empty = parseDevbridgeVerifyOutput('');
  assert.equal(empty.httpCode, '');
  assert.equal(empty.notFound, false);
  // #946: OSC/CSI escapes and \r must not blind the anchored lookups. The
  // assertion is non-vacuous: the ?2026h-prefixed line carries a NON-default
  // value (HTTP 404) — a stripper gap that blinds the lookup fails here,
  // instead of silently reading the field's default.
  const noisy = parseDevbridgeVerifyOutput(
    '\x1b[?2026hDB_VERIFY_HTTP_CODE=404\r\n\x1b]133;C\x07DB_VERIFY_NOT_FOUND=1\r\n',
  );
  assert.equal(noisy.httpCode, '404', 'private-mode CSI (?2026h) must be stripped');
  assert.equal(noisy.notFound, true, 'OSC-prefixed field must be stripped and read');
});

test('D: parseDevbridgeExposeOutput extracts the full field set from a healthy expose', () => {
  const stdout = [
    'DB_HOST_LOG=',
    'some log line',
    'Tunnel URL: https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'DB_PROBE_1=502',
    'DB_PROBE_2=200',
    'DB_TUNNEL_URL=https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'DB_HTTP_CODE=200',
    'DB_EXPIRY_HOURS=72',
    'DB_TUNNEL_BODY=',
    'DB_QUOTA_ERROR=0',
  ].join('\n');
  assert.deepEqual(parseDevbridgeExposeOutput(stdout), {
    tunnelUrl: 'https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    httpCode: '200',
    quotaError: false,
    tunnelId: 'c4rdv7bv',
    expiryHours: 72,
    gatewayTunnelError: false,
    badGateway: false,
    migration: false,
    probes: [
      { attempt: 1, httpCode: '502' },
      { attempt: 2, httpCode: '200' },
    ],
  });
});

// A2 (#935): the in-script probe retry loop — the LAST probe decides
// reachability; intermediate 502/000 probes are gateway-not-ready noise.
test('parseDevbridgeProbeSequence takes the final probe as the verdict (#935 A2)', () => {
  const { probes, finalHttpCode } = parseDevbridgeProbeSequence(
    ['DB_PROBE_1=502', 'DB_PROBE_2=000', 'DB_PROBE_3=200', 'DB_HTTP_CODE=200'].join('\n'),
  );
  assert.equal(probes.length, 3);
  assert.equal(probes[0]!.httpCode, '502');
  assert.equal(probes[1]!.httpCode, '000');
  assert.equal(probes[2]!.httpCode, '200');
  // The final verdict comes from the LAST probe, not the first.
  assert.equal(finalHttpCode, '200');
});

test('a 502/000 → 200 probe sequence produces NO reachability warning (#935 A2)', () => {
  // Regression from report 2 problem 8: the old single-shot check warned
  // "Tunnel reachable check returned HTTP (expected 200/304)" while the same
  // log showed DB_HTTP_CODE=200 and a manual retry returned 200.
  const { finalHttpCode } = parseDevbridgeProbeSequence(
    ['DB_PROBE_1=502', 'DB_PROBE_2=000', 'DB_PROBE_3=200', 'DB_HTTP_CODE=200'].join('\n'),
  );
  assert.equal(formatTunnelReachabilityWarning(finalHttpCode), undefined);
});

test('a final non-200/304 probe still surfaces the reachability warning (#935 A2)', () => {
  const warning = formatTunnelReachabilityWarning('502');
  assert.match(warning ?? '', /HTTP 502/);
  assert.match(warning ?? '', /expected 200\/304/);
  assert.equal(formatTunnelReachabilityWarning('000'), formatTunnelReachabilityWarning(''));
  assert.match(formatTunnelReachabilityWarning('') ?? '', /HTTP 000/);
  // 304 is a success-equivalent (cached response) — no warning.
  assert.equal(formatTunnelReachabilityWarning('304'), undefined);
});

test('the expose script carries the A2 probe retry loop with last-probe verdict (#935 A2)', () => {
  const script = buildDevbridgeExposeScript(8080);
  // URL extraction is a bounded re-grep loop, not a flat settle sleep.
  assert.doesNotMatch(script, /sleep 12/, 'the fixed 12s settle must not return (bounded re-grep replaced it)');
  assert.match(script, /TUNNEL_URL=""/);
  assert.match(script, /for i in 1 2 3 4; do/);
  assert.match(script, /DB_PROBE_\$i=\$HTTP_CODE/);
  assert.match(script, /if \[ "\$HTTP_CODE" = "200" \] \|\| \[ "\$HTTP_CODE" = "304" \]/);
  assert.match(script, /if \[ "\$i" != "4" \]; then sleep 5; fi/);
  // The final code IS the loop variable — the "last probe decides" wiring.
  assert.match(script, /DB_HTTP_CODE=\$HTTP_CODE/);
});

test('parseDevbridgeProbeSequence strips OSC/CSI noise from probe lines (#946 + #935 A2)', () => {
  const noisy = parseDevbridgeProbeSequence(
    '\x1b[?2026hDB_PROBE_1=502\r\n\x1b]133;C\x07DB_PROBE_2=200\r\nDB_HTTP_CODE=200',
  );
  assert.equal(noisy.probes.length, 2, 'escape-wrapped probe lines must parse');
  assert.equal(noisy.finalHttpCode, '200');
});

test('D: parseDevbridgeExposeOutput classifies gateway-level tunnel errors by exact body + status', () => {
  // 404 "tunnel not found" — the gateway itself reports the tunnel dead.
  const notFound = parseDevbridgeExposeOutput(
    [
      'DB_TUNNEL_URL=https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
      'DB_HTTP_CODE=404',
      'DB_TUNNEL_BODY=tunnel not found',
      'DB_QUOTA_ERROR=0',
    ].join('\n'),
  );
  assert.equal(notFound.gatewayTunnelError, true);
  assert.equal(notFound.badGateway, false);
  // 404 "port not configured" — same family.
  const portMissing = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=port not configured', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(portMissing.gatewayTunnelError, true);
  // 502 "bad gateway" — tunnel alive, local service down.
  const badGateway = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=502', 'DB_TUNNEL_BODY=bad gateway', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(badGateway.gatewayTunnelError, false);
  assert.equal(badGateway.badGateway, true);
  // The app's own 404/502 pages are NEVER misjudged: different body, or the
  // right body under the wrong status.
  const appNotFound = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=<html>404 Not Found</html>', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(appNotFound.gatewayTunnelError, false);
  const bodyUnderWrongStatus = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=200', 'DB_TUNNEL_BODY=tunnel not found', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(bodyUnderWrongStatus.gatewayTunnelError, false);
  const notFoundUnder500 = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=500', 'DB_TUNNEL_BODY=tunnel not found', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(notFoundUnder500.gatewayTunnelError, false);
  // A longer body (truncated at 64 bytes) that merely CONTAINS the marker is
  // not the exact text/plain form.
  const padded = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=tunnel not found — please retry later', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(padded.gatewayTunnelError, false);
});

test('LIVE FIXTURE (s2 gateway, 2026-10-21): 404 "tunnel not found" body is the exact text/plain form', () => {
  // Captured live against devbridge-s2.hwtunnel.com (nonexistent tunnel id):
  //   HTTP 404, Content-Type text/plain; charset=utf-8, raw body bytes
  //   "tunnel not found\n" (17 bytes). In the expose script the value reaches
  //   the parser as `DB_TUNNEL_BODY=tunnel not found` — the $(head -c 64 …)
  //   command substitution strips the trailing newline, and the ^KEY=(.*)$
  //   regex could never capture one anyway. `.trim()` is load-bearing for
  //   leading/trailing WHITESPACE forms (see below); the \r\n|\r→\n
  //   normalization handles carriage returns; the shell-side probes strip
  //   \r/\n with tr so CRLF gateway forms compare equal there too.
  const live = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=tunnel not found', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(live.gatewayTunnelError, true, 'the live gateway form must classify as a gateway error');
  // Whitespace-padded body: readDbField's .trim() is what makes this classify.
  const padded = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=  tunnel not found  ', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(padded.gatewayTunnelError, true);
  // The same body under a non-404 status stays unclassified (status gating).
  const wrongStatus = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=200', 'DB_TUNNEL_BODY=tunnel not found', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(wrongStatus.gatewayTunnelError, false);
});

test('D: parseDevbridgeExposeOutput flags quota error 10006', () => {
  const stdout = ['DB_TUNNEL_URL=', 'DB_HTTP_CODE=000', 'DB_QUOTA_ERROR=1', 'tail: 10006 quota exceeded'].join('\n');
  const parsed = parseDevbridgeExposeOutput(stdout);
  assert.equal(parsed.quotaError, true);
  assert.equal(parsed.tunnelUrl, '');
});

test('D: quota and migration verdicts are count-robust (grep -c line counts, not booleans)', () => {
  // grep -c prints the number of matching LINES — a retrying host can log the
  // marker several times; `=== '1'` parsing would silently flip the verdict.
  const quotaTwice = parseDevbridgeExposeOutput('DB_QUOTA_ERROR=2\nDB_MIGRATION=0\n');
  assert.equal(quotaTwice.quotaError, true);
  const migrationTwice = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=200', 'DB_MIGRATION=2', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(migrationTwice.migration, true);
  // Zero and missing fields stay negative.
  assert.equal(parseDevbridgeExposeOutput('DB_QUOTA_ERROR=0\nDB_MIGRATION=0\n').quotaError, false);
  assert.equal(parseDevbridgeExposeOutput('DB_QUOTA_ERROR=\nDB_MIGRATION=\n').migration, false);
});

test('D: the flattened probe body cannot spoof verdicts (tr strips newlines script-side)', () => {
  // The script echoes DB_TUNNEL_BODY with \r/\n stripped, so an app body whose
  // first 64 bytes contain "tunnel not found\nDB_MIGRATION=1" arrives as ONE
  // flat value — no second line exists to spoof the migration verdict, and the
  // flat value no longer equals the exact marker.
  const spoof = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=tunnel not foundDB_MIGRATION=1', 'DB_QUOTA_ERROR=0', 'DB_MIGRATION=0'].join(
      '\n',
    ),
  );
  assert.equal(spoof.gatewayTunnelError, false);
  assert.equal(spoof.migration, false);
  // A multi-line app 404 whose FIRST line is the marker also fails the exact
  // match once flattened (the continuation bytes are part of the value).
  const multiLine = parseDevbridgeExposeOutput(
    ['DB_HTTP_CODE=404', 'DB_TUNNEL_BODY=tunnel not found<html>…', 'DB_QUOTA_ERROR=0'].join('\n'),
  );
  assert.equal(multiLine.gatewayTunnelError, false);
});

test('D: parseDevbridgeExposeOutput tolerates empty host log (no tunnel yet)', () => {
  const parsed = parseDevbridgeExposeOutput('DB_HOST_LOG=\nDB_TUNNEL_URL=\nDB_HTTP_CODE=\nDB_QUOTA_ERROR=0');
  assert.equal(parsed.tunnelUrl, '');
  assert.equal(parsed.httpCode, '');
  assert.equal(parsed.tunnelId, '');
  assert.equal(parsed.expiryHours, undefined);
});

test('D: parseDevbridgeExposeOutput and the auth parser survive OSC/CSI-wrapped output (#946)', () => {
  // Integration-enabled shells wrap EVERY line in OSC 133 markers — without
  // stripping, every anchored ^DB_ lookup comes back empty and a good tunnel
  // reads as missing.
  const noisy = [
    '\x1b]133;C\x07DB_TUNNEL_URL=https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com\r',
    '\x1b]133;C\x07DB_HTTP_CODE=200\r',
    '\x1b]133;C\x07DB_EXPIRY_HOURS=72\r',
    '\x1b]133;C\x07DB_QUOTA_ERROR=0\r',
  ].join('\n');
  const parsed = parseDevbridgeExposeOutput(noisy);
  assert.equal(parsed.tunnelUrl, 'https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com');
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.expiryHours, 72);
  const noisyAuth = parseDevbridgeAuthOutput(
    '\x1b]133;C\x07DB_ATTEMPT_KEYRING=no-valid-key\r\n\x1b]133;C\x07DB_AUTH_MODE=AKSK_SUPPORTED\r\n',
  );
  assert.equal(noisyAuth.authMode, 'AKSK_SUPPORTED');
  assert.equal(noisyAuth.attempts.KEYRING, 'no-valid-key');
});

test('P1: validateTunnelPort accepts integer ports in range', () => {
  assert.equal(validateTunnelPort(8080), 8080);
  assert.equal(validateTunnelPort('8081'), 8081);
  assert.equal(validateTunnelPort(1), 1);
  assert.equal(validateTunnelPort(65535), 65535);
});

test('P1: validateTunnelPort rejects strings, decimals, and out-of-range ports (shell-injection guard)', () => {
  for (const bad of ['80;rm -rf /', 'abc', '', null, undefined, 0, -1, 65536, 1.5, '8080;true']) {
    assert.throws(() => validateTunnelPort(bad), /invalid port/, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

// ── exposeTunnel control flow (via the one-shot seam) ──────────────────────

const AUTH_FAIL_STDOUT = 'DB_ATTEMPT_KEYRING=no-valid-key\nDB_AUTH_MODE=NO_CREDENTIAL\n';

function exposeStdout(url: string, httpCode: string, quota = '0', body = '', expiry = '72', migration = '0'): string {
  return [
    'DB_HOST_LOG=',
    url ? `Tunnel URL: ${url}` : '',
    `DB_TUNNEL_URL=${url}`,
    `DB_HTTP_CODE=${httpCode}`,
    `DB_EXPIRY_HOURS=${expiry}`,
    `DB_TUNNEL_BODY=${body}`,
    `DB_QUOTA_ERROR=${quota}`,
    `DB_MIGRATION=${migration}`,
  ].join('\n');
}

// A2 (#935): probe-laden expose stdout — the reported regression (#935
// report 2 problem 8) fired a reachability warning while the final probe (and
// DB_HTTP_CODE) said 200; the composition through exposeTunnel must not.
function exposeStdoutWithProbes(url: string, probes: string[], httpCode: string): string {
  return [
    'DB_HOST_LOG=',
    `Tunnel URL: ${url}`,
    ...probes.map((code, i) => `DB_PROBE_${i + 1}=${code}`),
    `DB_TUNNEL_URL=${url}`,
    `DB_HTTP_CODE=${httpCode}`,
    'DB_EXPIRY_HOURS=72',
    'DB_TUNNEL_BODY=',
    'DB_QUOTA_ERROR=0',
  ].join('\n');
}

// The auth-branch boilerplate shared by the A2 seam tests — the pre-existing
// seam tests carry their own baselined copies of this shape.
function withAuthOk(delegate: (command: string) => { stdout: string; exitCode: number }): OneShotSeam {
  return async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    return delegate(command);
  };
}

function verifyStdout(httpCode: string, notFound = '0'): string {
  return `DB_VERIFY_HTTP_CODE=${httpCode}\nDB_VERIFY_NOT_FOUND=${notFound}\n`;
}

type OneShotSeam = NonNullable<Parameters<typeof _setOneShotForTests>[0]>;

// Drive exposeTunnel under a one-shot seam with guaranteed teardown — every
// control-flow test composes its matcher and asserts on the result.
async function exposeViaSeam(seam: OneShotSeam, port: number | string = 8080) {
  _setOneShotForTests(seam);
  try {
    return await exposeTunnel('ws-1', { port });
  } finally {
    _setOneShotForTests(null);
  }
}

// A seam matcher for the healthy path: auth → expose (200) → verify (200).
// `exposeBody` overrides the probe body echoed in DB_TUNNEL_BODY (app content).
function healthyOneShot(url: string, verify: string = verifyStdout('200'), exposeBody = ''): OneShotSeam {
  return async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    if (command.startsWith('VERIFY_CODE=')) {
      return { stdout: verify, exitCode: 0 };
    }
    return { stdout: exposeStdout(url, '200', '0', exposeBody), exitCode: 0 };
  };
}

// Wrap a seam matcher with first-40-char call recording for order assertions.
function recordingSeam(base: OneShotSeam): { seam: OneShotSeam; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    seam: (ws, command, user, timeout) => {
      calls.push(command.slice(0, 40));
      return base(ws, command, user, timeout);
    },
  };
}

test('exposeTunnel returns the auth-fail envelope with attempts and a truncated loginOutput', async () => {
  const result = await exposeViaSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: AUTH_FAIL_STDOUT, exitCode: 0 };
    }
    throw new Error('unexpected expose call after auth failure');
  });
  assert.equal(result.ok, false);
  assert.equal(result.authMode, 'NO_CREDENTIAL');
  assert.equal(result.attempts?.KEYRING, 'no-valid-key');
  assert.match(result.hint ?? '', /huaweicloud_sandbox_credentials/);
  assert.match(result.loginOutput ?? '', /DB_AUTH_MODE=NO_CREDENTIAL/);
  assert.ok((result.loginOutput ?? '').length <= 400);
});

test('exposeTunnel returns ok:true with the publicUrl on a healthy attempt, verified from a second session', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const result = await exposeViaSeam(healthyOneShot(url));
  assert.equal(result.ok, true);
  assert.equal(result.publicUrl, url);
  assert.equal(result.tunnelId, 'c4rdv7bv');
  assert.equal(result.authMode, 'API_KEY_KEYRING');
  assert.equal(result.httpCode, '200');
  assert.equal(result.port, 8080);
  // #919: the fresh-session recheck fields.
  assert.equal(result.verifyHttpCode, '200');
  assert.equal(result.verifyNotFound, undefined);
  assert.equal(result.persistent, true);
  assert.equal(result.expiresInHours, 72);
  assert.ok(result.expiresAt, 'expiresAt must be present when DB_EXPIRY_HOURS echoed');
  assert.equal(result.warnings, undefined);
});

test('#919: a URL that fails the fresh-session recheck is flagged non-persistent with the 请勿分享 warning', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const result = await exposeViaSeam(healthyOneShot(url, verifyStdout('000')));
  assert.equal(result.ok, true);
  assert.equal(result.publicUrl, url);
  assert.equal(result.verifyHttpCode, '000');
  assert.equal(result.persistent, false);
  assert.match(result.warnings ?? '', /访问链接将在会话结束后失效，请勿分享/);
  assert.match(result.warnings ?? '', /do NOT share this URL/);
});

test('#922 B2: HTTP 200 with a "tunnel not found" body (native false-success) is non-persistent', async () => {
  const result = await exposeViaSeam(
    healthyOneShot('https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com', verifyStdout('200', '1')),
  );
  assert.equal(result.ok, true);
  assert.equal(result.verifyHttpCode, '200');
  assert.equal(result.verifyNotFound, true);
  assert.equal(result.persistent, false);
  // The warning reports the ACTUAL recheck status (interpolated, not hardcoded).
  assert.match(result.warnings ?? '', /复测返回 HTTP 200/);
  assert.match(result.warnings ?? '', /原生假成功形态/);
  assert.match(result.warnings ?? '', /do NOT share this URL/);
});

test('#919 primary death mode: a 404 verify with the not-found body is non-persistent, status honestly reported', async () => {
  // The host died between expose and verify → the fresh-session GET answers
  // 404 "tunnel not found". persistent must be false and the warning must say
  // HTTP 404 (the real status), never a hardcoded 200.
  const result = await exposeViaSeam(
    healthyOneShot('https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com', verifyStdout('404', '1')),
  );
  assert.equal(result.ok, true);
  assert.equal(result.verifyHttpCode, '404');
  assert.equal(result.verifyNotFound, true);
  assert.equal(result.persistent, false);
  assert.match(result.warnings ?? '', /复测返回 HTTP 404/);
  assert.doesNotMatch(result.warnings ?? '', /复测返回 HTTP 200/);
  assert.match(result.warnings ?? '', /do NOT share this URL/);
});

test('#919: a verify exec that throws degrades to non-persistent (best-effort recheck)', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const result = await exposeViaSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=AKSK_SUPPORTED\n', exitCode: 0 };
    }
    if (command.startsWith('VERIFY_CODE=')) {
      throw new Error('fresh session died');
    }
    return { stdout: exposeStdout(url, '200'), exitCode: 0 };
  });
  assert.equal(result.ok, true);
  assert.equal(result.verifyHttpCode, undefined);
  assert.equal(result.persistent, false);
  assert.match(result.warnings ?? '', /请勿分享/);
});

test('gateway 404 "tunnel not found" retries once, then returns ok:false — never a soft warning', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const { calls, seam } = recordingSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_FILE\n', exitCode: 0 };
    }
    if (command.startsWith('VERIFY_CODE=')) {
      return { stdout: verifyStdout('404'), exitCode: 0 };
    }
    // Every expose attempt: the gateway itself reports the tunnel dead.
    return { stdout: exposeStdout(url, '404', '0', 'tunnel not found'), exitCode: 0 };
  });
  const result = await exposeViaSeam(seam);
  assert.equal(result.ok, false);
  assert.equal(result.publicUrl, undefined);
  assert.match(result.error ?? '', /gateway reports the fresh tunnel URL as dead/);
  assert.match(result.error ?? '', /tunnel not found/);
  assert.equal(result.httpCode, '404');
  // auth → expose (404) → cleanup → expose (404) → ok:false; no verify is spent.
  assert.equal(calls.length, 4);
});

test('502 "bad gateway" retries once for a slow app start, then reports ok:true with the bad-gateway warning', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  let exposeCount = 0;
  const result = await exposeViaSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    if (command.startsWith('VERIFY_CODE=')) {
      return { stdout: verifyStdout('502'), exitCode: 0 };
    }
    if (command.includes('nohup devbridge host')) {
      exposeCount += 1;
    }
    return { stdout: exposeStdout(url, '502', '0', 'bad gateway'), exitCode: 0 };
  });
  // 502 exact-body = tunnel alive, service down → retry (slow start), then
  // hand the URL over with the explicit bad-gateway warning (main semantics).
  assert.equal(exposeCount, 2);
  assert.equal(result.ok, true);
  assert.equal(result.publicUrl, url);
  assert.match(result.warnings ?? '', /gateway reports "bad gateway"/);
  assert.match(result.warnings ?? '', /local service on the exposed port is not serving/);
  assert.equal(result.persistent, true, 'the 502 verify code means the tunnel itself is alive');
});

test('v2 deviation: a final unreachable attempt returns ok:false, never ok:true with a dead URL', async () => {
  // Attempt 1: unreachable → cleanup + retry; attempt 2: still unreachable →
  // ok:false (main returned ok:true with publicUrl undefined + HTTP 000).
  const { calls, seam } = recordingSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=AKSK_SUPPORTED\n', exitCode: 0 };
    }
    if (command.includes('nohup devbridge host')) {
      return { stdout: exposeStdout('', '000'), exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 }; // cleanup call
  });
  const result = await exposeViaSeam(seam);
  assert.equal(result.ok, false);
  assert.equal(result.publicUrl, undefined);
  assert.equal(result.httpCode, '000');
  assert.match(result.error ?? '', /no reachable public URL/);
  // auth → expose (attempt 1) → cleanup → expose (attempt 2)
  assert.equal(calls.length, 4);
  assert.ok(calls[1]!.includes('pkill -f "devbridge host"'));
  assert.ok(calls[3]!.includes('pkill -f "devbridge host"'));
});

test('v2 deviation: a migrated-gateway placeholder (HTTP 200 + dead URL) is unusable', async () => {
  // The host log carries the migration marker (DB_MIGRATION=1, script-side
  // grep of /tmp/host.log) and the gateway serves the placeholder with HTTP
  // 200 — probe_tunnel treats that as unreachable, and so must the final
  // attempt. An APP body merely containing the marker never trips this (the
  // verdict is field-scoped to the host log, never the echoed probe body).
  const deadUrl = 'https://c4rdv7bv-8080.old-bridge.hwtunnel.com';
  const result = await exposeViaSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    // Marker logged twice (retrying host) — count-robust parsing must still
    // classify it as migration, not silently read count 2 as "no".
    return { stdout: exposeStdout(deadUrl, '200', '0', '', '72', '2'), exitCode: 0 };
  });
  assert.equal(result.ok, false);
  assert.equal(result.publicUrl, undefined);
  assert.match(result.error ?? '', /migration placeholder/);
  assert.equal(result.httpCode, '200');
});

test('an app body that merely contains the migration marker is NOT a migration placeholder', async () => {
  // The probe body echo (DB_TUNNEL_BODY) is app content — a Chinese app page
  // legitimately containing 服务已迁移 in its first bytes must not be
  // misdiagnosed as a retired pre-migration gateway URL.
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const appMarker = await exposeViaSeam(healthyOneShot(url, verifyStdout('200'), '欢迎！本服务已迁移到新域名。'));
  assert.equal(appMarker.ok, true);
  assert.equal(appMarker.publicUrl, url);
  assert.equal(appMarker.persistent, true);
  assert.equal(appMarker.warnings, undefined);
});

test('quota (10006) on the final attempt also returns ok:false with the quota warning', async () => {
  const { calls, seam } = recordingSeam(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_FILE\n', exitCode: 0 };
    }
    // Both attempts report quota exhausted and an unreachable URL.
    return { stdout: exposeStdout('', '000', '1') + '\n10006 quota exceeded', exitCode: 0 };
  });
  const result = await exposeViaSeam(seam, '8081');
  assert.equal(result.ok, false);
  assert.match(result.warnings ?? '', /10006/);
  assert.equal(result.port, 8081);
  assert.equal(calls.length, 3); // auth → expose ×2 (no cleanup between quota retries)
});

test('exposeTunnel requires workspace_id and a valid port', async () => {
  await assert.rejects(exposeTunnel('', { port: 8080 }), /workspace_id is required/);
  await assert.rejects(exposeTunnel('ws-1', { port: '80;rm -rf /' }), /invalid port/);
});

test('A2: probe noise (502/000 → 200) through exposeTunnel yields NO reachability warning (#935 A2)', async () => {
  // The reported production failure: single-shot check warned while the same
  // log showed DB_HTTP_CODE=200. The final probe decides; intermediate noise
  // must not leak into the tool's verdict, and the 200 path stays warning-free.
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const result = await exposeViaSeam(
    withAuthOk((command) =>
      command.startsWith('VERIFY_CODE=')
        ? { stdout: verifyStdout('200'), exitCode: 0 }
        : { stdout: exposeStdoutWithProbes(url, ['502', '000', '200'], '200'), exitCode: 0 },
    ),
  );
  assert.equal(result.ok, true);
  assert.equal(result.warnings, undefined, 'probe noise absorbed by the final 200 must not warn');
});

test('A2: an expose-exec timeout folds into the unreachable envelope, never a raw throw (#935 A2 budget guard)', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  let exposeCalls = 0;
  const result = await exposeViaSeam(
    withAuthOk((command) => {
      if (command.includes('DB_PROBE_$i') || command.includes('DB_HTTP_CODE')) {
        exposeCalls += 1;
        throw new Error('ws-exec timeout (124)');
      }
      return { stdout: exposeStdout(url, '200'), exitCode: 0 };
    }),
  );
  // Both attempts timed out mid-script → structured ok:false, not a throw.
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no reachable public URL after retries/);
  assert.match(result.warnings ?? '', /timed out/);
  assert.equal(exposeCalls, 2, 'the outer rebuild retry must still run after a timeout-folded attempt');
});
