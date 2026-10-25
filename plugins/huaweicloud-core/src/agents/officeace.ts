// The OfficeAce agent module, split for the complex-file bar: this file
// keeps the capabilities.json skill-entry cleanup and the
// install/update/uninstall/status lifecycle. The capabilities-dir path
// family (env/marker/skip ordering) lives in officeace-paths.ts (the shared
// leaf), the sqlite module surface + readers in agents/officeace-sqlite.ts,
// and the connector-row write/remove domain logic in
// agents/officeace-registry.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  officeaceCapabilitiesDir,
  officeaceCapabilitiesDirSafe,
  officeaceCapabilitiesFile,
  officeacePluginsDir,
  officeaceSkillsDir,
  writeOfficeaceRootMarker,
} from '../officeace-paths.ts';
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
import { officeaceSqlitePath, openOfficeaceDb } from './officeace-sqlite.ts';
import { ensureOfficeaceMcpInSqlite, removeOfficeaceMcpFromSqlite } from './officeace-registry.ts';

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
