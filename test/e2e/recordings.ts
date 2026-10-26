// Recording collection: read the fakes' logs (hcloud argv, gateway JSON-RPC),
// the env-gated devkit trace, and the expectation-pinned files out of a
// throwaway home after an attempt.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { E2eCase, Expectation } from './types.ts';
import type { GatewayRecording, Recordings, TraceDisclosure, TraceToolCall } from './evaluate.ts';

export function readGatewayLog(home: string): GatewayRecording[] {
  const logPath = join(home, 'openmcp-fake.log');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        const record = JSON.parse(line) as { method?: string; tool?: string | null; args?: unknown };
        return { method: String(record.method ?? ''), tool: record.tool ?? null, args: record.args ?? {} };
      } catch {
        return { method: '(unparseable)', tool: null, args: {} };
      }
    });
}

export function readHcloudLog(home: string, file = 'hcloud-fake.log'): { argv: string[] }[] {
  const logPath = join(home, file);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return { argv: JSON.parse(line) as string[] };
      } catch {
        return { argv: [line] };
      }
    });
}

export function readTrace(home: string): { toolCalls: TraceToolCall[]; disclosures: TraceDisclosure[] } {
  const tracePath = join(home, 'devkit-trace.jsonl');
  if (!existsSync(tracePath)) return { toolCalls: [], disclosures: [] };
  const toolCalls: TraceToolCall[] = [];
  const disclosures: TraceDisclosure[] = [];
  for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { type?: string };
      if (record.type === 'toolCall') {
        const call = record as unknown as TraceToolCall;
        toolCalls.push({ name: call.name, args: call.args, ok: call.ok });
      } else if (record.type === 'disclosure') {
        const event = record as unknown as TraceDisclosure;
        disclosures.push({ event: event.event, toolCount: event.toolCount });
      }
    } catch {
      // malformed trace lines are a product bug the count assertions surface
    }
  }
  return { toolCalls, disclosures };
}

export function collectFiles(caseDef: E2eCase, home: string): Record<string, string | null> {
  const paths = new Set<string>();
  const scan = (exps: Expectation[] | undefined) => {
    for (const exp of exps ?? []) {
      if (exp.kind === 'file') paths.add(exp.path);
    }
  };
  scan(caseDef.expect);
  scan(caseDef.softExpect);
  const files: Record<string, string | null> = {};
  for (const relPath of paths) {
    const full = join(home, relPath);
    try {
      files[relPath] = readFileSync(full, 'utf8');
    } catch {
      files[relPath] = null;
    }
  }
  return files;
}

// The zero-activity recordings literal, shared by runCase's initial state
// and the runner's harness-crash belt so the two cannot drift.
export function emptyRecordings(): Recordings {
  return {
    hcloud: [],
    toolCalls: [],
    disclosures: [],
    http: [],
    gateway: [],
    ws: [],
    files: {},
    finalText: null,
    exitCode: null,
  };
}
