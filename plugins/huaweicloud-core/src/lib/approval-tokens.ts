import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { redactSecrets } from '../safety-policy.ts';

// Face-neutral approval tokens: the consent layer every execution face
// shares. The CLI face (plan_cli_command / run_approved_command in the
// huaweicloud-cli pack) and the API face (the open-mcp approval bridge)
// both mint and consume tokens through this module; nothing here knows
// hcloud — the payload is an opaque serializable value, hashed, redacted,
// and persisted with a TTL.
//
// hcloud-cli.ts re-exports these for its own call sites (the
// tool-schemas.ts re-export precedent); new faces should import this
// module directly.

// Approval tokens must survive a process boundary: plan and run land in
// different MCP sessions/processes (and headless subprocesses), so the old
// in-memory Map lost the token and plan→approve→run became unreachable (#578).
// Persist to a per-user JSON file as the single source of truth. Only the
// sha256 of the args plus the redacted form are stored — never the raw args,
// which may carry --adminPass / --server.user_data secrets.
interface ApprovalEntry {
  argsHash: string;
  argsRedacted: unknown;
  createdAt: number;
}

type ApprovalMap = Record<string, ApprovalEntry>;

const APPROVAL_TTL_MS = 5 * 60_000;

function approvalFilePath(): string {
  return join(process.env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud', 'approvals.json');
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashArgs(args: unknown): string {
  return sha256Hex(JSON.stringify(args));
}

function readApprovals(): ApprovalMap {
  try {
    const path = approvalFilePath();
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: ApprovalMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.argsHash !== 'string' || typeof entry.createdAt !== 'number') continue;
      result[key] = { argsHash: entry.argsHash, argsRedacted: entry.argsRedacted, createdAt: entry.createdAt };
    }
    return result;
  } catch {
    return {};
  }
}

function writeApprovals(map: ApprovalMap): void {
  try {
    const path = approvalFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(map), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Best-effort: an in-file failure degrades cross-process persistence but a
    // token created/consumed within one process still works.
  }
}

function pruneStale(map: ApprovalMap, now = Date.now()): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(map)) {
    if (now - value.createdAt > APPROVAL_TTL_MS) {
      delete map[key];
      changed = true;
    }
  }
  return changed;
}

export function createApprovalToken(rawArgs: unknown): string {
  const token = randomUUID();
  const map = readApprovals();
  map[token] = {
    argsHash: hashArgs(rawArgs),
    argsRedacted: redactSecrets(rawArgs),
    createdAt: Date.now(),
  };
  pruneStale(map);
  writeApprovals(map);
  return token;
}

export function consumeApprovalToken(token: string): ApprovalEntry | null {
  const map = readApprovals();
  const entry = map[token];
  if (!entry) return null;
  if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) {
    delete map[token];
    writeApprovals(map);
    return null;
  }
  delete map[token];
  writeApprovals(map);
  return entry;
}
