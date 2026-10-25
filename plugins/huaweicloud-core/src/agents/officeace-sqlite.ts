// The OfficeAce sqlite connector family, split out of agents/officeace.ts for
// the complex-file bar: the node:sqlite module surface (runtime-only builtin
// loaded through createRequire), the database path + connection, the
// owner_user_id resolution, and the DEVKIT_PACKS read. The connector-row
// write/remove domain logic lives in agents/officeace-registry.ts; the
// capabilities-root resolution and the lifecycle stay in agents/officeace.ts,
// with the path family in officeace-paths.ts (the shared leaf).
// agent-registration.ts keeps its own smaller sqlite model: it is the MCP
// graph's read-side probe and must stay lazily loaded there.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { asText } from '../lib/as-text.ts';
import { asRecord } from '../lib/as-record.ts';
import { officeaceCapabilitiesDirSafe } from '../officeace-paths.ts';

// node:sqlite is a runtime-only builtin loaded through createRequire; only the
// DatabaseSync surface this module calls is modeled (see auth/agent-registration.ts).
interface SqliteRunResult {
  changes?: unknown;
}

interface SqliteStatement {
  get: (..._params: unknown[]) => unknown;
  run: (..._params: unknown[]) => SqliteRunResult;
}

export interface SqliteDatabase {
  prepare: (_sql: string) => SqliteStatement;
  close: () => void;
}

interface SqliteModule {
  DatabaseSync: new (_path: string) => SqliteDatabase;
}

function toSqliteModule(value: unknown): SqliteModule | null {
  if (!value || typeof value !== 'object') return null;
  const ctor = (value as { DatabaseSync?: unknown }).DatabaseSync;
  return typeof ctor === 'function' ? (value as SqliteModule) : null;
}

const sqliteModule = toSqliteModule(createRequire(import.meta.url)('node:sqlite'));
if (!sqliteModule) {
  throw new Error('node:sqlite is unavailable; the OfficeAce integration requires Node.js >= 22');
}
const { DatabaseSync } = sqliteModule;

export function officeaceSqlitePath(): string {
  const capDir = officeaceCapabilitiesDirSafe();
  return join(resolve(capDir, '..'), 'data', 'mcp-connectors.sqlite');
}

export function openOfficeaceDb(): SqliteDatabase {
  return new DatabaseSync(officeaceSqlitePath());
}

export function officeaceGetOwnerUserId(): string | number | null {
  if (!existsSync(officeaceSqlitePath())) return null;
  try {
    const db = openOfficeaceDb();
    const row: unknown = db
      .prepare('SELECT owner_user_id FROM mcp_connectors WHERE owner_user_id IS NOT NULL LIMIT 1')
      .get();
    db.close();
    const value = asRecord(row).owner_user_id;
    return typeof value === 'string' || typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

// The OfficeAce sqlite registry's DEVKIT_PACKS value — registry I/O, not
// policy, so it stays with the officeace adapter family.
export function readOfficeaceDevkitPacks(): string | null {
  if (!existsSync(officeaceSqlitePath())) return null;
  let db: SqliteDatabase | null = null;
  try {
    db = openOfficeaceDb();
    const row: unknown = db.prepare("SELECT env_json FROM mcp_connectors WHERE name = 'huaweicloud-devkit'").get();
    const parsed: unknown = JSON.parse(asText(asRecord(row).env_json || '[]'));
    if (!Array.isArray(parsed)) return null;
    const hit: unknown = parsed.find((e) => asRecord(e).key === 'DEVKIT_PACKS');
    const value = hit ? asRecord(hit).value : null;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close: the packs value is already resolved
    }
  }
}
