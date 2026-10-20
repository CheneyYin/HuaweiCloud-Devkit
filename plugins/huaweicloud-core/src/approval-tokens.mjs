import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { redactSecrets } from './safety-policy.mjs';

// Shared approval-token machinery, consumed by every CLI wrapper
// (hcloud-cli.mjs, agentarts-cli.mjs). Extracted from hcloud-cli.mjs so the
// cross-process persistence, TTL pruning, single-use tombstones, and atomic
// writes (#578, #745) have exactly one implementation.
//
// Cross-CLI confusion guard: the CLI id is mixed into the args hash AND
// stored on each entry, so a token minted by one wrapper can never approve
// another wrapper's command — `agentarts plan(['gateway','delete','x'])`
// cannot be consumed by `hcloud run_approved` with the same array.
//
// Only the sha256 of the namespaced args plus the redacted form are stored —
// never the raw args, which may carry secrets.

const APPROVAL_TTL_MS = 5 * 60_000;

function approvalFilePath() {
  return join(process.env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud', 'approvals.json');
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function hashNamespacedArgs(cli, args) {
  return sha256Hex(JSON.stringify({ cli, args: (Array.isArray(args) ? args : []).map(String) }));
}

function readApprovals() {
  try {
    const path = approvalFilePath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeApprovals(map) {
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

function pruneStale(map, now = Date.now()) {
  let changed = false;
  for (const [key, value] of Object.entries(map)) {
    if (now - value.createdAt > APPROVAL_TTL_MS) {
      delete map[key];
      changed = true;
    }
  }
  return changed;
}

// Approval token lifecycle states, surfaced to callers so they can emit the
// precise JSON contract required by D4-24 (#745):
//   'valid'            — token exists, not expired, not yet consumed
//   'expired'          — token exists but createdAt is past APPROVAL_TTL_MS
//   'already_consumed' — token was consumed on a prior call (tombstone kept)
//   'not_found'        — token was never created, pruned, or minted by a
//                        different CLI namespace
export const TOKEN_STATE_VALID = 'valid';
export const TOKEN_STATE_EXPIRED = 'expired';
export const TOKEN_STATE_ALREADY_CONSUMED = 'already_consumed';
export const TOKEN_STATE_NOT_FOUND = 'not_found';

function entryBelongsToCli(entry, cli) {
  // Entries written before the namespace split carry no cli field; they are
  // hcloud tokens (the only pre-existing wrapper).
  return (entry.cli || 'hcloud') === cli;
}

export function createApprovalTokenStore(cli) {
  const create = (rawArgs) => {
    const token = randomUUID();
    const map = readApprovals();
    map[token] = {
      cli,
      argsHash: hashNamespacedArgs(cli, rawArgs),
      argsRedacted: redactSecrets(rawArgs),
      createdAt: Date.now(),
    };
    pruneStale(map);
    writeApprovals(map);
    return token;
  };

  const inspect = (token) => {
    const map = readApprovals();
    const entry = map[token];
    if (!entry || !entryBelongsToCli(entry, cli)) return { state: TOKEN_STATE_NOT_FOUND };
    if (entry.consumedAt !== undefined) return { state: TOKEN_STATE_ALREADY_CONSUMED };
    if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) return { state: TOKEN_STATE_EXPIRED };
    return { state: TOKEN_STATE_VALID, entry };
  };

  const consume = (token) => {
    const map = readApprovals();
    const entry = map[token];
    if (!entry || !entryBelongsToCli(entry, cli)) return null;
    if (entry.consumedAt !== undefined) return null;
    if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) {
      delete map[token];
      writeApprovals(map);
      return null;
    }
    map[token] = { cli, consumedAt: Date.now(), createdAt: entry.createdAt };
    writeApprovals(map);
    return entry;
  };

  return {
    create,
    inspect,
    consume,
    hashArgs: (args) => hashNamespacedArgs(cli, args),
  };
}
