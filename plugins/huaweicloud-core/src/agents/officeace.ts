// The OfficeAce agent module, extracted from setup-cli.ts: capabilities-root
// resolution, the sqlite connector registry (issue #615 delta discipline
// applies — user identity and args survive uninstall), the capabilities.json
// skill-entry cleanup, and the install/update/uninstall/status lifecycle.
// agent-registration.ts keeps its own smaller sqlite model: it is the MCP
// graph's read-side probe and must stay lazily loaded there.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import {
  isUsableOfficeaceRoot,
  probeOfficeaceSystemDirs,
  readOfficeaceRootMarker,
  writeOfficeaceRootMarker,
} from '../officeace-paths.ts';
import { readAgentDelta, saveAgentDelta, takeAgentDelta } from '../mcp-config-backup.ts';
import { resolvePacksFlag, packsCarryValue } from '../packs-policy.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { asText } from '../lib/as-text.ts';
import { asRecord } from '../lib/as-record.ts';
import {
  copyServerPayload,
  devkitOwnedSkillNames,
  errorMessage,
  installRuntimeDeps,
  payloadStatusLines,
  removeIfExists,
  removeSkillsDirIfEmpty,
} from '../install-payload.ts';

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

// The Windows-side system probe (registry + Program Files) lives in
// officeace-paths.ts, shared with the MCP-side detection in
// auth/agent-registration.ts; the env/marker/skip ordering stays here.

export function officeaceCapabilitiesDir(): string | null {
  const configRoot = process.env.OFFICE_CLAW_CONFIG_ROOT;
  // isUsableOfficeaceRoot rejects empty/undefined roots, so the truthiness guard
  // preserves the original call's outcome for a missing env var.
  if (configRoot && isUsableOfficeaceRoot(configRoot)) return configRoot;
  const markerRoot = readOfficeaceRootMarker();
  if (markerRoot) return markerRoot;
  // Skip system probes (registry / Program Files) so automated environments can
  // keep OfficeAce detection hermetic — those probes can leak a real OfficeAce
  // install into a sandboxed/fake HOME (#654).
  if (process.env.HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT === '1') return null;
  return probeOfficeaceSystemDirs(isUsableOfficeaceRoot);
}

function officeaceCapabilitiesDirSafe(): string {
  return officeaceCapabilitiesDir() || join(homedir(), '.office-claw');
}
export function officeaceCapabilitiesFile(): string {
  return join(officeaceCapabilitiesDirSafe(), 'capabilities.json');
}
export function officeaceSkillsDir(): string {
  return join(officeaceCapabilitiesDirSafe(), 'skills');
}
export function officeacePluginsDir(): string {
  return join(officeaceCapabilitiesDirSafe(), 'huaweicloud-plugins');
}

export function officeaceSqlitePath(): string {
  const capDir = officeaceCapabilitiesDirSafe();
  return join(resolve(capDir, '..'), 'data', 'mcp-connectors.sqlite');
}

export function openOfficeaceDb(): SqliteDatabase {
  return new DatabaseSync(officeaceSqlitePath());
}

function officeaceGetOwnerUserId(): string | number | null {
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

function ensureOfficeaceMcpInSqlite(): 'db-missing' | 'ok' | 'owner-missing' | 'error' {
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

function removeOfficeaceMcpFromSqlite(): void {
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

// capabilities.json is written back verbatim apart from the managed entries, so
// every non-`capabilities` field stays unknown and round-trips untouched.
interface OfficeaceCapabilitiesConfig {
  capabilities?: unknown;
}

function toCapabilitiesConfig(value: unknown): OfficeaceCapabilitiesConfig {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function writeCapabilitiesJson(config: OfficeaceCapabilitiesConfig): void {
  mkdirSync(officeaceCapabilitiesDirSafe(), { recursive: true });
  writeFileSync(officeaceCapabilitiesFile(), JSON.stringify(config, null, 2));
}

function removeOfficeaceSkillCapabilities(): void {
  const capFile = officeaceCapabilitiesFile();
  if (!existsSync(capFile)) return;
  let config: OfficeaceCapabilitiesConfig;
  try {
    config = toCapabilitiesConfig(JSON.parse(readFileSync(capFile, 'utf8')));
  } catch {
    return;
  }
  if (!Array.isArray(config.capabilities)) return;
  // Ownership-precise: only skill-type entries whose id the shipped skills
  // tree still carries (huaweicloud-core is a tree dir, so it is covered).
  // A user's own custom entry sharing the huawei* prefix — or a non-skill
  // capability — must survive; same manifest discipline as the native-dir
  // purge, never a prefix glob.
  const owned = devkitOwnedSkillNames();
  const capabilities: unknown[] = config.capabilities;
  const origLen = capabilities.length;
  const filtered = capabilities.filter((c) => {
    const cap = asRecord(c);
    const capId: unknown = cap.id;
    return !(cap.type === 'skill' && typeof capId === 'string' && owned.has(capId));
  });
  if (filtered.length !== origLen) {
    config.capabilities = filtered;
    writeCapabilitiesJson(config);
    console.log(`  Skill capabilities cleaned: ${capFile}`);
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

async function promptOfficeaceInstallDir(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));
  while (true) {
    const path = (await ask('  Install directory: ')).trim();
    if (!path) {
      console.log('  \x1b[33mPath cannot be empty.\x1b[0m');
      continue;
    }
    const capFile = join(path, '.office-claw', 'capabilities.json');
    if (existsSync(capFile)) {
      rl.close();
      return path;
    }
    console.log(`  \x1b[33mcapabilities.json not found at: ${capFile}\x1b[0m`);
    console.log('  Please verify the path and try again.');
  }
}

export async function installOfficeAce(): Promise<void> {
  if (!officeaceCapabilitiesDir()) {
    if (process.stdin.isTTY) {
      console.log('  \x1b[33mOfficeAce install directory not found automatically.\x1b[0m');
      console.log('  Please enter the OfficeAce install directory.');
      const entered = await promptOfficeaceInstallDir();
      process.env.OFFICE_CLAW_CONFIG_ROOT = join(entered, '.office-claw');
    } else {
      console.log(
        '  \x1b[31mOfficeAce install directory not found. Please set OFFICE_CLAW_CONFIG_ROOT env var and retry.\x1b[0m',
      );
      return;
    }
  }
  const pluginDest = officeacePluginsDir();

  copyServerPayload(pluginDest);

  installRuntimeDeps(pluginDest);
  if (ensureOfficeaceMcpInSqlite() === 'owner-missing') {
    throw new Error(
      'OfficeAce MCP connector registration failed (owner_user_id unavailable). ' +
        'Open OfficeAce, add/enable any connector once, then re-run install.',
    );
  }
  // Prior versions registered native skill entries here; clean them so the
  // capabilities registry carries no pointer at the (server-data) skills.
  removeOfficeaceSkillCapabilities();
  // Persist the resolved root so a later uninstall/update (new process, no
  // OFFICE_CLAW_CONFIG_ROOT env) still targets the same directory (#559).
  const resolvedRoot = officeaceCapabilitiesDir();
  if (resolvedRoot) writeOfficeaceRootMarker(resolvedRoot);
}

export async function updateOfficeAce(): Promise<void> {
  const pluginDest = officeacePluginsDir();

  copyServerPayload(pluginDest);
  installRuntimeDeps(pluginDest);
  if (ensureOfficeaceMcpInSqlite() === 'owner-missing') {
    console.log(
      `  \x1b[31m[WARN]\x1b[0m OfficeAce MCP connector registration failed (owner_user_id unavailable). ` +
        `The connector may stay disconnected until you add/enable any connector once in OfficeAce and re-run update.`,
    );
  }
  removeOfficeaceSkillCapabilities();
  const resolvedRoot = officeaceCapabilitiesDir();
  if (resolvedRoot) writeOfficeaceRootMarker(resolvedRoot);
}

export function uninstallOfficeAce(removeOwnedSkills: (dir: string) => number): void {
  const skillsDir = officeaceSkillsDir();
  const removed = removeOwnedSkills(skillsDir);
  if (removed > 0) console.log(`  Removed ${removed} skills`);
  removeSkillsDirIfEmpty(skillsDir, removed);

  if (removeIfExists(officeacePluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
  removeOfficeaceSkillCapabilities();
  removeOfficeaceMcpFromSqlite();
}

export function officeaceStatus(): void {
  payloadStatusLines(officeacePluginsDir());
  const dbPath = officeaceSqlitePath();
  if (existsSync(dbPath)) {
    try {
      const db = openOfficeaceDb();
      const row: unknown = db
        .prepare("SELECT enabled, status FROM mcp_connectors WHERE name = 'huaweicloud-devkit'")
        .get();
      db.close();
      if (row) {
        const record = asRecord(row);
        const status: unknown = record.status;
        const statusIcon = status === 'connected' ? '\x1b[32m' : '\x1b[33m';
        console.log(`  MCP config: ${statusIcon}${String(status)}\x1b[0m (enabled: ${record.enabled ? 'yes' : 'no'})`);
      } else {
        console.log(`  MCP config: \x1b[31mNot configured\x1b[0m`);
      }
    } catch {
      console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
    }
  } else {
    console.log(`  MCP config: \x1b[31mDatabase not found\x1b[0m`);
  }
}
