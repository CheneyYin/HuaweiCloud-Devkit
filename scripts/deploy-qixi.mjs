import { execWithSession, closeAllSessions, DEFAULT_WORKSPACE_ID } from '../plugins/huaweicloud-core/src/sandbox/session-manager.mjs';
import { hdkitCheckUser, hdkitSignAgreement, hdkitConnect, hdkitCredentials } from '../plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const localFile = resolve(__dirname, '../demos/qixi-companion/index.html');
const remoteDir = '/workspace/qixi-companion';
const remoteFile = `${remoteDir}/index.html`;
const port = 8080;

function stripAnsi(str) {
  return String(str ?? '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\]133;[A-Z]/g, '').trim();
}

async function safeExec(wsId, cmd, timeout = 30000) {
  const r = await execWithSession(wsId, cmd, 'root', timeout);
  return { stdout: stripAnsi(r.stdout), exitCode: r.exitCode };
}

async function uploadFile(wsId, localPath, remotePath) {
  const content = readFileSync(localPath);
  const base64 = content.toString('base64');
  const tmpFile = `${remotePath}.b64tmp`;

  console.log('  Cleaning up temp file...');
  await safeExec(wsId, `rm -f "${tmpFile}"`);

  const CHUNK = 2000;
  for (let i = 0; i < base64.length; i += CHUNK) {
    const chunk = base64.slice(i, i + CHUNK);
    const res = await safeExec(wsId, `printf '%s' '${chunk}' >> "${tmpFile}"`, 30000);
    if (res.exitCode !== 0) {
      throw new Error(`Chunk ${Math.floor(i / CHUNK) + 1} failed: ${res.stdout}`);
    }
    process.stdout.write(`\r  Uploading chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(base64.length / CHUNK)}`);
  }
  console.log('');

  console.log('  Decoding and writing file...');
  const decode = await safeExec(wsId, `base64 -d "${tmpFile}" > "${remotePath}" && rm -f "${tmpFile}"`);
  if (decode.exitCode !== 0) throw new Error('Decode failed: ' + decode.stdout);

  console.log('  Verifying...');
  const verify = await safeExec(wsId, `ls -l "${remotePath}" | awk '{print $5}'`);
  const remoteSize = parseInt(verify.stdout.replace(/\D/g, ''), 10);
  if (remoteSize !== content.length) {
    throw new Error(`Size mismatch: local=${content.length}, remote=${remoteSize}`);
  }
  console.log('  Verified: ' + content.length + ' bytes');

  return { ok: true, bytes: content.length };
}

async function main() {
  console.log('Checking sandbox user...');
  try {
    const user = await hdkitCheckUser();
    console.log('  User:', JSON.stringify(user));
  } catch (e) {
    console.log('  User check:', e.message, '- trying sign...');
    await hdkitSignAgreement();
    console.log('  Agreement signed.');
  }

  console.log('Connecting to sandbox...');
  const connectResult = await hdkitConnect();
  const sessionId = connectResult.sessionId || connectResult.session_id;
  const devStageId = connectResult.devStageId || connectResult.dev_stage_id || sessionId;
  console.log('  session_id:', sessionId);
  console.log('  dev_stage_id:', devStageId);

  console.log('Injecting credentials...');
  const creds = await hdkitCredentials(sessionId, null, true);
  console.log('  Credentials:', creds.ok ? 'ok' : JSON.stringify(creds));

  const wsId = devStageId || DEFAULT_WORKSPACE_ID;
  console.log('Using workspace_id:', wsId);

  console.log('Creating remote directory...');
  const mkdir = await safeExec(wsId, `mkdir -p "${remoteDir}"`);
  console.log('  mkdir:', mkdir.exitCode === 0 ? 'ok' : JSON.stringify(mkdir));

  console.log('Uploading index.html...');
  const up = await uploadFile(wsId, localFile, remoteFile);
  console.log('  Upload:', up.ok ? 'ok (' + up.bytes + ' bytes)' : JSON.stringify(up));

  console.log('Stopping any previous server...');
  await safeExec(wsId, 'pkill -f "python3 -m http.server 8080" 2>/dev/null; pkill -f "devbridge host" 2>/dev/null; true');

  console.log('Starting HTTP server on port ' + port + '...');
  const serverResult = await safeExec(
    wsId,
    `cd "${remoteDir}" && nohup python3 -m http.server ${port} > /tmp/http-server.log 2>&1 & echo "PID=$!"`,
    30000
  );
  console.log('  Server:', serverResult.stdout);

  console.log('Starting devbridge tunnel...');
  await safeExec(wsId, `nohup devbridge host -p ${port} > /tmp/devbridge.log 2>&1 &`, 10000);
  await new Promise(r => setTimeout(r, 4000));
  const tunnelResult = await safeExec(wsId, 'cat /tmp/devbridge.log', 10000);
  console.log('  Tunnel log:', tunnelResult.stdout);

  closeAllSessions();
  console.log('\nDeployment complete!');
}

main().catch(err => {
  console.error('Deployment failed:', err.message);
  process.exit(1);
});