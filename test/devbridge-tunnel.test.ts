import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _setOneShotForTests,
  buildDevbridgeAuthProbe,
  buildDevbridgeExposeScript,
  exposeTunnel,
  parseDevbridgeAuthOutput,
  parseDevbridgeExposeOutput,
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

test('D: buildDevbridgeExposeScript binds the host to the caller-provided port', () => {
  const script = buildDevbridgeExposeScript(8081);
  assert.match(script, /devbridge host -p 8081 -e 8/);
  assert.match(script, /devbridge delete-all/);
  assert.match(script, /pkill -f "devbridge host"/);
  assert.match(script, /sed -n 's\/\.\*Tunnel URL: \*\/\/p' \/tmp\/host\.log/);
  assert.match(script, /DB_TUNNEL_URL=/);
  assert.match(script, /DB_HTTP_CODE=/);
});

test('D: parseDevbridgeExposeOutput extracts tunnel URL, id, HTTP code, and quota flag', () => {
  const stdout = [
    'DB_HOST_LOG=',
    'some log line',
    'Tunnel URL: https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'DB_TUNNEL_URL=https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com',
    'DB_HTTP_CODE=200',
    'DB_QUOTA_ERROR=0',
  ].join('\n');
  const parsed = parseDevbridgeExposeOutput(stdout);
  assert.equal(parsed.tunnelUrl, 'https://c4rdv7bv-8081.devbridge-s2.hwtunnel.com');
  assert.equal(parsed.tunnelId, 'c4rdv7bv');
  assert.equal(parsed.httpCode, '200');
  assert.equal(parsed.quotaError, false);
});

test('D: parseDevbridgeExposeOutput flags quota error 10006', () => {
  const stdout = ['DB_TUNNEL_URL=', 'DB_HTTP_CODE=000', 'DB_QUOTA_ERROR=1', 'tail: 10006 quota exceeded'].join('\n');
  const parsed = parseDevbridgeExposeOutput(stdout);
  assert.equal(parsed.quotaError, true);
  assert.equal(parsed.tunnelUrl, '');
});

test('D: parseDevbridgeExposeOutput tolerates empty host log (no tunnel yet)', () => {
  const parsed = parseDevbridgeExposeOutput('DB_HOST_LOG=\nDB_TUNNEL_URL=\nDB_HTTP_CODE=\nDB_QUOTA_ERROR=0');
  assert.equal(parsed.tunnelUrl, '');
  assert.equal(parsed.httpCode, '');
  assert.equal(parsed.tunnelId, '');
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

function exposeStdout(url: string, httpCode: string, quota = '0'): string {
  return [
    'DB_HOST_LOG=',
    url ? `Tunnel URL: ${url}` : '',
    `DB_TUNNEL_URL=${url}`,
    `DB_HTTP_CODE=${httpCode}`,
    `DB_QUOTA_ERROR=${quota}`,
  ].join('\n');
}

test('exposeTunnel returns the auth-fail envelope with attempts and a truncated loginOutput', async () => {
  _setOneShotForTests(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: AUTH_FAIL_STDOUT, exitCode: 0 };
    }
    throw new Error('unexpected expose call after auth failure');
  });
  try {
    const result = await exposeTunnel('ws-1', { port: 8080 });
    assert.equal(result.ok, false);
    assert.equal(result.authMode, 'NO_CREDENTIAL');
    assert.equal(result.attempts?.KEYRING, 'no-valid-key');
    assert.match(result.hint ?? '', /huaweicloud_sandbox_credentials/);
    assert.match(result.loginOutput ?? '', /DB_AUTH_MODE=NO_CREDENTIAL/);
    assert.ok((result.loginOutput ?? '').length <= 400);
  } finally {
    _setOneShotForTests(null);
  }
});

test('exposeTunnel returns ok:true with the publicUrl on a healthy attempt', async () => {
  const url = 'https://c4rdv7bv-8080.devbridge-s2.hwtunnel.com';
  _setOneShotForTests(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    return { stdout: exposeStdout(url, '200'), exitCode: 0 };
  });
  try {
    const result = await exposeTunnel('ws-1', { port: 8080 });
    assert.equal(result.ok, true);
    assert.equal(result.publicUrl, url);
    assert.equal(result.tunnelId, 'c4rdv7bv');
    assert.equal(result.authMode, 'API_KEY_KEYRING');
    assert.equal(result.httpCode, '200');
    assert.equal(result.port, 8080);
  } finally {
    _setOneShotForTests(null);
  }
});

test('v2 deviation: a final unreachable attempt returns ok:false, never ok:true with a dead URL', async () => {
  // Attempt 1: unreachable → cleanup + retry; attempt 2: still unreachable →
  // ok:false (main returned ok:true with publicUrl undefined + HTTP 000).
  const calls: string[] = [];
  _setOneShotForTests(async (_ws, command) => {
    calls.push(command.slice(0, 40));
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=AKSK_SUPPORTED\n', exitCode: 0 };
    }
    if (command.includes('nohup devbridge host')) {
      return { stdout: exposeStdout('', '000'), exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 }; // cleanup call
  });
  try {
    const result = await exposeTunnel('ws-1', { port: 8080 });
    assert.equal(result.ok, false);
    assert.equal(result.publicUrl, undefined);
    assert.equal(result.httpCode, '000');
    assert.match(result.error ?? '', /no reachable public URL/);
    // auth → expose (attempt 1) → cleanup → expose (attempt 2)
    assert.equal(calls.length, 4);
    assert.ok(calls[1]!.includes('pkill -f "devbridge host"'));
    assert.ok(calls[3]!.includes('pkill -f "devbridge host"'));
  } finally {
    _setOneShotForTests(null);
  }
});

test('v2 deviation: a migrated-gateway placeholder (HTTP 200 + dead URL) is unusable', async () => {
  // The pre-migration domain serves a 服务已迁移 placeholder with HTTP 200 —
  // probe_tunnel treats that as unreachable, and so must the final attempt.
  const deadUrl = 'https://c4rdv7bv-8080.old-bridge.hwtunnel.com';
  _setOneShotForTests(async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    return {
      stdout: exposeStdout(deadUrl, '200') + '\n服务已迁移: this domain is retired',
      exitCode: 0,
    };
  });
  try {
    const result = await exposeTunnel('ws-1', { port: 8080 });
    assert.equal(result.ok, false);
    assert.equal(result.publicUrl, undefined);
    assert.match(result.error ?? '', /migration placeholder/);
    assert.equal(result.httpCode, '200');
  } finally {
    _setOneShotForTests(null);
  }
});

test('quota (10006) on the final attempt also returns ok:false with the quota warning', async () => {
  const calls: string[] = [];
  _setOneShotForTests(async (_ws, command) => {
    calls.push(command.slice(0, 40));
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_FILE\n', exitCode: 0 };
    }
    // Both attempts report quota exhausted and an unreachable URL.
    return { stdout: exposeStdout('', '000', '1') + '\n10006 quota exceeded', exitCode: 0 };
  });
  try {
    const result = await exposeTunnel('ws-1', { port: '8081' });
    assert.equal(result.ok, false);
    assert.match(result.warnings ?? '', /10006/);
    assert.equal(result.port, 8081);
    assert.equal(calls.length, 3); // auth → expose ×2 (no cleanup between quota retries)
  } finally {
    _setOneShotForTests(null);
  }
});

test('exposeTunnel requires workspace_id and a valid port', async () => {
  await assert.rejects(exposeTunnel('', { port: 8080 }), /workspace_id is required/);
  await assert.rejects(exposeTunnel('ws-1', { port: '80;rm -rf /' }), /invalid port/);
});
