#!/usr/bin/env node
// Eval harness for the generic call face (the round-1 deferred decision:
// dynamic registration only lands if the two-step generic face materially
// underperforms first-class tools). Measures, per task: tool-call count
// and outcome, driving the REAL callTool dispatch against the REAL
// gateway binary in openapi,data mode.
//
// Usage: node scripts/eval-generic-face.mjs [--json]
//
// Face accounting (round-9/10 corrections): the token round trip is a
// consent property a first-class tool would ALSO carry, so both faces
// count it. The generic face's structural cost is the NAME-DISCOVERY
// call (gateway_list_tools) — modeled ONCE PER SESSION (not per task)
// for an unskilled agent. Zero-cost paths, in order of reach: (1) an
// agent that loaded huawei-openapi knows the names statically; (2) an
// agent that reads tool descriptions also knows them —
// huaweicloud_gateway_call's own description names all four routed tools
// and every agent consumes tools/list to discover the tool in the first
// place. The +1 therefore bounds only an agent that skips BOTH: the
// upper bound of the unskilled face, not its typical cost.
//
// Preflight: the gateway binary must resolve and complete a handshake, or
// the harness exits non-zero with a loud error — a green table must never
// be producible from absence.
//
// Timing note: the sidecar is warm across tasks and across both faces
// (spawn/handshake excluded); the generic face runs first, so gateway
// cache warming can bias the ms columns by ordering alone. Calls, not
// ms, are the decision metric.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const asJson = process.argv.includes('--json');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const gatewayBin =
  process.env.OPENMCP_BIN || join(process.env.HOME || '/home/cheney', '.local/bin/huaweicloud-open-mcp');

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
// firstClass: an alternate zero-discovery run for the same task — the
// first-class lower bound (curated tool or same flow without the list).
// needsDiscovery: the task's generic-face run requires knowing a gateway
// tool name the curated surface does not teach (declared per task, not
// derived from the id string — round-10: a rename silently changed the
// measured overhead).
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
    needsDiscovery: false,
    run: async () => ({ dispatches: 1, final: await callTool('huaweicloud_search_apis', { query: 'ecs', limit: 1 }) }),
    firstClass: async () => ({
      dispatches: 1,
      final: await callTool('huaweicloud_search_apis', { query: 'ecs', limit: 1 }),
    }),
  },
  {
    id: 'generic-read',
    // search_apis is a curated name too (the devkit ships
    // huaweicloud_search_apis), so the generic call needs no discovery.
    needsDiscovery: false,
    run: async () => ({
      dispatches: 1,
      final: await callTool('huaweicloud_gateway_call', { tool: 'search_apis', toolArgs: { query: 'vpc', limit: 1 } }),
    }),
    // The first-class bound for a read is the curated tool itself.
    firstClass: async () => ({
      dispatches: 1,
      final: await callTool('huaweicloud_search_apis', { query: 'vpc', limit: 1 }),
    }),
  },
  {
    id: 'generic-data-query',
    needsDiscovery: true,
    run: () => tokenTask('query_data', { sql: 'select 1 as x' }),
  },
  {
    id: 'generic-execute-approved',
    needsDiscovery: true,
    run: () => tokenTask('execute_api', { product: 'IAM', api: 'KeystoneListRegions' }),
  },
];

async function measure(label, runner) {
  const rows = [];
  let sessionDiscoveryCalls = 0;
  let listedThisSession = null;
  // The unskilled agent lists ONCE per session: the first
  // state-changing generic call triggers the listing; later tasks reuse
  // the knowledge (round-10: per-task listing overstated the session).
  // charged tells the caller whether THIS call is the session's first
  // (the only one that carries the +1).
  const listOncePerSession = async () => {
    if (listedThisSession) return { listing: listedThisSession, charged: false };
    sessionDiscoveryCalls += 1;
    listedThisSession = await callTool('huaweicloud_gateway_list_tools', {});
    return { listing: listedThisSession, charged: true };
  };
  for (const task of TASKS) {
    const started = process.hrtime.bigint();
    const { calls, final } = await runner(task, listOncePerSession);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // ok = the FACE completed consent + forwarding. A gateway-side
    // capability refusal (datafusion missing on this host) still proves
    // the face reached the gateway; an ok:false carrying the gateway's
    // own reason text is a reached-and-refused outcome.
    const reached = final.ok === true || (final.ok === false && typeof final.reason === 'string');
    rows.push({ task: task.id, calls, ms: Math.round(ms), ok: reached });
  }
  return { label, rows, sessionDiscoveryCalls };
}

// Generic face: an unskilled agent lists the surface ONCE per session
// before its first state-changing generic call; later discovery-needing
// tasks reuse that knowledge, so only the FIRST carries the +1 (the
// per-row overhead then sums to the session total).
async function runGeneric(task, listOncePerSession) {
  const { dispatches, final } = await task.run();
  let listCalls = 0;
  if (task.needsDiscovery) {
    const { listing, charged } = await listOncePerSession();
    listCalls = charged ? 1 : 0;
    if (listing.ok !== true)
      throw new Error(`gateway_list_tools failed mid-eval: ${JSON.stringify(listing).slice(0, 120)}`);
  }
  return { calls: dispatches + listCalls, final };
}

// First-class lower bound: the same consent flow (token round trip
// counted) with NO name-discovery call.
async function runFirstClass(task) {
  const runner = task.firstClass ?? task.run;
  const { dispatches, final } = await runner();
  return { calls: dispatches, final };
}

const generic = await measure('generic (unskilled-agent upper bound)', runGeneric);
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
  console.log(`\nsession name-discovery calls (unskilled agent): ${generic.sessionDiscoveryCalls}`);
  console.log('zero-cost paths: an agent that loaded huawei-openapi knows the names statically;');
  console.log('an agent that reads tool descriptions also knows them (gateway_call names all routed tools).');
  console.log('the +1 bounds only an agent that skips both — the unskilled upper bound.');
  console.log(
    'decision rule (design v4): dynamic registration lands only if this overhead is material in agent evaluations.',
  );
}
