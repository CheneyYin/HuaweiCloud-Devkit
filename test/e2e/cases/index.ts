// The single assembly of every e2e case, shared by the runner (execution
// order) and the roster guard test (name validation). Importing runner.ts
// from a test is unsafe — its top-level void main() would run the full
// LLM suite whenever E2E_ENABLE=1 — so the assembly lives here,
// side-effect-free. A future case module wired here is automatically in
// both consumers; the count assertion in the roster guard makes count
// drift against the docs/workflow numbers fail loudly.
import { coreCases } from './core.ts';
import { cliCases } from './cli.ts';
import { updateCases } from './update.ts';
import { obsCases, discoveryCases } from './local-packs.ts';
import { openMcpCases } from './open-mcp.ts';
import { authCases, voucherCases, sandboxCases, wsSandboxCases } from './http-packs.ts';
import type { E2eCase } from '../types.ts';

export const ALL_CASES: E2eCase[] = [
  ...cliCases,
  ...coreCases,
  ...authCases,
  ...voucherCases,
  ...sandboxCases,
  ...wsSandboxCases,
  ...openMcpCases,
  ...obsCases,
  ...discoveryCases,
  ...updateCases,
];
