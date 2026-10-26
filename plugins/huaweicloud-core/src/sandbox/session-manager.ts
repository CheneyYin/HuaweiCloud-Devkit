import { execOneShot } from './hwlink-connection.ts';
import {
  DEVBRIDGE_BAD_GATEWAY_MARKER,
  DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER,
  DEVBRIDGE_TUNNEL_DOMAIN,
  DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER,
} from './devbridge-gateway.ts';
import { stripTerminalEscapes } from './sandbox-output.ts';

interface DeployNginxOptions {
  nginxType?: string;
  port?: number;
  project?: string;
  outputDir?: string;
  nodePort?: number;
  publicPort?: number;
  configName?: string;
}

interface DeployNginxResult {
  ok: boolean;
  error?: string;
  nginxType: string;
  port: number;
  nodePort: number | undefined;
  outputPath: string;
  projectPath: string;
  configPath: string;
  verification?: { configPath: string; nginxTest: string };
  exitCode: number;
  stdout: string;
  nextStep: string;
  warning: string | undefined;
}

interface DeployCheckOptions {
  port: number;
  project: string;
  outputDir: string;
  frameworkType?: string;
}

interface DeployCheckEntry {
  status: string;
  detail: string;
}

interface DeployCheckResult {
  ok: boolean;
  complete: boolean;
  checkType: string;
  checks: Record<string, DeployCheckEntry>;
  score: { pass: number; total: number } | null;
  publicUrl: string | undefined;
  missingSteps: string | undefined;
  parseWarning: string | undefined;
  rawOutput: string | undefined;
  nextStep: string;
  remediation: string | undefined;
}

// The DevBridge s2 gateway wire contract (tunnel domain, migration marker,
// gateway-level error bodies) lives in devbridge-gateway.ts; re-exported here
// as the stable public face (devbridge-tunnel.ts imports it from this path).
export {
  DEVBRIDGE_BAD_GATEWAY_MARKER,
  DEVBRIDGE_MIGRATION_MARKER,
  DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER,
  DEVBRIDGE_TUNNEL_DOMAIN,
  DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER,
} from './devbridge-gateway.ts';
// The single escape-stripping seam for sandbox output parsers (#946) lives in
// sandbox-output.ts; re-exported as the public face (devbridge-tunnel.ts and
// the upload/deploy parsers import it from this path).
export { stripTerminalEscapes } from './sandbox-output.ts';
// The ws-exec barrel loader and the ws-exec structural shapes live in
// ws-exec-loader.ts; resolveWsExecIndexUrl is re-exported as the public face.
export { resolveWsExecIndexUrl } from './ws-exec-loader.ts';
// The hwlink connection layer (workspace-id state, session cache, exec
// surfaces, close family) lives in hwlink-connection.ts; re-exported as the
// public face (packs/sandbox/tools.ts and the tests import these names here).
export {
  closeAllSessions,
  closeSession,
  execOneShot,
  execWithSession,
  getCurrentWorkspaceId,
  setWorkspaceId,
  _setSessionConnectorForTests,
} from './hwlink-connection.ts';
// The base64 single-file upload family lives in upload-file.ts; re-exported
// as the public face.
export {
  UPLOAD_BATCH_SIZE,
  UPLOAD_CHUNK_SIZE,
  UPLOAD_MAX_RETRIES,
  buildUploadResetCommand,
  classifyLocalUploadPath,
  splitBase64Chunks,
  uploadFileWithSession,
} from './upload-file.ts';
// The project upload orchestration lives in upload-project.ts (transport in
// upload-transport.ts); re-exported as the public face.
export { uploadProjectWithSession } from './upload-project.ts';

export const TUNNEL_URL_PATTERN = /TUNNEL_URL:(https:\/\/[A-Za-z0-9_-]+-\d+\.devbridge-s2\.hwtunnel\.com)/;

export function formatPortConflictWarning(basePort: number, targetPort: number): string | undefined {
  return targetPort !== basePort ? `Port ${basePort} is in use — auto-assigned port ${targetPort}` : undefined;
}

export function formatPortDriftWarning(basePort: number, targetPort: number): string | undefined {
  if (targetPort === basePort) return undefined;
  return `Port ${basePort} was occupied — nginx now listens on port ${targetPort}. Any DevBridge tunnel bound to port ${basePort} is detached: run "devbridge port create <tunnelId> -p ${targetPort} --protocol http -a" and restart "devbridge host" for the new port.`;
}

export async function resolveProxyNodePort(
  nodePort: number | undefined,
  nginxListenPort: number,
  isPortInUse: (candidate: number) => Promise<boolean>,
): Promise<number> {
  const baseCandidate = nodePort && nodePort !== nginxListenPort ? nodePort : nginxListenPort + 1;
  let candidate = baseCandidate;
  for (
    let attempt = 0;
    attempt < 10 && (candidate === nginxListenPort || (await isPortInUse(candidate)));
    attempt += 1
  ) {
    candidate += 1;
  }
  return candidate;
}

export function buildExposeRemediation(port: number): string {
  return `In the sandbox: source /tmp/hw_creds.sh; source /tmp/hw_api_key 2>/dev/null; devbridge delete-all; devbridge create <name>; devbridge port create <tunnelId> -p ${port} --protocol http -a; if command -v setsid >/dev/null 2>&1; then setsid nohup devbridge host <tunnelId> -p ${port} -e 72 > /tmp/host.log 2>&1 < /dev/null & else nohup devbridge host <tunnelId> -p ${port} -e 72 > /tmp/host.log 2>&1 < /dev/null & fi; disown 2>/dev/null || true; If deploy_nginx reported a different (auto-incremented) port in its "port" field, use THAT port instead of the one shown here. Full procedure in huawei-sandbox skill, Step 7 (Expose via DevBridge).`;
}

// A1 (#935): normalize configName to a bare filename — a path-shaped value
// (e.g. a local path echoed back by a caller) must never splice into a broken
// target like `/etc/nginx/conf.d//root/hc-activity.conf` (nginx never serves
// it, the tunnel answers 502). Only the basename is kept and the `.conf`
// suffix stripped before the path is rebuilt; a pure filename (no separators)
// keeps the previous behavior unchanged.
export function resolveNginxConfigPath(configName: string | undefined, project: string): string {
  const raw = String(configName || project || '');
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || '';
  const name = base.replace(/\.conf$/i, '') || 'default';
  return `/etc/nginx/conf.d/${name}.conf`;
}

export interface ParsedDeployNginxVerify {
  configMissing: boolean;
  nginxTest: string;
  nginxTestOutput: string;
}

// A1 (#935): parse the write-verification block appended to the deploy_nginx
// script. The old flow returned ok:true whenever the deploy script exited 0,
// even when the tee write silently failed — the config file never existed and
// the tunnel answered 502. The verification block emits explicit markers:
//   DB_NGINX_CONFIG_MISSING=1  — the target config file does not exist
//   DB_NGINX_T=PASS|FAIL       — nginx -t verdict, with failure output echoed
//                                as `DB_NGINX_T_OUTPUT: ...` lines
export function parseDeployNginxVerifyOutput(stdout: string | undefined): ParsedDeployNginxVerify {
  const text = String(stdout || '');
  const configMissing = /DB_NGINX_CONFIG_MISSING=1/.test(text);
  const nginxTest = text.match(/^DB_NGINX_T=(\w+)$/m)?.[1] ?? '';
  const nginxTestOutput = (text.match(/^DB_NGINX_T_OUTPUT: .*$/gm) ?? [])
    .map((line) => line.replace(/^DB_NGINX_T_OUTPUT: /, ''))
    .join('\n');
  return { configMissing, nginxTest, nginxTestOutput };
}

export interface DeployNginxVerdict {
  ok: boolean;
  error?: string;
}

// A1 (#935): the deploy verdict. A deploy script exit of 0 alone is NOT proof
// of success — the tee write can fail silently (broken pipe) and nginx -t can
// reject the config. Returns ok:false with an explicit, actionable error for
// any verification failure; a pure function so the verdict is unit-testable.
export function evaluateDeployNginxVerify(
  result: { exitCode: number },
  verify: ParsedDeployNginxVerify,
  configPath: string,
): DeployNginxVerdict {
  const writeVerified = result.exitCode === 0 && !verify.configMissing && verify.nginxTest === 'PASS';
  if (writeVerified) return { ok: true };
  const problems: string[] = [];
  if (result.exitCode !== 0) problems.push(`deploy script exited with code ${result.exitCode}`);
  if (verify.configMissing) problems.push(`nginx config file ${configPath} was not created (tee write failed)`);
  if (verify.nginxTest !== 'PASS')
    problems.push(`nginx -t did not pass${verify.nginxTestOutput ? ` — ${verify.nginxTestOutput}` : ''}`);
  return {
    ok: false,
    error: `sandbox deploy nginx: configuration write verification failed — ${problems.join('; ')}.`,
  };
}

export async function deployNginx(
  workspaceId: string,
  { nginxType, port, project, outputDir, nodePort, publicPort, configName }: DeployNginxOptions,
  username = 'root',
  timeoutMs = 60000,
): Promise<DeployNginxResult> {
  if (!workspaceId) {
    throw new Error('sandbox deploy nginx: workspace_id is required.');
  }
  if (!nginxType || !port || !project || !outputDir) {
    throw new Error('sandbox deploy nginx: nginxType, port, project, and outputDir are required.');
  }

  const nginxCheck = await execOneShot(
    workspaceId,
    'command -v nginx >/dev/null 2>&1 && echo "INSTALLED" || echo "MISSING"',
    username,
    10000,
  );
  if (!String(nginxCheck.stdout || '').includes('INSTALLED')) {
    throw new Error(
      'sandbox deploy nginx: nginx is not installed. Install it first:\n' +
        '  Detect OS: source /etc/os-release && echo $ID\n' +
        '  apt: sudo apt-get update -qq && sudo apt-get install -y -qq nginx\n' +
        '  yum: sudo yum install -y nginx\n' +
        '  dnf: sudo dnf install -y nginx\n' +
        'Alternatively, skip nginx and use Python HTTP server (see nginx-templates.md).',
    );
  }

  const listenPort = publicPort || port;
  const basePort = nginxType === 'proxy' ? listenPort : port;

  let targetPort = basePort;
  const maxPortAttempts = 10;
  for (let offset = 0; offset < maxPortAttempts; offset += 1) {
    targetPort = basePort + offset;
    try {
      const portCheck = await execOneShot(
        workspaceId,
        `ss -tlnp 2>/dev/null | grep -q ":${targetPort} " && echo "IN_USE" || echo "FREE"`,
        username,
        10000,
      );
      if (!String(portCheck.stdout || '').includes('IN_USE')) break;
    } catch {
      // a failed probe reads as in-use; conservatively try the next port
    }
    if (offset === maxPortAttempts - 1) {
      throw new Error(
        `sandbox deploy nginx: all ports ${basePort}-${basePort + maxPortAttempts - 1} are in use. Free a port and try again.`,
      );
    }
  }

  const effectiveNodePort =
    nginxType === 'proxy'
      ? await resolveProxyNodePort(nodePort, targetPort, async (candidate) => {
          const portCheck = await execOneShot(
            workspaceId,
            `ss -tlnp 2>/dev/null | grep -q ":${candidate} " && echo "IN_USE" || echo "FREE"`,
            username,
            10000,
          );
          return String(portCheck.stdout || '').includes('IN_USE');
        })
      : undefined;

  const projectPath = `/workspace/${project}`;
  const outputPath = outputDir.startsWith('/') ? outputDir : `${projectPath}/${outputDir}`;

  const resolveScript = `REAL_PROJECT=$(readlink -f "${projectPath}" 2>/dev/null || echo "${projectPath}")
REAL_OUTPUT="${outputPath}"
if [ "\${REAL_PROJECT}" != "${projectPath}" ]; then
  REL_OUTPUT=$(echo "${outputDir}" | sed "s|${projectPath}/||")
  REAL_OUTPUT="\${REAL_PROJECT}/\${REL_OUTPUT}"
fi`;

  const templates: Record<string, string> = {
    spa: `server {
    listen ${targetPort};
    root ${outputPath};
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}`,
    proxy: `server {
    listen ${targetPort};
    server_name _;
    large_client_header_buffers 4 32k;

    location / {
        proxy_pass http://127.0.0.1:${effectiveNodePort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
        proxy_buffer_size 128k;
        proxy_buffers 4 256k;
        proxy_busy_buffers_size 256k;
    }
}`,
    static: `server {
    listen ${targetPort};
    root ${outputPath};
    index index.html;

    location / {
        try_files $uri $uri.html $uri/ =404;
        autoindex off;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}`,
  };

  const config = templates[nginxType];
  if (!config) {
    throw new Error(`sandbox deploy nginx: unknown nginxType "${nginxType}". Must be one of: spa, proxy, static`);
  }

  // A1 (#935): configName is normalized to a bare filename so a path-shaped
  // value can never produce `/etc/nginx/conf.d//root/xxx.conf` again.
  const configPath = resolveNginxConfigPath(configName, project);

  const cmd = [
    resolveScript,
    `sudo mkdir -p /etc/nginx/conf.d`,
    `sudo tee ${configPath} > /dev/null << 'NGINX_EOF'`,
    config,
    `NGINX_EOF`,
    `# Resolve symlinks for chmod (chmod does not follow symlinks on Linux)`,
    `chmod -R o+rX "$REAL_PROJECT" 2>/dev/null || true`,
    `find "$REAL_PROJECT" -type d -exec chmod o+x {} \\; 2>/dev/null || true`,
    `find "$REAL_PROJECT" -type f -path "*/node_modules/.bin/*" -exec chmod +x {} \\; 2>/dev/null || true`,
    `if pgrep -x nginx > /dev/null 2>&1; then sudo killall -9 nginx 2>/dev/null; sleep 1; fi
    sudo nginx`,
    `# A1 (#935): verify the config write took effect before reporting success`,
    `NGINX_CONFIG_PATH=${configPath}`,
    `if [ ! -f "$NGINX_CONFIG_PATH" ]; then echo "DB_NGINX_CONFIG_MISSING=1"; fi`,
    `NGINX_T_OUTPUT=$(sudo nginx -t 2>&1 || true)`,
    `if echo "$NGINX_T_OUTPUT" | grep -Eq "syntax is ok|test is successful"; then echo "DB_NGINX_T=PASS"; else echo "DB_NGINX_T=FAIL"; echo "$NGINX_T_OUTPUT" | sed "s/^/DB_NGINX_T_OUTPUT: /"; fi`,
  ].join('\n');

  const result = await execOneShot(workspaceId, cmd, username, timeoutMs);

  let tunnelActive = false;
  try {
    // Version-aware: devbridge 0.1.x exposes JSON via `list -j`; 0.2.x removed -j and
    // prints a table whose data rows start with the 8-char base32 tunnel ID.
    // #999: the data-disk-first PATH — a fresh one-shot shell does not inherit
    // any prior export, and after the Layer-3 install + dedup (or a reboot) the
    // only surviving binary lives at /workspace/.local/bin.
    const tunnelCheck = await execOneShot(
      workspaceId,
      'export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; (devbridge list -j 2>/dev/null | grep -q \'"tunnelId"\' || devbridge list 2>/dev/null | grep -Eq \'^[a-z2-7]{8}[[:space:]]\') && echo "ACTIVE" || echo "INACTIVE"',
      username,
      10000,
    );
    tunnelActive = String(tunnelCheck.stdout || '').includes('ACTIVE');
  } catch {
    // a failed probe leaves tunnelActive false; the result then carries the incomplete-deployment warning
  }

  const warning =
    [
      !tunnelActive
        ? 'No active DevBridge tunnel — deployment is incomplete. Proceed to Step 7 to expose the app.'
        : undefined,
      formatPortConflictWarning(basePort, targetPort),
      tunnelActive ? formatPortDriftWarning(basePort, targetPort) : undefined,
    ]
      .filter(Boolean)
      .join(' | ') || undefined;

  // A1 (#935): verify the config write before reporting success. A deploy
  // script exit of 0 alone is NOT proof — the tee write can fail silently and
  // nginx -t can reject the config. Any verification failure returns ok:false
  // with an explicit, actionable error.
  const verify = parseDeployNginxVerifyOutput(result.stdout);
  const verdict = evaluateDeployNginxVerify(result, verify, configPath);
  if (!verdict.ok) {
    return {
      ok: false,
      error: verdict.error,
      nginxType,
      port: targetPort,
      nodePort: effectiveNodePort || undefined,
      outputPath,
      projectPath,
      configPath,
      exitCode: result.exitCode,
      stdout: result.stdout,
      nextStep: 'fix_and_retry',
      warning,
    };
  }

  return {
    ok: true,
    nginxType,
    port: targetPort,
    nodePort: effectiveNodePort || undefined,
    outputPath,
    projectPath,
    configPath,
    verification: { configPath, nginxTest: verify.nginxTest },
    exitCode: result.exitCode,
    stdout: result.stdout,
    nextStep: 'expose_via_devbridge',
    warning,
  };
}

// The deploy-check stdout contract as one exported pure function — the
// grammar (`name:PASS`, `SCORE:n/n`, `TUNNEL_URL:`, `VERDICT:COMPLETE`)
// is the product-fake interface for the e2e ws fake, so it is pinned by
// test/ws-exec-protocol.test.ts from BOTH sides (the fake's synthesized
// output must parse through this function).
export interface ParsedDeployCheck {
  checks: Record<string, DeployCheckEntry>;
  complete: boolean;
  score: { pass: number; total: number } | null;
  publicUrl: string | undefined;
  missing: string[];
  parseWarning: string | undefined;
}

export function parseDeployCheckOutput(stdout: string): ParsedDeployCheck {
  // Strip ANSI escape sequences (CSI color/cursor codes and OSC shell-integration markers)
  // and normalize line endings to \n to handle all terminal outputs.
  const cleanStdout = stripTerminalEscapes(stdout);
  const checks: Record<string, DeployCheckEntry> = {};
  const lines = cleanStdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^(\w+):(PASS|FAIL|SKIP)\b(.*)/);
    if (m) checks[m[1]!] = { status: m[2]!, detail: (m[3] || '').trim() };
  }
  const scoreMatch = cleanStdout.match(/SCORE:(\d+)\/(\d+)/);
  const tunnelMatch = cleanStdout.match(TUNNEL_URL_PATTERN);
  const complete = /VERDICT:COMPLETE/.test(cleanStdout);

  const missing: string[] = [];
  if (!complete) {
    for (const [key, val] of Object.entries(checks)) {
      if (val.status === 'FAIL') missing.push(key);
    }
  }

  // If checks is empty but score was found, parsing failed — raw output is kept for debugging
  const parseWarning =
    Object.keys(checks).length === 0 && scoreMatch
      ? 'Check output parsing failed — individual check results could not be extracted. See rawOutput for details.'
      : undefined;

  return {
    checks,
    complete,
    score: scoreMatch ? { pass: parseInt(scoreMatch[1]!, 10), total: parseInt(scoreMatch[2]!, 10) } : null,
    publicUrl: tunnelMatch ? tunnelMatch[1] : undefined,
    missing,
    parseWarning,
  };
}

export async function deployCheck(
  workspaceId: string,
  { port, project, outputDir, frameworkType }: DeployCheckOptions,
  username = 'root',
  // Mirrors SANDBOX_TIMEOUT_MS.deploy_check (packs/sandbox/tools.ts): the
  // bounded per-tunnel probing alone can spend 5 × 5s of curl plus devbridge
  // list round-trips. The remaining curls (localhost nginx/fingerprint, the
  // external QR service) are still unbounded — pre-existing; a hang there can
  // still consume the budget, but the probe loop itself now fits.
  timeoutMs = 60000,
): Promise<DeployCheckResult> {
  if (!workspaceId) {
    throw new Error('sandbox deploy check: workspace_id is required.');
  }

  const projectPath = `/workspace/${project}`;
  const outputPath = outputDir.startsWith('/') ? outputDir : `${projectPath}/${outputDir}`;
  const isCrossPlatform = frameworkType === 'cross-platform';

  const checkScript = [
    // #999: the export rides the same first line as the marker (one-shot
    // shells need it; first-line intent recognition needs a stable anchor).
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"; echo "=== DEPLOY CHECK ==="`,
    `PASS=0`,
    `TOTAL=0`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} 2>/dev/null)`,
    `if [ -n "$HTTP_CODE" ] && [ "$HTTP_CODE" != "000" ]; then`,
    `  echo "nginx_serving:PASS (port ${port}, HTTP \${HTTP_CODE})"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "nginx_serving:FAIL (port ${port}, no HTTP response)"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `if [ -d "${outputPath}" ] && ls -A "${outputPath}" 2>/dev/null | grep -q .; then`,
    `  echo "output_dir:PASS (${outputPath})"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "output_dir:FAIL (${outputPath} empty or missing)"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `FINGERPRINT_FILE="${outputPath}/.deploy_fingerprint"`,
    `FINGERPRINT_EXPECTED=$(cat "$FINGERPRINT_FILE" 2>/dev/null)`,
    `if [ -n "$FINGERPRINT_EXPECTED" ]; then`,
    `  FINGERPRINT_ACTUAL=$(curl -s http://localhost:${port}/.deploy_fingerprint 2>/dev/null)`,
    `  if [ "$FINGERPRINT_EXPECTED" = "$FINGERPRINT_ACTUAL" ]; then`,
    `    echo "content_verified:PASS"`,
    `    PASS=$((PASS+1))`,
    `  else`,
    `    echo "content_verified:FAIL (fingerprint mismatch — nginx may be serving stale content from a previous deployment)"`,
    `  fi`,
    `else`,
    `  echo "content_verified:SKIP (no fingerprint file)"`,
    `  TOTAL=$((TOTAL-1))`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `DB_TUNNEL_ACTIVE=0`,
    `if devbridge list -j 2>/dev/null | grep -q '"tunnelId"'; then`,
    `  DB_TUNNEL_ACTIVE=1`,
    `elif devbridge list 2>/dev/null | grep -Eq '^[a-z2-7]{8}[[:space:]]'; then`,
    `  DB_TUNNEL_ACTIVE=1`,
    `fi`,
    `if [ "$DB_TUNNEL_ACTIVE" = "1" ]; then`,
    `  echo "devbridge_tunnel:PASS"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "devbridge_tunnel:FAIL"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `TUNNEL_IDS=$(devbridge list -j 2>/dev/null | grep -oP '"tunnelId":\\s*"\\K[^"]+' | head -5)`,
    `if [ -z "$TUNNEL_IDS" ]; then`,
    `  TUNNEL_IDS=$(devbridge list 2>/dev/null | grep -E '^[a-z2-7]{8}[[:space:]]' | awk '{print $1}' | head -5)`,
    `fi`,
    `# Gateway-level tunnel errors have exact text/plain bodies ("tunnel not found"`,
    `# verified live on the s2 gateway): 404 "tunnel not found" = no live host session`,
    `# (the tunnel RECORD may still be in \`list\`); 404 "port not configured" = URL port`,
    `# not registered; 502 "bad gateway" = tunnel alive, local service down. The`,
    `# whole-content comparison (tr strips \\r/\\n, so CRLF forms compare equal) plus`,
    `# status gating avoids flagging app-generated 404/502 pages — a page that`,
    `# merely MENTIONS a marker never matches. No migration-marker grep here: the`,
    `# probe URL is always constructed on the CURRENT gateway domain, which never`,
    `# serves the retired gateway's placeholder — a body grep could only fire on`,
    `# app content (a Chinese page saying 服务已迁移 is a legitimate app). Migration`,
    `# is judged host-log-side by expose_tunnel (DB_MIGRATION). --max-time 5 (vs`,
    `# the expose/verify probes' 10) keeps 5 bounded probes inside the timeout budget.`,
    `probe_tunnel() {`,
    `  local url="$1" code body`,
    // #1000 (v2 completion — main missed this probe): --noproxy — the injected
    // sandbox proxy does not route the tunnel domain; a proxied probe returns
    // 502/404 fakes for a working tunnel, same trap as the expose/verify curls.
    `  code=$(curl -s --noproxy '*' -o /tmp/.dc_tunnel_body -w "%{http_code}" --max-time 5 "$url" 2>/dev/null)`,
    `  PROBE_FAIL_REASON=""`,
    `  if [ -z "$code" ] || [ "$code" = "000" ]; then PROBE_FAIL_REASON="unreachable"; rm -f /tmp/.dc_tunnel_body; return 1; fi`,
    `  body=$(tr -d '\\r\\n' < /tmp/.dc_tunnel_body 2>/dev/null)`,
    `  rm -f /tmp/.dc_tunnel_body`,
    `  if [ "$code" = "404" ] && [ "$body" = "${DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER}" ]; then PROBE_FAIL_REASON="tunnel not found (no live host session on the gateway)"; return 1; fi`,
    `  if [ "$code" = "404" ] && [ "$body" = "${DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER}" ]; then PROBE_FAIL_REASON="port not configured (URL port not registered on the tunnel)"; return 1; fi`,
    `  if [ "$code" = "502" ] && [ "$body" = "${DEVBRIDGE_BAD_GATEWAY_MARKER}" ]; then PROBE_FAIL_REASON="bad gateway (tunnel alive, local service not serving)"; return 1; fi`,
    `  return 0`,
    `}`,
    `# Probe each listed tunnel (bounded to 5) and select the first one that actually`,
    `# serves this port — \`devbridge list\` order is arbitrary, so a stale tunnel listed`,
    `# first must not shadow the live one.`,
    `SELECTED_URL=""`,
    `FIRST_ID=""`,
    `FIRST_REASON=""`,
    `for CAND in $TUNNEL_IDS; do`,
    `  if [ -z "$FIRST_ID" ]; then FIRST_ID="$CAND"; fi`,
    `  CAND_URL="https://\${CAND}-${port}.${DEVBRIDGE_TUNNEL_DOMAIN}"`,
    `  if probe_tunnel "$CAND_URL"; then`,
    `    SELECTED_URL="$CAND_URL"`,
    `    break`,
    `  fi`,
    `  # The FAIL detail pairs the first listed URL with the FIRST probe's reason —`,
    `  # PROBE_FAIL_REASON is overwritten per candidate and would misattribute.`,
    `  if [ -z "$FIRST_REASON" ]; then FIRST_REASON="$PROBE_FAIL_REASON"; fi`,
    `done`,
    `TUNNEL_URL="$SELECTED_URL"`,
    `if [ -n "$SELECTED_URL" ]; then`,
    `  echo "tunnel_url_accessible:PASS ($SELECTED_URL)"`,
    `  PASS=$((PASS+1))`,
    `elif [ -n "$FIRST_ID" ]; then`,
    `  echo "tunnel_url_accessible:FAIL (https://\${FIRST_ID}-${port}.${DEVBRIDGE_TUNNEL_DOMAIN} -> $FIRST_REASON)"`,
    `else`,
    `  echo "tunnel_url_accessible:FAIL (no tunnel)"`,
    `fi`,
    ``,
    `${`
TOTAL=$((TOTAL+1))
if [ -f "${outputPath}/qr.png" ]; then
  echo "qr_code:PASS"
  PASS=$((PASS+1))
else
  # Auto-detect cross-platform from project files (more reliable than frameworkType param)
  PROJ_DIR="/workspace/${project}"
  IS_CROSS=0
  if [ -f "$PROJ_DIR/manifest.json" ] || grep -qE '"@tarojs/taro"|"@dcloudio/uni-app"' "$PROJ_DIR/package.json" 2>/dev/null; then
    IS_CROSS=1
  fi
  if [ $IS_CROSS -eq 0 ] && ( [ -f "$PROJ_DIR/app.config.ts" ] || [ -f "$PROJ_DIR/app.config.js" ] ) && grep -qE "pages|tabBar" "$PROJ_DIR/app.config."* 2>/dev/null; then
    IS_CROSS=1
  fi

  if [ $IS_CROSS -eq 1 ]; then
    if [ -n "$TUNNEL_URL" ]; then
      curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$TUNNEL_URL" 2>/dev/null)" -o "${outputPath}/qr.png" 2>/dev/null
      chmod o+r "${outputPath}/qr.png" 2>/dev/null || true
      if [ -f "${outputPath}/qr.png" ] && [ -s "${outputPath}/qr.png" ]; then
        echo "qr_code:PASS (auto-generated)"
        PASS=$((PASS+1))
      else
        echo "qr_code:FAIL (QR generation failed)"
      fi
    else
      echo "qr_code:FAIL (no tunnel URL for QR generation)"
    fi
  else
    echo "qr_code:SKIP (not a cross-platform project)"
    TOTAL=$((TOTAL-1))
  fi
fi
`}`,
    `echo "SCORE:\${PASS}/\${TOTAL}"`,
    `echo "TUNNEL_URL:\${TUNNEL_URL:-}"`,
    `[ "\${PASS}" = "\${TOTAL}" ] && echo "VERDICT:COMPLETE" || echo "VERDICT:INCOMPLETE"`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await execOneShot(workspaceId, checkScript, username, timeoutMs);
  const stdout = String(result.stdout || '');
  const { checks, complete, score, publicUrl, missing, parseWarning } = parseDeployCheckOutput(stdout);

  const nextStepValue = !complete
    ? missing.includes('devbridge_tunnel') || missing.includes('tunnel_url_accessible')
      ? 'expose_via_devbridge'
      : missing.includes('nginx_serving')
        ? 'configure_nginx'
        : missing.includes('qr_code')
          ? 'generate_qr_code'
          : parseWarning
            ? 'review_raw_output'
            : 'review_checks'
    : 'complete';

  return {
    ok: true,
    complete,
    checkType: isCrossPlatform ? 'cross-platform' : 'standard',
    checks,
    score,
    publicUrl,
    missingSteps: missing.length > 0 ? missing.join(', ') : undefined,
    parseWarning,
    rawOutput: parseWarning ? stdout.trim() : undefined,
    nextStep: nextStepValue,
    remediation: nextStepValue === 'expose_via_devbridge' ? buildExposeRemediation(port) : undefined,
  };
}
