// Full-chain plumbing proof without the LLM: tarball → install → MCP server
// → callTool → hcloud shim → recording. Drives the installed server over the
// dual-framing stdio transport with initialize + tools/list + check_cli +
// plan_cli_command, then asserts the fake recorded the version probe. The
// assertion ladder lives in selfcheck-verify.ts (pure over the evidence).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import { buildCaseEnv } from './env-policy.ts';
import { HttpFake } from './http-fake.ts';
import { WsFake } from './ws-fake/hwlink-server.ts';
import { out, TEMP_PREFIX } from './harness.ts';
import { installPathShim, seamVars } from './seams.ts';
import { runInstall } from './pack-install.ts';
import { readHcloudLog, readTrace } from './recordings.ts';
import { verifySelfcheckLegs } from './selfcheck-verify.ts';

export async function selfcheck(bin: string, kooCliVersion: string): Promise<boolean> {
  const home = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}selfcheck-`));
  const wsFake = new WsFake();
  try {
    // Ws fake first: its ephemeral port resolves {wsUrl} in the hwlink
    // GET-poll script (connection_info.url), same token flow as a case.
    await wsFake.start();
    const hwlinkScript = JSON.stringify({
      responses: [
        {
          path: '/voucher/status',
          method: 'GET',
          status: 200,
          body: { claimed: true, voucherId: 'vou-selfcheck-001' },
        },
        { path: '/check-user', method: 'GET', status: 200, body: { realnameVerified: true, agreementSigned: true } },
        {
          path: '/connect',
          method: 'POST',
          status: 200,
          body: { session_id: 'sess-sc-001', dev_stage_id: 'ds-selfcheck-001' },
        },
        {
          path: '/open-api-public/v1/devenvs/ds-selfcheck-001/connections',
          method: 'POST',
          status: 200,
          body: { error_code: '0000', result: { connection_id: 'conn-sc-1' } },
        },
        {
          path: '/open-api-public/v1/devenvs/ds-selfcheck-001/connections/conn-sc-1',
          method: 'GET',
          status: 200,
          body: { result: { connection_info: { url: '{wsUrl}', extensions: { source: 424242 } } } },
        },
      ],
    }).replaceAll('{wsUrl}', wsFake.wsUrl);
    const httpFake = new HttpFake(JSON.parse(hwlinkScript));
    try {
      await httpFake.start();
      // S1 vault seed: voucher_status reads credentials via hdkitRequest,
      // which throws without them — the same precondition the live case has.
      mkdirSync(join(home, '.config', 'huaweicloud'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'huaweicloud', 'credentials.json'),
        JSON.stringify({ ak: 'SELFCHECK_AK', sk: 'SELFCHECK_SK', securityToken: '', region: 'cn-north-4' }, null, 2),
        'utf8',
      );
      const env = buildCaseEnv({
        processEnv: process.env,
        home,
        seamVars: seamVars(home, null, kooCliVersion, httpFake, {}, installPathShim(home)),
      });
      runInstall(bin, home, home, env, 'opencode');
      const server = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');
      if (!existsSync(server)) {
        out(`[selfcheck] FAIL installed server missing: ${server}`);
        return false;
      }
      const requests = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'e2e-selfcheck', version: '0' },
          },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'huaweicloud_check_cli',
            arguments: { vendorConfirmed: 'test: vendor established by the harness' },
          },
        },
        {
          // The challenge dance, driven on the wire: the session's FIRST
          // asserted gated call (id 3) bounces once with the
          // BY-THE-USER-or-assumed challenge; the retry (id 9) clears it.
          // The selfcheck never sets HUAWEICLOUD_VENDOR_CHALLENGE, so this
          // leg pins the real behavior the e2e tier exercises.
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: {
            name: 'huaweicloud_check_cli',
            arguments: { vendorConfirmed: 'test: vendor established by the harness' },
          },
        },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'huaweicloud_plan_cli_command',
            arguments: {
              vendorConfirmed: 'test: vendor established by the harness',
              args: ['VPC', 'ListSecurityGroups', '--cli-region=cn-north-4'],
            },
          },
        },
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'huaweicloud_voucher_status', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'huaweicloud_sandbox_connect',
            arguments: { vendorConfirmed: 'test: vendor established by the harness' },
          },
        },
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'huaweicloud_list_skills', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: {
            name: 'huaweicloud_sandbox_exec_one_shot',
            // >8172-byte command: the client chunks terminal input at 8172
            // bytes, so this leg proves the fake's per-connection byte-stream
            // reassembly (a line-oriented fake fails here).
            arguments: { workspace_id: 'ds-selfcheck-001', command: `echo ${'A'.repeat(100_000)}` },
          },
        },
      ];
      // Drive the server like a real client: keep stdin OPEN until the last
      // (slow, HTTP-bound) response arrives, then close. spawnSync would end
      // stdin with the input, and the transport's stdin-close semantics
      // process.exit(0) before the voucher HTTP roundtrip completes.
      const res = await new Promise<{ stdout: string; stderr: string }>((resolveRun) => {
        const child = spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let closed = false;
        const timer = setTimeout(() => {
          if (!closed) child.stdin.end();
        }, 55_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          // The last request's response is on the wire — close like a client.
          // The slow exec rides LAST on purpose: when its response arrives,
          // every faster request before it has already answered, so closing
          // here cannot kill an in-flight response.
          if (!closed && stdout.includes('"id":8')) {
            closed = true;
            clearTimeout(timer);
            child.stdin.end();
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolveRun({ stdout, stderr });
        });
        child.on('error', (error) => {
          stderr += String(error);
          resolveRun({ stdout, stderr });
        });
        for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
      });
      const responses = new Map<number, unknown>();
      for (const line of String(res.stdout).split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line) as { id?: number };
          if (typeof parsed.id === 'number') responses.set(parsed.id, parsed);
        } catch {
          // framing noise
        }
      }
      // The assertion ladder is pure over the collected evidence; every
      // read below happens after the child closed (nothing mutates between
      // collection and verification).
      return verifySelfcheckLegs({
        responses,
        hcloudCalls: readHcloudLog(home).map((c) => c.argv.join(' ')),
        ...readTrace(home),
        httpRecordings: httpFake.recordings,
        wsCommands: wsFake.connections.flatMap((conn) => conn.commands.map((cmd) => cmd.intent)),
      });
    } finally {
      await httpFake.stop();
    }
  } finally {
    await wsFake.stop();
    rmSync(home, { recursive: true, force: true });
  }
}
