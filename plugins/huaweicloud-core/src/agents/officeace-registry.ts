// The OfficeAce connector-row write/remove domain logic, split out of
// agents/officeace.ts for the complex-file bar: the sqlite upsert (issue #615
// delta discipline — user identity and args survive uninstall) and the
// connector delete. The sqlite module surface and readers live in
// agents/officeace-sqlite.ts; the capabilities-root resolution and the
// lifecycle stay in agents/officeace.ts.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { readAgentDelta, saveAgentDelta, takeAgentDelta } from '../mcp-config-backup.ts';
import { resolvePacksFlag, packsCarryValue } from '../packs-policy.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { asText } from '../lib/as-text.ts';
import { asRecord } from '../lib/as-record.ts';
import { errorMessage } from '../install-payload.ts';
import { officeacePluginsDir } from '../officeace-paths.ts';
import {
  officeaceGetOwnerUserId,
  officeaceSqlitePath,
  openOfficeaceDb,
  readOfficeaceDevkitPacks,
  type SqliteDatabase,
} from './officeace-sqlite.ts';

export function ensureOfficeaceMcpInSqlite(): 'db-missing' | 'ok' | 'owner-missing' | 'error' {
  const dbPath = officeaceSqlitePath();
  if (!existsSync(dbPath)) {
    console.log(`  \x1b[31mOfficeAce database not found: ${dbPath}\x1b[0m`);
    console.log(`  \x1b[33mPlease ensure OfficeAce is installed and has been launched at least once.\x1b[0m`);
    return 'db-missing';
  }

  const mcpPath = join(officeacePluginsDir(), 'dist', 'mcp-server.js').replace(/\\/g, '/');
  const env: Array<{ key: string; value: string; sensitive: boolean }> = [
    { key: 'HUAWEICLOUD_AGENT_TOOLKIT_MODE', value: 'local', sensitive: false },
  ];
  const hcloudBin = findHcloudBin();
  if (hcloudBin) env.push({ key: 'HCLOUD_BIN', value: hcloudBin.replace(/\\/g, '/'), sensitive: false });
  // DEVKIT_PACKS rides the same env rows; packsCarryValue applies the --packs
  // policy (user-set values win, --packs all removes, no flag keeps current).
  const officeacePacks = packsCarryValue('OfficeAce', readOfficeaceDevkitPacks());
  if (officeacePacks !== null) {
    env.push({ key: 'DEVKIT_PACKS', value: officeacePacks, sensitive: false });
  }

  const now = Date.now();
  let db: SqliteDatabase | null = null;
  try {
    db = openOfficeaceDb();

    const existingRow: unknown = db
      .prepare("SELECT id, command, args_json, env_json FROM mcp_connectors WHERE name = 'huaweicloud-devkit'")
      .get();
    const existing = asRecord(existingRow);

    const envJson = JSON.stringify(env);

    if ('id' in existing) {
      // Merge: keep user's extra args/env values, only correct program-owned fields (issue #615).
      let existingArgs: unknown = [];
      let existingEnv: unknown = [];
      try {
        existingArgs = JSON.parse(asText(existing.args_json || '[]'));
        existingEnv = JSON.parse(asText(existing.env_json || '[]'));
      } catch {
        // parse failure falls back to empty defaults — user args/env start blank
      }
      const userArgs: unknown[] = Array.isArray(existingArgs) ? existingArgs.slice(1) : [];
      // Start from the user's env and add our required keys only when absent (user values win).
      const envMerged: unknown[] = Array.isArray(existingEnv) ? existingEnv.slice() : [];
      for (const e of env) {
        if (e && e.key && !envMerged.some((x) => asRecord(x).key === e.key)) envMerged.push(e);
      }
      // --packs all restores full enablement: drop any existing DEVKIT_PACKS row.
      if (resolvePacksFlag().kind === 'all') {
        for (let i = envMerged.length - 1; i >= 0; i--) {
          if (asRecord(envMerged[i]).key === 'DEVKIT_PACKS') envMerged.splice(i, 1);
        }
      }
      const nextArgsJson = JSON.stringify([mcpPath, ...userArgs]);
      const nextEnvJson = JSON.stringify(envMerged);
      if (existing.command === 'node' && existing.args_json === nextArgsJson && existing.env_json === nextEnvJson) {
        console.log(`  MCP config unchanged: ${dbPath}`);
        db.close();
        return 'ok';
      }
      db.prepare(
        'UPDATE mcp_connectors SET command = ?, args_json = ?, env_json = ?, updated_at = ?, status = ?, enabled = 1 WHERE id = ?',
      ).run('node', nextArgsJson, nextEnvJson, now, 'disconnected', existing.id);
      console.log(`  MCP config merged (user fields preserved): ${dbPath}`);
    } else {
      // Restore user identity + args saved by a previous uninstall (#559).
      // owner_user_id has no queryable source: we copy it from an existing
      // row, and fall back to the value backed up before a prior uninstall so
      // an emptied table does not make registration permanently impossible.
      const officeaceDelta = readAgentDelta('officeace');
      const deltaOwner: unknown = officeaceDelta ? officeaceDelta.ownerUserId : undefined;
      const ownerUserId =
        officeaceGetOwnerUserId() ||
        (typeof deltaOwner === 'string' || typeof deltaOwner === 'number' ? deltaOwner : null);
      if (!ownerUserId) {
        console.log(`  \x1b[31mCannot determine owner_user_id for the huaweicloud-devkit connector.\x1b[0m`);
        console.log(
          `  \x1b[33mThe OfficeAce connector database has no rows to copy the user id from and no prior registration is backed up. Open OfficeAce, add/enable any connector once, then re-run the install.\x1b[0m`,
        );
        db.close();
        return 'owner-missing';
      }
      const argsExtra: unknown[] =
        officeaceDelta && Array.isArray(officeaceDelta.argsExtra) ? officeaceDelta.argsExtra : [];
      const insertArgsJson = JSON.stringify([mcpPath, ...argsExtra]);
      db.prepare(
        `INSERT INTO mcp_connectors (id, owner_user_id, type, name, normalized_name, transport, timeout_ms, command, args_json, env_json, enabled, status, created_at, updated_at, version, seeded)
         VALUES (?, ?, 'custom', 'huaweicloud-devkit', 'huaweicloud-devkit', 'stdio', 60000, 'node', ?, ?, 1, 'disconnected', ?, ?, 1, 0)`,
      ).run(randomUUID(), ownerUserId, insertArgsJson, envJson, now, now);
      // Consume the backup only after a successful insert so a DB failure keeps it for the next retry.
      takeAgentDelta('officeace');
      console.log(`  MCP config created: ${dbPath}`);
    }
    db.close();
    return 'ok';
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // best-effort close: the original write failure is what gets reported
      }
    }
    console.log(`  \x1b[31mFailed to write MCP config: ${errorMessage(error)}\x1b[0m`);
    return 'error';
  }
}

export function removeOfficeaceMcpFromSqlite(): void {
  const dbPath = officeaceSqlitePath();
  if (!existsSync(dbPath)) return;
  let db: SqliteDatabase | null = null;
  try {
    db = openOfficeaceDb();
    // Back up user identity + args before deleting the connector row:
    // owner_user_id is copied from existing rows on reinstall, so an empty
    // table after this delete would make registration impossible (#559).
    try {
      const row: unknown = db
        .prepare("SELECT owner_user_id, args_json FROM mcp_connectors WHERE name = 'huaweicloud-devkit'")
        .get();
      const delta: Record<string, unknown> = {};
      const ownerUserId = asRecord(row).owner_user_id;
      if (ownerUserId) delta.ownerUserId = ownerUserId;
      try {
        const parsed: unknown = row ? JSON.parse(asText(asRecord(row).args_json || '[]')) : [];
        if (Array.isArray(parsed) && parsed.length > 1) delta.argsExtra = parsed.slice(1);
      } catch {
        // parse failure means no args to back up — the delta keeps identity only
      }
      if (Object.keys(delta).length > 0) saveAgentDelta('officeace', delta);
    } catch {
      // best-effort backup: a failed save must not block the connector delete
    }
    // mcp_connector_tools may not exist on minimal installs — deleting it must
    // not abort deleting the connector row itself.
    try {
      db.prepare(
        "DELETE FROM mcp_connector_tools WHERE connector_id IN (SELECT id FROM mcp_connectors WHERE name = 'huaweicloud-devkit')",
      ).run();
    } catch {
      // table may be absent on minimal installs — the connector delete still proceeds
    }
    const result2 = db.prepare("DELETE FROM mcp_connectors WHERE name = 'huaweicloud-devkit'").run();
    const changes: unknown = result2.changes;
    if ((typeof changes === 'number' || typeof changes === 'bigint') && changes > 0) {
      console.log(`  MCP config removed: ${dbPath}`);
    }
    db.close();
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // best-effort close: the removal failure is what gets reported
      }
    }
    console.log(`  \x1b[31mFailed to remove MCP config: ${errorMessage(error)}\x1b[0m`);
  }
}
