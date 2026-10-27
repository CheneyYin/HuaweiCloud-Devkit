import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { pluginRoot, readSource, root } from './structure-helpers.ts';

test('proxy nginx template listens on targetPort, not the stale listenPort (#738)', () => {
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));

  // The proxy template must reference ${targetPort} (the auto-incremented port),
  // not ${listenPort} (the original requested port which may be occupied).
  const proxyBlock = deployNginx.match(/proxy: `server \{[\s\S]*?\}`/);
  assert.ok(proxyBlock, 'proxy nginx template block not found');
  assert.match(proxyBlock[0], /listen \$\{targetPort\}/);
  assert.doesNotMatch(proxyBlock[0], /listen \$\{listenPort\}/);
});

test('effectiveNodePort for proxy resolves via the pure resolveProxyNodePort helper on targetPort (#738)', () => {
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));

  // effectiveNodePort must track the resolved targetPort so the Node app and
  // nginx stay in sync after auto-increment, and the resolution must be
  // extractable into a pure, unit-testable function.
  const nodePortBlock = deployNginx.match(
    /const effectiveNodePort =[\s\S]*?resolveProxyNodePort\(nodePort, targetPort[^;]*;[\s\S]*?\n\s*: undefined;/,
  );
  assert.ok(nodePortBlock, 'effectiveNodePort block not found');
  const block = nodePortBlock[0];
  assert.match(block, /resolveProxyNodePort\(nodePort, targetPort/);
  assert.doesNotMatch(block, /nodePort !== listenPort/);

  const helper = deployNginx.match(/export async function resolveProxyNodePort\([\s\S]*?\n\}/);
  assert.ok(helper, 'resolveProxyNodePort helper not found');
  assert.match(helper[0], /nodePort && nodePort !== nginxListenPort \? nodePort : nginxListenPort \+ 1/);
  assert.match(helper[0], /candidate === nginxListenPort \|\| \(await isPortInUse\(candidate\)\)/);
});

test('port conflict and drift warnings use the unified logic for all nginx types (#738)', () => {
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));

  // The #736 stopgap formatProxyPortWarning must stay retired; proxy gets the
  // same conflict/drift warnings as spa/static.
  assert.doesNotMatch(deployNginx, /formatProxyPortWarning/);
  assert.match(deployNginx, /formatPortConflictWarning\(basePort, targetPort\)/);
  assert.match(deployNginx, /formatPortDriftWarning\(basePort, targetPort\)/);
  assert.doesNotMatch(deployNginx, /nginxType !== 'proxy'\s*\?\s*formatPortDriftWarning/);
});

test('deploy_nginx warnings are joined with the pipe separator (#738)', () => {
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));
  assert.match(deployNginx, /\.join\(' \| '\)/);
});

test('devbridge uses the valid `list` command, not the non-existent `ls`', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));

  assert.doesNotMatch(sandbox, /devbridge ls\b/);
  assert.match(sandbox, /devbridge list\b/);

  assert.doesNotMatch(deployNginx, /devbridge ls\b/);
  assert.match(deployNginx, /devbridge list -j/);
});

test('huawei-sandbox skill documents devbridge description and host/connect traps', () => {
  const body = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  assert.match(body, /only Chinese characters, digits, letters/);
  assert.match(body, /Connection failed, retrying/);
  assert.match(body, /devbridge host/);
  assert.match(body, /expose_via_devbridge/);
});

test('devbridge tunnel handling is migrated to the s2 gateway domain', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  const sessionManager = readSource(join('src', 'sandbox', 'session-manager.ts'));
  // The s2 gateway wire contract moved to devbridge-gateway.ts (the session-manager
  // modularization); the canonical literals are pinned at their new home.
  const gateway = readSource(join('src', 'sandbox', 'devbridge-gateway.ts'));

  // Code must construct tunnel URLs exclusively from the s2 gateway domain.
  // The guard must also catch regex-literal occurrences where dots are escaped
  // (`cn-north-4-bridge\.myhuaweicloud\.com`) — plain dot matching is blind to those.
  assert.match(gateway, /devbridge-s2\.hwtunnel\.com/);
  assert.doesNotMatch(gateway, /cn-north-4-bridge\\?\.myhuaweicloud\\?\.com/);

  // A migrated gateway serves a placeholder page with HTTP 200 — the check must inspect the body.
  assert.match(gateway, /服务已迁移/);

  // The constants stay on the session-manager.ts public face — the sandbox
  // consumers import them from that path (the re-export seam must not drift
  // away); the devbridge-tunnel family imports devbridge-gateway.ts directly.
  assert.match(sessionManager, /DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER,\n\} from '\.\/devbridge-gateway\.ts'/);

  // The skill must teach the new URL form and the dead legacy form.
  assert.match(sandbox, /devbridge-s2\.hwtunnel\.com/);
  assert.doesNotMatch(sandbox, /https:\/\/<id>-<port>\.cn-north-4-bridge\.myhuaweicloud\.com/);
});

test('devbridge host launch survives the exec session (#919/#922): setsid guard, disown, -e 72', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  const devbridgeTunnel = readSource(join('src', 'sandbox', 'devbridge-tunnel.ts'));
  // The face pin: the expose contract re-exports from its canonical module
  // (devbridge-expose.ts) since the devbridge-tunnel modularization — the
  // pure re-export seam must not drift away from the family.
  assert.match(
    devbridgeTunnel,
    /export \{[\s\S]*?buildDevbridgeExposeScript,[\s\S]*?\} from '\.\/devbridge-expose\.ts';/,
  );
  // The tunnel parameter policy (validators, lifetime constants, the 0.1.x
  // version gate) lives in devbridge-validation.ts since the devbridge-tunnel
  // modularization; the canonical literals are pinned at their new home.
  const devbridgeValidation = readSource(join('src', 'sandbox', 'devbridge-validation.ts'));
  // The expose attempt contract (script, stdout grammar, reachability warning)
  // lives in devbridge-expose.ts since the same split.
  const devbridgeExpose = readSource(join('src', 'sandbox', 'devbridge-expose.ts'));
  // The deploy_check remediation lives in deploy-check.ts since the
  // session-manager modularization.
  const deployCheckSource = readSource(join('src', 'sandbox', 'deploy-check.ts'));

  // The tool's expose script: setsid-detached nohup with the no-setsid fallback
  // (some images lack setsid), stdin dropped from the controlling tty, guarded
  // disown (POSIX-sh without the builtin must not abort), and the 72h expiry
  // echoed so exposeTunnel can compute expiresAt.
  assert.match(devbridgeExpose, /if command -v setsid > \/dev\/null 2>&1; then setsid nohup devbridge host/);
  assert.match(devbridgeExpose, /< \/dev\/null & else nohup devbridge host/);
  assert.match(devbridgeExpose, /`disown 2>\/dev\/null \|\| true`/);
  assert.match(devbridgeValidation, /DEVBRIDGE_HOST_EXPIRY_HOURS = 72/);
  assert.match(devbridgeExpose, /DB_EXPIRY_HOURS=\$\{expiryHours\}/);
  // #1000, the agent-facing SKILL surface: the manual fallbacks' curls carry
  // --noproxy with the MANDATORY comment, and the Proxy-trap doctrine
  // paragraph (with the SSH-path cross-reference) teaches the why. Localhost
  // curls are exempt — loopback bypasses the injected proxy.
  assert.match(sandbox, /curl -s --noproxy '\*' -o \/dev\/null/);
  assert.match(sandbox, /Proxy trap on verify commands \(#1000\)/);
  assert.match(sandbox, /windows-ssh\.md §0\.1/);
  assert.match(sandbox, /localhost curls are unaffected/);
  // #999: the data-disk-first PATH doctrine — /workspace survives reboots,
  // ~/.huawei/bin is wiped to the image state; the persistence table teaches
  // it and every PATH export carries the data-disk prefix.
  assert.match(sandbox, /Sandbox filesystem persistence: what survives a reboot \(#999\)/);
  assert.match(sandbox, /export PATH="\/workspace\/.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"/);
  assert.match(devbridgeExpose, /export PATH="\/workspace\/.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"/);
  assert.match(sandbox, /stale ~\/\.huawei\/bin\/devbridge removed/);
  // The Layer-3 install target is the substantive core of #999 — WHERE the
  // binary lands. The old system-disk-only export form must not re-creep.
  assert.match(sandbox, /mkdir -p \/workspace\/.local\/bin/);
  assert.match(sandbox, /install -m 0755 \/tmp\/devbridge-pkg\/devbridge \/workspace\/.local\/bin\/devbridge/);
  assert.doesNotMatch(
    sandbox,
    /export PATH="\$HOME\/\.huawei\/bin:\$PATH"/,
    'the system-disk-only export must not return',
  );
  // The connect flow's unquoted PATH form (handlers-account.ts since the
  // sandbox pack's family split, extracted verbatim from tools.ts) — the
  // third code leg.
  const sandboxConnectSource = readSource(join('src', 'packs', 'sandbox', 'handlers-account.ts'));
  assert.match(sandboxConnectSource, /export PATH=\/workspace\/.local\/bin:\$HOME\/\.huawei\/bin\$\{PATH:\+:\$PATH\}/);

  // The old 8h default must not re-creep into ANY sandbox sibling's tunnel
  // script (family-wide sweep — stronger than the old single-file check, which
  // the devbridge-tunnel modularization would have left vacuous on the face).
  const tunnelScriptFamily = readdirSync(join(pluginRoot, 'src', 'sandbox'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => [`sandbox/${name}`, readSource(join('src', 'sandbox', name))] as const);
  for (const [name, source] of tunnelScriptFamily) {
    assert.doesNotMatch(source, /-e 8\b/, `${name}: no hardcoded 8h tunnel expiry`);
  }

  // The skill teaches the same guarded launch on every host start line.
  assert.match(sandbox, /setsid nohup devbridge host -p <port> -e 72/);
  assert.match(sandbox, /disown 2>\/dev\/null \|\| true/);
  assert.doesNotMatch(sandbox, /-e 8 /);
  // The deploy_check remediation string is the third agent-facing surface —
  // it must teach the same guarded launch (a bare `nohup … &` there reaps the
  // host when the remediation's own exec session ends).
  assert.match(deployCheckSource, /setsid nohup devbridge host <tunnelId> -p \$\{port\} -e 72/);
  assert.match(
    deployCheckSource,
    /devbridge host <tunnelId> -p \$\{port\} -e 72 > \/tmp\/host\.log 2>&1 < \/dev\/null & fi; disown/,
  );
  // Migration/quota verdicts are host-log facts read from dedicated fields —
  // never a whole-stdout scan that the echoed probe body (DB_TUNNEL_BODY)
  // could poison with app content. Count-robust (grep -c prints line counts).
  assert.match(devbridgeExpose, /DB_MIGRATION=\$\(grep -c '\$\{DEVBRIDGE_MIGRATION_MARKER\}' \$\{hostLog\}/);
  assert.match(devbridgeExpose, /Number\(readDbField\(text, 'DB_MIGRATION'\)\) > 0/);
  assert.doesNotMatch(devbridgeExpose, /includes\('10006'\)/);
});

test('expose_tunnel re-verifies from an independent exec session and classifies gateway tunnel errors (#919)', () => {
  const devbridgeTunnel = readSource(join('src', 'sandbox', 'devbridge-tunnel.ts'));
  // The face pin: the re-verify family re-exports from its canonical module
  // (devbridge-verify.ts) since the devbridge-tunnel modularization.
  assert.match(
    devbridgeTunnel,
    /export \{ buildDevbridgeVerifyScript, parseDevbridgeVerifyOutput \} from '\.\/devbridge-verify\.ts';/,
  );
  // The deploy_check probe script lives in deploy-check.ts since the
  // session-manager modularization.
  const deployCheckSource = readSource(join('src', 'sandbox', 'deploy-check.ts'));
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  // The fresh-session re-verify family lives in devbridge-verify.ts since the
  // devbridge-tunnel modularization.
  const devbridgeVerify = readSource(join('src', 'sandbox', 'devbridge-verify.ts'));

  // Fresh-session GET re-verify with the dedicated parser and output fields.
  assert.match(devbridgeVerify, /export function buildDevbridgeVerifyScript/);
  assert.match(devbridgeVerify, /export function parseDevbridgeVerifyOutput/);
  assert.match(devbridgeVerify, /persistent/);
  assert.match(devbridgeVerify, /请勿分享/);
  assert.match(devbridgeVerify, /DB_VERIFY_HTTP_CODE/);

  // Gateway-level errors: status-gated exact-body markers, shared constants.
  // The probe compares the WHOLE body (tr strips \r/\n — CRLF-tolerant, and an
  // app page that merely mentions a marker never matches).
  const gateway = readSource(join('src', 'sandbox', 'devbridge-gateway.ts'));
  assert.match(gateway, /DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER = 'tunnel not found'/);
  assert.match(gateway, /DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER = 'port not configured'/);
  assert.match(gateway, /DEVBRIDGE_BAD_GATEWAY_MARKER = 'bad gateway'/);
  assert.match(deployCheckSource, /body=\$\(tr -d '[^']*' < \/tmp\/\.dc_tunnel_body/);
  // #1000 (v2 completion): the deploy_check tunnel probe also bypasses the
  // injected sandbox proxy — every curl against *.hwtunnel.com carries it.
  assert.match(deployCheckSource, /curl -s --noproxy '\*' -o \/tmp\/\.dc_tunnel_body/);
  // U16: the tunnel-persistence subsystem — renewal, the watchdog, and the
  // #998/#999/#1000 hardening ride the devbridge-tunnel family's canonical
  // modules (pinned below at their homes since the modularization).
  const devbridgeValidation = readSource(join('src', 'sandbox', 'devbridge-validation.ts'));
  // The renew family lives in devbridge-renew.ts since the devbridge-tunnel
  // modularization.
  const devbridgeRenew = readSource(join('src', 'sandbox', 'devbridge-renew.ts'));
  // The keepalive watchdog family lives in devbridge-keepalive.ts since the
  // devbridge-tunnel modularization.
  const devbridgeKeepalive = readSource(join('src', 'sandbox', 'devbridge-keepalive.ts'));
  // The exposeTunnel orchestration lives in devbridge-expose-flow.ts since the
  // devbridge-tunnel modularization.
  const devbridgeExposeFlow = readSource(join('src', 'sandbox', 'devbridge-expose-flow.ts'));
  assert.match(devbridgeValidation, /export function validateExpiryHours/);
  assert.match(devbridgeValidation, /export function validateTunnelId/);
  assert.match(devbridgeRenew, /export function buildDevbridgeRenewScript/);
  assert.match(devbridgeKeepalive, /export function buildDevbridgeKeepaliveScript/);
  assert.match(devbridgeKeepalive, /export function mergeKeepaliveTunnels/);
  // The keepalive health check carries --noproxy (U11 landmine — main missed it).
  assert.match(devbridgeKeepalive, /HC=\$\(curl -s --noproxy '\*' -o \/dev\/null/);
  // The persistence reference and the tool rows exist.
  assert.ok(
    existsSync(
      join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'references', 'tunnel-persistence.md'),
    ),
  );
  assert.match(sandbox, /huaweicloud_sandbox_renew_tunnel/);
  assert.match(sandbox, /huaweicloud_sandbox_keepalive_watchdog/);
  assert.match(sandbox, /AUTO-enrolls into the keepalive watchdog/);
  assert.match(sandbox, /tunnel-persistence\.md/);
  // The 1.1.12 full-stack knowledge (the terminal review's one completeness
  // find — it arrived under no issue number and fell through the per-unit
  // checkpoints): the PostgREST reference, the routing section, and the
  // backend-present integration note.
  assert.ok(
    existsSync(
      join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'references', 'fullstack-postgrest.md'),
    ),
  );
  assert.match(sandbox, /## Full-Stack: REST API over PostgreSQL \(PostgREST\)/);
  assert.match(sandbox, /Backend present\?/);
  assert.match(sandbox, /fullstack-postgrest\.md/);
  assert.match(
    deployCheckSource,
    /\[ "\$code" = "404" \] && \[ "\$body" = "\$\{DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER\}" \]/,
  );

  // Retry exhaustion on a gateway-dead URL must fail, not soften to a warning.
  assert.match(devbridgeExposeFlow, /gateway reports the fresh tunnel URL as dead/);
});

test('deploy_check judges reachability by non-000 and probes listed tunnels boundedly', () => {
  const deployCheckSource = readSource(join('src', 'sandbox', 'deploy-check.ts'));

  // nginx_serving: any non-000 HTTP code counts (404/502 = content issue,
  // not a connectivity issue).
  assert.match(deployCheckSource, /\[ -n "\$HTTP_CODE" \] && \[ "\$HTTP_CODE" != "000" \]/);
  assert.doesNotMatch(deployCheckSource, /grep -qE "\^\(2\|3\)"/);

  // Bounded per-tunnel probing (head -5) with a selected URL — `devbridge list`
  // order is arbitrary, so the first row must not shadow the live tunnel.
  assert.match(deployCheckSource, /TUNNEL_IDS=\$\(devbridge list -j[^\n]*head -5\)/);
  assert.match(deployCheckSource, /for CAND in \$TUNNEL_IDS; do/);
  assert.match(deployCheckSource, /SELECTED_URL="\$CAND_URL"/);
});

test('stripTerminalEscapes is the single escape-stripping seam for sandbox output parsers (#946)', () => {
  const sessionManager = readSource(join('src', 'sandbox', 'session-manager.ts'));
  const devbridgeTunnel = readSource(join('src', 'sandbox', 'devbridge-tunnel.ts'));
  // The face pin: the auth parser re-exports from its canonical module
  // (devbridge-auth.ts) since the devbridge-tunnel modularization.
  assert.match(
    devbridgeTunnel,
    /export \{ buildDevbridgeAuthProbe, parseDevbridgeAuthOutput \} from '\.\/devbridge-auth\.ts';/,
  );
  // sandbox-output.ts is the canonical home since the session-manager
  // modularization; the whole sandbox sibling family is swept so no sibling
  // (new or old) re-rolls the seam.
  const sandboxOutput = readSource(join('src', 'sandbox', 'sandbox-output.ts'));
  // The deploy-check parser lives in deploy-check.ts since the same split.
  const deployCheckSource = readSource(join('src', 'sandbox', 'deploy-check.ts'));
  // The devbridge parsers live in their canonical modules since the
  // devbridge-tunnel modularization (auth probe parser in devbridge-auth.ts,
  // the expose/probe parsers in devbridge-expose.ts).
  const devbridgeAuth = readSource(join('src', 'sandbox', 'devbridge-auth.ts'));
  const devbridgeExpose = readSource(join('src', 'sandbox', 'devbridge-expose.ts'));
  const devbridgeVerify = readSource(join('src', 'sandbox', 'devbridge-verify.ts'));
  const devbridgeRenew = readSource(join('src', 'sandbox', 'devbridge-renew.ts'));
  const devbridgeKeepalive = readSource(join('src', 'sandbox', 'devbridge-keepalive.ts'));
  const sandboxFamily = readdirSync(join(pluginRoot, 'src', 'sandbox'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => [`sandbox/${name}`, readSource(join('src', 'sandbox', name))] as const);

  // One exported definition; every devbridge parser module imports the
  // canonical seam directly since the devbridge-tunnel modularization (auth
  // parser in devbridge-auth.ts, expose/probe parsers in devbridge-expose.ts,
  // verify in devbridge-verify.ts, renew in devbridge-renew.ts, keepalive in
  // devbridge-keepalive.ts — no second copy, no face round-trip; the
  // devbridge-tunnel.ts face is a pure re-export seam and imports nothing).
  assert.match(sandboxOutput, /export function stripTerminalEscapes/);
  assert.match(sessionManager, /export \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeAuth, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeExpose, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeVerify, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeRenew, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  assert.match(devbridgeKeepalive, /import \{ stripTerminalEscapes \} from '\.\/sandbox-output\.ts';/);
  const csiConstruction = "ESC + '\\\\[[0-9:;<=>?]*[ -/]*[a-zA-Z]'";
  assert.equal(sandboxOutput.split(csiConstruction).length - 1, 1, 'CSI regex must be constructed once');
  for (const [name, source] of sandboxFamily) {
    if (name === 'sandbox/sandbox-output.ts') continue;
    assert.equal(source.includes(csiConstruction), false, `${name}: no CSI construction copy`);
  }
  // The CSI class covers the private-mode parameter bytes (\x1b[?2026h etc.) —
  // a digits-;-only class leaves them intact and blinds the anchored lookups.
  assert.match(sandboxOutput, /0-9:;<=>\?\]\*\[ -\/\]\*\[a-zA-Z\]/);
  for (const [name, source] of sandboxFamily) {
    // Deny BOTH CSI- and OSC-form literal-regex copies (/\x1b[…/, /\x1b]…).
    assert.doesNotMatch(
      source,
      /\/\\x1b[\\[\]]/,
      `${name}: no literal escape-regex copies — fold stripTerminalEscapes in`,
    );
  }

  // Every sandbox-output parser entry point folds the stripper in.
  assert.match(deployCheckSource, /parseDeployCheckOutput\(stdout[\s\S]{0,400}?stripTerminalEscapes\(stdout\)/);
  assert.match(devbridgeExpose, /parseDevbridgeExposeOutput\(stdout[\s\S]{0,600}?stripTerminalEscapes\(stdout\)/);
  assert.match(devbridgeAuth, /parseDevbridgeAuthOutput\(stdout[\s\S]{0,400}?stripTerminalEscapes\(stdout\)/);
  assert.match(devbridgeVerify, /parseDevbridgeVerifyOutput\(stdout[\s\S]{0,400}?stripTerminalEscapes\(stdout\)/);
  assert.match(devbridgeExpose, /parseDevbridgeProbeSequence\(stdout[\s\S]{0,700}?stripTerminalEscapes\(stdout\)/);
});

test('devbridge 0.2.x flow: auth capability probe, version detection, in-place upgrade guidance', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  // The credentials tool handler moved to the sandbox pack with the P2 pack
  // program, and into handlers-credentials.ts with the pack's family split
  // (extracted verbatim from tools.ts).
  const sandboxCredentials = readSource(join('src', 'packs', 'sandbox', 'handlers-credentials.ts'));

  // SKILL.md must never teach the removed 0.1.x login flow (--huaweicloud SSO flag is
  // gone from every 0.2.x build), and the obsolete warning row must stay gone.
  assert.doesNotMatch(sandbox, /auth login --huaweicloud/);
  assert.doesNotMatch(sandbox, /Login needs --huaweicloud/);
  assert.match(sandbox, /Never expose tunnel details/);

  // The #935 sandbox traps (ported from main 1.1.10): 0.2.x has no
  // --huaweicloud flag (docs ran ahead of the binary — teach the direct
  // --access-key form); platform-side STS credentials are obsutil-encrypted
  // (devbridge reads ciphertext → APIGW.0301); sandboxes have no systemd.
  assert.match(sandbox, /does NOT exist in sandbox devbridge 0\.2\.x binaries/);
  assert.match(sandbox, /obsutil 加密态存储/);
  assert.match(sandbox, /沙箱无 systemd/);
  assert.match(sandbox, /nginx -t` 验证 \+ `nginx -s reload` 热加载/);

  // The paired implementation pin: the SKILL's deploy_nginx claim (配置写入
  // 后自动回验存在性与 nginx -t) is only true because the sandbox family
  // implements the A1 verify block — deploy-nginx.ts splices the markers into
  // the deploy script and folds in the verdict from deploy-nginx-verify.ts —
  // docs-ahead-of-code (the failure this guard's sibling prose denounces)
  // fails here.
  const deployNginx = readSource(join('src', 'sandbox', 'deploy-nginx.ts'));
  const deployNginxVerify = readSource(join('src', 'sandbox', 'deploy-nginx-verify.ts'));
  assert.match(deployNginx, /DB_NGINX_CONFIG_MISSING=1/);
  assert.match(deployNginx, /DB_NGINX_T=PASS/);
  assert.match(deployNginxVerify, /export function resolveNginxConfigPath/);
  assert.match(deployNginx, /fix_and_retry/);

  // Auth is a verified three-tier waterfall (keyring → AK/SK → api-key file);
  // the preferred path is the expose_tunnel tool, the manual script is the
  // fallback. The probe vocabulary is DB_AUTH_MODE modes, not AUTH_MODE.
  assert.match(sandbox, /auth login --help 2>&1 \| grep -q -- '--access-key'/);
  assert.match(sandbox, /hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1/);
  assert.match(sandbox, /devbridge_"\*\)|devbridge_\*\)/);
  assert.match(sandbox, /API_KEY_KEYRING/);
  assert.match(sandbox, /AKSK_SUPPORTED/);
  assert.match(sandbox, /API_KEY_FILE/);
  assert.match(sandbox, /NO_CREDENTIAL/);
  assert.match(
    sandbox,
    /--security-token "\$HW_SECURITY_TOKEN"/,
    'STS credentials must carry the security token or the gateway rejects with 401 APIGW.0301',
  );
  assert.match(
    sandbox,
    /auth login --access-key "\$HW_ACCESS_KEY" --secret-key "\$HW_SECRET_KEY"/,
    'image-build branch must teach the direct AK/SK login',
  );
  assert.match(sandbox, /huaweicloud_sandbox_expose_tunnel/);
  assert.match(sandbox, /attempts/);

  // The API Key guidance (release-build branch) must survive, incl. version detection
  // and the in-place upgrade.
  assert.match(sandbox, /auth login --api-key "\$HW_API_KEY"/);
  assert.match(sandbox, /devbridge version/);
  assert.match(sandbox, /devbridge-install\.sh -s/);
  assert.match(sandbox, /devstation\.connect\.huaweicloud\.com\/space\/devbridge\/apikey/);
  assert.match(sandbox, /HW_API_KEY/);

  // The credentials tool must support injecting the DevBridge API Key:
  // - env-first precedence (keeps the long-lived key out of the conversation)
  // - separate storage from the temporary AK/SK (/tmp/hw_api_key vs /tmp/hw_creds.sh)
  assert.match(sandboxCredentials, /api_key/);
  assert.match(sandboxCredentials, /process\.env\.HW_API_KEY \|\| args\.api_key/);
  assert.match(sandboxCredentials, /\/tmp\/hw_api_key/);
  assert.match(sandbox, /\/tmp\/hw_api_key/);

  // The API Key must NOT be written into the shared AK/SK creds script.
  const credsWrite = sandboxCredentials.match(/const credsScript = \[[\s\S]*?\]/);
  assert.ok(credsWrite, 'credsScript block not found in packs/sandbox/handlers-credentials.ts');
  assert.doesNotMatch(credsWrite[0], /HW_API_KEY/);

  // The CodeArts Doer sidecopy must mirror the probe-branch flow and not regress
  // to the removed 0.1.x flow either. .codeartsdoer is a gitignored install
  // copy (never tracked), so a clean checkout has no sidecopy to check.
  const sidecopyPath = join(root, '.codeartsdoer', 'skills', 'huawei-sandbox', 'SKILL.md');
  if (existsSync(sidecopyPath)) {
    const sidecopy = readFileSync(sidecopyPath, 'utf8');
    assert.doesNotMatch(sidecopy, /auth login --huaweicloud/);
    assert.doesNotMatch(sidecopy, /res-hd\.hc-cdn\.cn/);
    assert.doesNotMatch(sidecopy, /devbridge ls\b/);
    assert.doesNotMatch(sidecopy, /https:\/\/<id>-<port>\.cn-north-4-bridge/);
    assert.match(sidecopy, /auth login --help 2>&1 \| grep -q -- '--access-key'/);
    assert.match(sidecopy, /API_KEY_KEYRING/);
    assert.match(sidecopy, /AKSK_SUPPORTED/);
    assert.match(sidecopy, /NO_CREDENTIAL/);
    assert.match(sidecopy, /auth login --api-key "\$HW_API_KEY"/);
    assert.match(sidecopy, /devbridge-s2\.hwtunnel\.com/);
    assert.match(sidecopy, /\/tmp\/hw_api_key/);
  }
});
