import { execOneShot } from './hwlink-connection.ts';

// The one-shot exec seam for the DevBridge tunnel flows, extracted from
// devbridge-tunnel so every flow module (expose, renew, keepalive) shares one
// test-override point: _setOneShotForTests mutates the module state here and
// every runOneShot call resolves through it. Leaf: imports only execOneShot
// from the hwlink connection layer.

export interface OneShotResult {
  stdout: string;
  exitCode: number;
  error?: string;
}

// Test seam: exposeTunnel is otherwise untestable end-to-end (execOneShot
// opens a real ws connection). Pure helpers stay seam-free.
let oneShotForTests:
  ((workspaceId: string, command: string, username: string, timeoutMs: number) => Promise<OneShotResult>) | null = null;

export function _setOneShotForTests(
  fn: ((workspaceId: string, command: string, username: string, timeoutMs: number) => Promise<OneShotResult>) | null,
): void {
  oneShotForTests = fn;
}

export async function runOneShot(workspaceId: string, command: string, username: string, timeoutMs: number) {
  return (oneShotForTests ?? execOneShot)(workspaceId, command, username, timeoutMs);
}
