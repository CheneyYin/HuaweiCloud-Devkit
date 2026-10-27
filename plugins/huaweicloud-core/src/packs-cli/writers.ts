// The DEVKIT_PACKS writers, extracted from setup-cli.ts: the surgical
// per-store writes behind the JSON-config PACK_SLOTS rows. The officeace
// sqlite writer lives with the connector family
// (agents/officeace-sqlite.ts); the `packs` command family
// (packs-cli/commands.ts, packs-cli/write-command.ts) is the one write path
// allowed to overwrite an existing value — the command is the operator's
// explicit management action.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { codeartsMcpSettingsFile, codeartsProjectMcpSettingsFile, dshPatchFile } from '../targets.ts';
import { readDevkitPacksFromJson } from '../packs-policy.ts';
import { writeMcpSettingsFile } from '../mcp-config-io.ts';
import { asRecord } from '../lib/as-record.ts';
import { errorMessage } from '../install-payload.ts';
import {
  DSH_MCP_PATCH_END,
  DSH_MCP_PATCH_START,
  dshPatchBlock,
  dshPatchHasOnlyCommentsOrEmptyList,
  removeManagedDshPatchBlock,
} from '../agents/dsh-patch.ts';
import type { PackWriteResult } from './slots.ts';

// Surgical DEVKIT_PACKS write into one MCP settings JSON file: parse, touch
// only the DEVKIT_PACKS key under the entry's canonical env spelling (a copy
// under the opposite spelling is removed so exactly one key remains), write
// through the 0600/0700 path. readDevkitPacksFromJson checks both spellings
// in the same order, so a write followed by a read round-trips.
export function writeDevkitPacksInJson(
  configPath: string,
  mapKey: 'mcp' | 'mcpServers',
  envKey: 'env' | 'environment',
  next: string | null,
): PackWriteResult {
  if (!existsSync(configPath)) {
    return { ok: false, reason: 'not-installed', detail: `config file missing: ${configPath}` };
  }
  let config: Record<string, unknown>;
  try {
    config = asRecord(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return { ok: false, reason: 'parse-failed', detail: `${configPath} is not valid JSON (jsonc comments?)` };
  }
  const servers = asRecord(config[mapKey]);
  const entry: unknown = servers['huaweicloud-devkit'];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: 'not-installed', detail: `no mcp.huaweicloud-devkit entry in ${configPath}` };
  }
  const entryRecord = entry as Record<string, unknown>;
  if (readDevkitPacksFromJson(configPath, mapKey) === next) return { ok: true, changed: false };
  const otherKey: 'env' | 'environment' = envKey === 'env' ? 'environment' : 'env';
  for (const key of [envKey, otherKey]) {
    const rawEnv: unknown = entryRecord[key];
    if (rawEnv === null || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) continue;
    const envRecord = rawEnv as Record<string, unknown>;
    if (!Object.hasOwn(envRecord, 'DEVKIT_PACKS')) continue;
    delete envRecord.DEVKIT_PACKS;
    if (Object.keys(envRecord).length === 0) delete entryRecord[key];
  }
  if (next !== null) {
    const rawEnv: unknown = entryRecord[envKey];
    const base =
      rawEnv !== null && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
        ? (rawEnv as Record<string, unknown>)
        : {};
    entryRecord[envKey] = { ...base, DEVKIT_PACKS: next };
  }
  writeMcpSettingsFile(configPath, config);
  return { ok: true, changed: true };
}

// CodeArts writes user-level always and the cwd-relative project-level file
// only when it already carries the devkit entry (mirroring the install pair
// registerCodeartsMcp(user) + registerCodeartsMcp(project)). Status reads
// user-level only, matching doctor.
export function writeCodeartsDevkitPacks(next: string | null): PackWriteResult {
  const result = writeDevkitPacksInJson(codeartsMcpSettingsFile(), 'mcpServers', 'env', next);
  const projectFile = codeartsProjectMcpSettingsFile();
  if (existsSync(projectFile)) {
    const project = writeDevkitPacksInJson(projectFile, 'mcpServers', 'env', next);
    if (!project.ok && project.reason === 'parse-failed') {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not parse ${projectFile}; project-level DEVKIT_PACKS not written.`);
    }
  }
  return result;
}

// DSH managed-block rewrite, parameterized with the next value instead of
// re-reading it. The bundle-provided patch has no managed block and is not
// ours to rewrite, so it is refused.
export function writeDevkitPacksInDshPatch(next: string | null): PackWriteResult {
  const patchFile = dshPatchFile();
  if (!existsSync(patchFile)) {
    return { ok: false, reason: 'not-installed', detail: `patch file missing: ${patchFile}` };
  }
  let existing: string;
  try {
    existing = readFileSync(patchFile, 'utf8');
  } catch (error) {
    return { ok: false, reason: 'parse-failed', detail: errorMessage(error) };
  }
  if (!existing.includes(DSH_MCP_PATCH_START) || !existing.includes(DSH_MCP_PATCH_END)) {
    if (existing.includes('@deepseek-ai/dsh-mcp-client') && existing.includes('serverName: huaweicloud')) {
      return { ok: false, reason: 'bundle-owned', detail: 'the bundled DSH patch provides the MCP config' };
    }
    return { ok: false, reason: 'not-installed', detail: `no managed block in ${patchFile}` };
  }
  const cleaned = removeManagedDshPatchBlock(existing);
  const block = dshPatchBlock(next);
  let nextContent: string;
  if (dshPatchHasOnlyCommentsOrEmptyList(cleaned)) {
    const prefix = cleaned
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '[]')
      .join('\n')
      .trimEnd();
    nextContent = `${prefix ? `${prefix}\n` : ''}${block}\n`;
  } else {
    nextContent = `${cleaned}\n\n${block}\n`;
  }
  if (existing.replace(/\r\n/g, '\n') === nextContent) return { ok: true, changed: false };
  writeFileSync(patchFile, nextContent);
  return { ok: true, changed: true };
}
