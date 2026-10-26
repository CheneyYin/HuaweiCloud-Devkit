// The seam-var assembly for case sessions and the PATH-level hcloud
// hardening — the hermetic boundary every attempt runs behind.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { E2eCase } from './types.ts';
import type { HttpFake } from './http-fake.ts';

const fakeHcloud = fileURLToPath(new URL('../fixtures/fake-hcloud.ts', import.meta.url));
const fakeOpenMcp = fileURLToPath(new URL('../fixtures/fake-open-mcp-sidecar.mjs', import.meta.url));

export function seamVars(
  home: string,
  scriptPath: string | null,
  kooCliVersion: string,
  httpFake: HttpFake,
  fixtures: E2eCase['fixtures'],
  pathShimDir: string,
  // Install-phase hcloud probes (the installer's version checks) ride a
  // separate log so the run-session recording names agent activity only: a
  // dead agent then reads as "All calls: (none)" instead of "version |
  // version", and install-crash vs dead-agent stays distinguishable in the
  // report (installHcloudCalls vs hcloudCalls).
  hcloudLog = 'hcloud-fake.log',
): NodeJS.ProcessEnv {
  const vars: NodeJS.ProcessEnv = {
    HCLOUD_BIN: process.execPath,
    HCLOUD_BIN_ARGS_JSON: JSON.stringify([fakeHcloud]),
    HCLOUD_FAKE_LOG: join(home, hcloudLog),
    HCLOUD_FAKE_VERSION: kooCliVersion,
    HUAWEICLOUD_DEVKIT_TRACE: join(home, 'devkit-trace.jsonl'),
    // The whole Huawei Cloud HTTP boundary points at the local fake — every
    // case, scripted or not, so no request can ever leave the machine.
    // Unknown paths answer 404 (fast, deterministic) instead of hanging.
    HDKITSERVICE_ENDPOINT: httpFake.hdkitserviceBaseUrl,
    HW_IAM_ENDPOINT: httpFake.baseUrl,
    HWLINK_ENDPOINT: httpFake.baseUrl,
    // The gateway sidecar: the repo's fake fixture, spawned lazily by the
    // first gateway tool call, recording every JSON-RPC request.
    OPENMCP_BIN: fakeOpenMcp,
    OPENMCP_FAKE_LOG: join(home, 'openmcp-fake.log'),
    // PATH hardening: shim dir first, so a Bash-layer `hcloud` resolves to
    // the fake, never the host's real binary (see installPathShim).
    PATH: [pathShimDir, process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':'),
  };
  if (fixtures.openMcp?.policyTools) vars.FAKE_POLICY = '1';
  if (scriptPath) vars.HCLOUD_FAKE_SCRIPT = scriptPath;
  return vars;
}

// PATH-level hardening: the host may have a real hcloud on PATH
// (~/.local/bin/hcloud). The MCP layer reaches the fake via HCLOUD_BIN,
// but a Bash-layer `hcloud ...` would PATH-resolve to the REAL binary and
// touch the real cloud. The wrapper makes every PATH lookup land on the
// fake instead — same recording log, same scripted answers — so the suite
// stays hermetic even if the agent's shell permission posture changes.
export function installPathShim(home: string): string {
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  // exec node <fake> "$@": keeps the fake's argv.slice(2) recording shape
  // identical to the MCP-driven invocations.
  writeFileSync(join(binDir, 'hcloud'), `#!/bin/sh\nexec "${process.execPath}" "${fakeHcloud}" "$@"\n`, {
    mode: 0o755,
    encoding: 'utf8',
  });
  // The win32 sibling, always written: cmd.exe resolves bare `hcloud` via
  // PATHEXT to hcloud.cmd — without it the PATH entry is a dead file on
  // win32 and lookups fall through to the host's real binary. On POSIX the
  // .cmd file is inert (nothing resolves it).
  writeFileSync(join(binDir, 'hcloud.cmd'), `@"${process.execPath}" "${fakeHcloud}" %*\r\n`, { encoding: 'utf8' });
  return binDir;
}
