#!/usr/bin/env node
// Eval harness for the generic call face (the round-1 deferred decision:
// dynamic registration only lands if the two-step generic face materially
// underperforms first-class tools). Measures, per task: tool-call count
// and outcome, driving the REAL callTool dispatch against the REAL
// gateway binary in openapi,data mode.
//
// Usage: node scripts/eval-generic-face.mjs [--json]
//
// Face accounting (round-9 correction): the token round trip is a consent
// property a first-class tool would ALSO carry, so both faces count it.
// The generic face's structural overhead is the NAME-DISCOVERY call
// (gateway_list_tools) that a cold, skill-less agent makes before its
// first state-changing generic call — an agent that loaded huawei-openapi
// knows the tool names statically and pays zero. The harness reports the
// unskilled-agent bound per task and names that framing.
//
// Preflight: the gateway binary must resolve and complete a handshake, or
// the harness exits non-zero with a loud error — a green table must never
// be producible from absence.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const asJson = process.argv.includes('--json');
const repoRoot = new URL('..', import.meta.url).pathname;
const gatewayBin =
  process.env.OPENMCP_BIN || join(process.env.HOME || '/home/cheney', '.local/bin/huaweicloud-open-mcp');

import { existsSync } from 'node:fs';
if (!existsSync(gatewayBin)) {
  console.error(
    `eval-generic-face: gateway binary not found at ${gatewayBin} (set OPENMCP_BIN). Refusing to produce evidence from absence.`,
  );
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'openmcp-eval-'));
process.env.HUAWEICLOUD_HOME = home;
process.env.HUAWEICLOUD_MCP_MODE = 'openapi,data';
process.env.OPENMCP_BIN = gatewayBin;

const { callTool } = await import(join(repoRoot, 'plugins/huaweicloud-core/src/tools.ts'));
const { _resetOpenMcpSidecar } = await import(
  join(repoRoot, 'plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/sidecar.ts')
);

// Preflight: one real dispatch must reach the gateway (spawn + handshake +
// proxy round trip). Any failure here aborts before a table exists.
await _resetOpenMcpSidecar();
const preflight = await callTool('huaweicloud_gateway_list_tools', {});
if (preflight.ok !== true) {
  console.error(`eval-generic-face: gateway preflight failed: ${JSON.stringify(preflight).slice(0, 200)}`);
  process.exit(1);
}

// Each task returns { dispatches, final }: dispatches counts actual
// callTool invocations (mint AND replay both count — the consent round
// trip rides both faces), final is the last result for the outcome row.
async function tokenTask(tool, toolArgs) {
  const minted = await callTool('huaweicloud_gateway_call', { tool, toolArgs });
  if (minted.requiresApproval !== true) return { dispatches: 1, final: minted };
  const replay = await callTool('huaweicloud_gateway_call', {
    tool,
    toolArgs,
    approvalToken: minted.approvalToken,
    approvedByUser: true,
  });
  return { dispatches: 2, final: replay };
}

const TASKS = [
  {
    id: 'curated-read',
    // The curated discovery tools are first-class ALREADY — both faces
    // call the same tool. Included so the read-path row is measured, not
    // asserted.
    run: async () => ({ dispatches: 1, final: await callTool('huaweicloud_search_apis', { query: 'ecs', limit: 1 }) }),
  },
  {
    id: 'generic-read',
    run: async () => ({
      dispatches: 1,
      final: await callTool('huaweicloud_gateway_call', { tool: 'search_apis', toolArgs: { query: 'vpc', limit: 1 } }),
    }),
  },
  { id: 'generic-data-query', run: () => tokenTask('query_data', { sql: 'select 1 as x' }) },
  {
    id: 'generic-execute-approved',
    run: () => tokenTask('execute_api', { product: 'IAM', api: 'KeystoneListRegions' }),
  },
];

async function runGeneric(task) {
  // The unskilled-agent shape: the agent does not know the gateway tool
  // names and lists the surface once before its first state-changing
  // generic call. This is the face's structural cost being measured.
  const dispatches = [await task.run()];
  const needsDiscovery = task.id.startsWith('generic-') && task.id !== 'generic-read';
  let listCalls = 0;
  if (needsDiscovery) {
    const listing = await callTool('huaweicloud_gateway_list_tools', {});
    listCalls = 1;
    if (listing.ok !== true)
      throw new Error(`gateway_list_tools failed mid-eval: ${JSON.stringify(listing).slice(0, 120)}`);
  }
  return { calls: dispatches[0].dispatches + listCalls, final: dispatches[0].final };
}

async function runFirstClass(task) {
  // The first-class lower bound: the same consent flow, no name-discovery
  // call. The token round trip counts here too — a first-class execute
  // tool would still mint and verify.
  const { dispatches, final } = await task.run();
  return { calls: dispatches, final };
}

async function measure(label, runner) {
  const rows = [];
  for (const task of TASKS) {
    const started = process.hrtime.bigint();
    const { calls, final } = await runner(task);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // ok = the FACE completed consent + forwarding. A gateway-side
    // capability refusal (datafusion missing on this host) still proves
    // the face reached the gateway; an ok:false carrying the gateway's
    // own reason text is a reached-and-refused outcome.
    const reached = final.ok === true || (final.ok === false && typeof final.reason === 'string');
    rows.push({ task: task.id, calls, ms: Math.round(ms), ok: reached });
  }
  return { label, rows };
}

const generic = await measure('generic (unskilled-agent bound)', runGeneric);
const firstClass = await measure('first-class bounds', runFirstClass);
await _resetOpenMcpSidecar();

const comparison = generic.rows.map((row) => {
  const b = firstClass.rows.find((other) => other.task === row.task);
  return {
    task: row.task,
    genericCalls: row.calls,
    firstClassCalls: b.calls,
    callOverhead: row.calls - b.calls,
    genericMs: row.ms,
    firstClassMs: b.ms,
    bothReached: row.ok && b.ok,
  };
});

if (asJson) {
  console.log(JSON.stringify({ generic, firstClass, comparison }, null, 2));
} else {
  console.log('task                        generic  first-class  call-overhead  generic-ms  reached');
  for (const row of comparison) {
    console.log(
      `${row.task.padEnd(28)}${String(row.genericCalls).padStart(6)}  ${String(row.firstClassCalls).padStart(9)}  ${String(row.callOverhead).padStart(12)}  ${String(row.genericMs).padStart(10)}  ${row.bothReached ? 'yes' : 'NO'}`,
    );
  }
  const totalOverhead = comparison.reduce((sum, row) => sum + row.callOverhead, 0);
  console.log(`\ntotal name-discovery overhead (unskilled agent): ${totalOverhead}`);
  console.log('an agent that loaded huawei-openapi pays 0: the skill teaches the tool names.');
  console.log(
    'decision rule (design v4): dynamic registration lands only if this overhead is material in agent evaluations.',
  );
}
