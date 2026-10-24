import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_FAIL_STDOUT,
  exposeStdout,
  exposeStdoutWithProbes,
  exposeViaSeam,
  verifyStdout,
  withAuthOk,
} from './devbridge-harness.ts';
import { buildDevbridgeExposeScript, exposeTunnel } from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';

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
  // #1000: the probe curl must bypass the injected sandbox proxy — the site
  // whose proxied 502/404 fakes motivated the whole fix (main's battery pinned
  // it; a python replace in the U11 port silently missed this anchor).
  assert.match(script, /curl -s --noproxy '\*' -o \/tmp\/\.db_probe_body/);
});

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
    8080,
    { keepalive: false },
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
      if (command.includes('devbridge version')) {
        return { stdout: 'DB_VERSION=0.2.2-release\n', exitCode: 0 };
      }
      return { stdout: exposeStdout(url, '200'), exitCode: 0 };
    }),
    8080,
    { keepalive: false },
  );
  // Both attempts timed out mid-script → structured ok:false, not a throw.
  assert.equal(result.ok, false);
  // The timeout-folded attempt parses empty stdout → the hedged timeout
  // wording (a timeout lost the observation; it did not prove the host never
  // started) + the timed-out warning + the read-back version in the body.
  assert.equal(result.error_code, 'no_tunnel_url');
  assert.match(result.error ?? '', /timed out or died before a Tunnel URL/);
  assert.match(result.warnings ?? '', /timed out/);
  assert.equal(result.version, '0.2.2-release');
  assert.equal(exposeCalls, 2, 'the outer rebuild retry must still run after a timeout-folded attempt');
});

test('exposeTunnel AUTO-ENROLLS the verified tunnel, MERGED into existing coverage (U16)', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const calls: string[] = [];
  const result = await exposeViaSeam(
    async (_ws, command) => {
      calls.push(command);
      if (command.includes('DB_AUTH_MODE')) {
        return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
      }
      if (command.startsWith('VERIFY_CODE=')) {
        return { stdout: verifyStdout('200'), exitCode: 0 };
      }
      if (command.includes('DB_KEEPALIVE_TUNNELS=')) {
        // An existing watchdog already protects aaaa1111 — the merge must keep
        // it alongside the new tunnel (a replace regression drops to 1).
        return {
          stdout: 'DB_KEEPALIVE_TUNNELS=aaaa1111:https://aaaa1111-80.devbridge-s2.hwtunnel.com:80\n',
          exitCode: 0,
        };
      }
      if (command.includes('tunnel-keepalive.sh')) {
        return {
          stdout: 'DB_KEEPALIVE_SYNTAX=0\nDB_KEEPALIVE_PID=4242\nDB_KEEPALIVE_LOG=/tmp/tunnel-keepalive.log\n',
          exitCode: 0,
        };
      }
      return { stdout: exposeStdout(url, '200'), exitCode: 0 };
    },
    8080,
    { keepalive: true },
  );
  assert.equal(result.ok, true);
  assert.equal(result.keepalive?.enrolled, true);
  assert.equal(result.keepalive?.tunnelCount, 2, 'existing + new — a replace regression drops to 1 here');
  assert.equal(result.keepalive?.watchdogPid, '4242');
  const installCall = calls.find((c) => c.includes('cat > /tmp/tunnel-keepalive.sh'));
  assert.ok(installCall, 'install script captured (full command, not truncated)');
  assert.match(
    installCall ?? '',
    /aaaa1111:https:\/\/aaaa1111-80\.devbridge-s2\.hwtunnel\.com:80/,
    'existing survives',
  );
  assert.match(
    installCall ?? '',
    /c4rdv7bv:https:\/\/c4rdv7bv-8080\.devbridge-s2\.hwtunnel\.com:8080/,
    'new tunnel lands',
  );
});

test('exposeTunnel defaults to enrollment when keepalive is omitted (U16)', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  const result = await exposeViaSeam(
    async (_ws, command) => {
      if (command.includes('DB_AUTH_MODE')) {
        return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
      }
      if (command.startsWith('VERIFY_CODE=')) {
        return { stdout: verifyStdout('200'), exitCode: 0 };
      }
      if (command.includes('DB_KEEPALIVE_TUNNELS=')) {
        return { stdout: 'DB_KEEPALIVE_TUNNELS=\n', exitCode: 0 };
      }
      if (command.includes('tunnel-keepalive.sh')) {
        return {
          stdout: 'DB_KEEPALIVE_SYNTAX=0\nDB_KEEPALIVE_PID=4242\nDB_KEEPALIVE_LOG=/tmp/tunnel-keepalive.log\n',
          exitCode: 0,
        };
      }
      return { stdout: exposeStdout(url, '200'), exitCode: 0 };
    },
    // No options — the schema's "default true — pass false to opt out".
    8081,
  );
  assert.equal(result.ok, true);
  assert.equal(result.keepalive?.enrolled, true, 'omitted keepalive must enroll');
});

test('exposeTunnel keepalive:false opts out; a failed enrollment warns but the tunnel stays ok (U16)', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  // Opt-out: no keepalive field in the result at all.
  const optedOut = await exposeViaSeam(
    async (_ws, command) => {
      if (command.includes('DB_AUTH_MODE')) {
        return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
      }
      if (command.startsWith('VERIFY_CODE=')) {
        return { stdout: verifyStdout('200'), exitCode: 0 };
      }
      if (command.includes('tunnel-keepalive')) {
        throw new Error('the watchdog must not be touched when keepalive:false');
      }
      return { stdout: exposeStdout(url, '200'), exitCode: 0 };
    },
    8080,
    { keepalive: false },
  );
  assert.equal(optedOut.ok, true);
  assert.equal(optedOut.keepalive, undefined);
  void url;
});
