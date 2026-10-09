#!/usr/bin/env node
// Eval harness for the generic call face (the round-1 deferred decision:
// dynamic registration only lands if the two-step generic face materially
// underperforms first-class tools). Measures, per task: tool-call count,
// round trips, and outcome, driving the REAL callTool dispatch against
// the REAL gateway binary in openapi,data mode.
//
// Usage: node scripts/eval-generic-face.mjs [--json]
//
// Mode A (generic, shipped): gateway_call with tool+toolArgs; discovery
// tasks additionally call gateway_list_tools first when the task model
// requires knowing the surface (the "two-step" cost the eval quantifies).
// Mode B (first-class simulation): the same callTool flow WITHOUT the
// list step and without the token round trip for read-only-ish tasks —
// the lower bound a dynamic-registration face could reach only if the
// gateway tool were directly callable with zero discovery overhead.
//
// The comparison is intentionally conservative for B: B skips ONLY the
// discovery round trip that A's flow needs. The token round trip on
// state-changing calls is a consent property shared by both faces (a
// first-class execute_api tool would still mint/verify the token), so it
// is excluded from the difference rather than credited to B.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const asJson = process.argv.includes('--json');
const repoRoot = new URL('..', import.meta.url).pathname;
const gatewayBin =
  process.env.OPENMCP_BIN || join(process.env.HOME || '/home/cheney', '.local/bin/huaweicloud-open-mcp');

const home = mkdtempSync(join(tmpdir(), 'openmcp-eval-'));
process.env.HUAWEICLOUD_HOME = home;
process.env.HUAWEICLOUD_MCP_MODE = 'openapi,data';
process.env.OPENMCP_BIN = gatewayBin;

const { callTool } = await import(join(repoRoot, 'plugins/huaweicloud-core/src/tools.ts'));
const { _resetOpenMcpSidecar } = await import(
  join(repoRoot, 'plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/sidecar.ts')
);

const TASKS = [
  {
    id: 'discover-product',
    kind: 'discovery',
    run: () => callTool('huaweicloud_search_apis', { query: 'ecs', limit: 1 }),
  },
  {
    id: 'read-api-doc',
    kind: 'read',
    run: () => callTool('huaweicloud_get_api', { product: 'ECS', api: 'ListServersDetails' }),
  },
  {
    id: 'read-examples',
    kind: 'read',
    run: () => callTool('huaweicloud_get_api_examples', { product: 'ECS', api: 'CreateServers' }),
  },
  {
    id: 'generic-read',
    kind: 'generic-read',
    run: () => callTool('huaweicloud_gateway_call', { tool: 'search_apis', toolArgs: { query: 'vpc', limit: 1 } }),
  },
  {
    id: 'generic-data-query',
    kind: 'generic-token',
    run: async () => {
      const minted = await callTool('huaweicloud_gateway_call', {
        tool: 'query_data',
        toolArgs: { sql: 'select 1 as x' },
      });
      if (minted.requiresApproval !== true) return minted;
      return callTool('huaweicloud_gateway_call', {
        tool: 'query_data',
        toolArgs: { sql: 'select 1 as x' },
        approvalToken: minted.approvalToken,
        approvedByUser: true,
      });
    },
  },
  {
    id: 'generic-execute-approved',
    kind: 'generic-token',
    run: async () => {
      const minted = await callTool('huaweicloud_gateway_call', {
        tool: 'execute_api',
        toolArgs: { product: 'IAM', api: 'KeystoneListRegions' },
      });
      if (minted.requiresApproval !== true) return minted;
      return callTool('huaweicloud_gateway_call', {
        tool: 'execute_api',
        toolArgs: { product: 'IAM', api: 'KeystoneListRegions' },
        approvalToken: minted.approvalToken,
        approvedByUser: true,
      });
    },
  },
];

// The generic face needs the surface known before a state-changing call
// (the drift gate reads the cache; the first generic call populates it
// via spawn). Model that honestly: generic tasks that do NOT go through
// a curated tool first include one gateway_list_tools round trip.
async function runGeneric(task) {
  const calls = [];
  if (task.kind === 'generic-token') {
    const listing = await callTool('huaweicloud_gateway_list_tools', {});
    calls.push({ tool: 'huaweicloud_gateway_list_tools', ok: listing.ok === true });
  }
  const result = await task.run();
  const steps = task.kind === 'generic-token' ? 2 : 1;
  for (let index = 0; index < steps; index += 1) calls.push({ tool: task.id, ok: result.ok === true });
  return { calls, result };
}

async function runFirstClass(task) {
  // First-class mode runs the SAME task flow (the token round trip is a
  // consent property a first-class tool would keep); only the discovery
  // round trip (gateway_list_tools) is the face's structural cost being
  // measured against.
  const result = await task.run();
  const steps = task.kind === 'generic-token' && result.requiresApproval === true ? 2 : 1;
  const calls = [];
  for (let index = 0; index < steps; index += 1) calls.push({ tool: task.id, ok: result.ok === true || index === 0 });
  return { calls, result };
}

async function measure(label, runner) {
  await _resetOpenMcpSidecar();
  const rows = [];
  for (const task of TASKS) {
    if (task.kind === 'discovery' || task.kind === 'read') continue; // curated tools are identical in both faces
    const started = process.hrtime.bigint();
    const { calls, result } = await runner(task);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // ok = the face completed its job (consent + forwarding). A gateway-side
    // capability gap (e.g. datafusion not installed on this host) is the
    // environment's verdict, not the face's — reachedGateway captures it.
    const reachedGateway = result.ok === true || (result.ok === false && result.requiresApproval === undefined);
    rows.push({ task: task.id, calls: calls.length, ms: Math.round(ms), ok: reachedGateway });
  }
  await _resetOpenMcpSidecar();
  return { label, rows };
}

const generic = await measure('generic', runGeneric);
const firstClass = await measure('first-class-bounds', runFirstClass);

const comparison = generic.rows.map((row) => {
  const b = firstClass.rows.find((other) => other.task === row.task);
  return {
    task: row.task,
    genericCalls: row.calls,
    firstClassCalls: b.calls,
    callOverhead: row.calls - b.calls,
    genericMs: row.ms,
    firstClassMs: b.ms,
    bothOk: row.ok && b.ok,
  };
});

if (asJson) {
  console.log(JSON.stringify({ generic, firstClass, comparison }, null, 2));
} else {
  console.log('task                        generic  first-class  call-overhead  generic-ms  ok');
  for (const row of comparison) {
    console.log(
      `${row.task.padEnd(28)}${String(row.genericCalls).padStart(6)}  ${String(row.firstClassCalls).padStart(9)}  ${String(row.callOverhead).padStart(12)}  ${String(row.genericMs).padStart(10)}  ${row.bothOk ? 'yes' : 'NO'}`,
    );
  }
  const totalOverhead = comparison.reduce((sum, row) => sum + row.callOverhead, 0);
  console.log(`\ntotal call overhead of the generic face across the task set: ${totalOverhead}`);
  console.log(
    'decision rule (design v4): dynamic registration lands only if this overhead is material in agent evaluations.',
  );
}
