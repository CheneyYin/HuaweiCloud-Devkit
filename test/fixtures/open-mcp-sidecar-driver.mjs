#!/usr/bin/env node
// Parent-death driver for the open-mcp sidecar lifetime test. Spawns the
// sidecar through the REAL module (so the stdin-pipe wiring under test is
// the production one), makes one call, prints the child pid, then exits.
// The test asserts the sidecar dies after this driver exits.
process.env.OPENMCP_BIN = new URL('./fake-open-mcp-sidecar.mjs', import.meta.url).pathname;

const { callOpenMcpTool } = await import('../../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/sidecar.ts');
const result = await callOpenMcpTool('search_apis', { query: 'driver' });
if (result.ok !== true || typeof result.pid !== 'number') {
  console.error(`driver call failed: ${JSON.stringify(result)}`);
  process.exit(1);
}
console.log(result.pid);
// The pipes to the sidecar child keep this process's event loop alive; the
// lifetime contract under test is "child dies with parent", so exit now.
process.exit(0);
