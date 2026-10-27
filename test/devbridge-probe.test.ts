import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _setOneShotForTests,
  formatTunnelReachabilityWarning,
  parseDevbridgeExposeOutput,
  parseDevbridgeProbeSequence,
} from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';
import { exposeStdout, exposeViaSeam, verifyStdout } from './devbridge-harness.ts';

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

test('parseDevbridgeProbeSequence strips OSC/CSI noise from probe lines (#946 + #935 A2)', () => {
  const noisy = parseDevbridgeProbeSequence(
    '\x1b[?2026hDB_PROBE_1=502\r\n\x1b]133;C\x07DB_PROBE_2=200\r\nDB_HTTP_CODE=200',
  );
  assert.equal(noisy.probes.length, 2, 'escape-wrapped probe lines must parse');
  assert.equal(noisy.finalHttpCode, '200');
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

test('502 "bad gateway" retries once for a slow app start, then reports ok:true with the bad-gateway warning', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  let exposeCount = 0;
  const result = await exposeViaSeam(
    async (_ws, command) => {
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
    },
    8080,
    { keepalive: false },
  );
  // 502 exact-body = tunnel alive, service down → retry (slow start), then
  // hand the URL over with the explicit bad-gateway warning (main semantics).
  assert.equal(exposeCount, 2);
  assert.equal(result.ok, true);
  assert.equal(result.publicUrl, url);
  assert.match(result.warnings ?? '', /gateway reports "bad gateway"/);
  assert.match(result.warnings ?? '', /local service on the exposed port is not serving/);
  assert.equal(result.persistent, true, 'the 502 verify code means the tunnel itself is alive');
});
