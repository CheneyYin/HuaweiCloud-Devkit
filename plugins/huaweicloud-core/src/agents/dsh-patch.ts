// The DSH cordis.patch.yml managed-block family, split out of agents/dsh.ts
// for the complex-file bar: the patch block renderer (DEVKIT_PACKS
// parameterized, HCLOUD_BIN honored), the managed-block remover, the
// pre-2.0 src/mcp-server.mjs migration, and the bundle-provided detection.
// The dsh-mcp-client package detection/install and the
// deploy/uninstall/status lifecycle stay in agents/dsh.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { dshPatchFile, dshPluginsDir } from '../targets.ts';
import { packsCarryValue, readDevkitPacksFromYaml } from '../packs-policy.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { asText } from '../lib/as-text.ts';
import { PLUGIN_ROOT } from '../install-payload.ts';
import {
  payloadDoctorSection,
  skillsTreeMatches,
  type DoctorSharedState,
  type PayloadDoctorRow,
  type PayloadDoctorSection,
} from '../doctor-payload.ts';

export const DSH_MCP_PATCH_START = '# HuaweiCloud DevKit DSH integration start';
export const DSH_MCP_PATCH_END = '# HuaweiCloud DevKit DSH integration end';

export function dshMcpServerPath(): string {
  return join(dshPluginsDir(), 'dist', 'mcp-server.js').replace(/\\/g, '/');
}

export function dshPatchBlock(devkitPacks: string | null): string {
  const hcloudBin = findHcloudBin();
  const envLines: string[] = ['          HUAWEICLOUD_AGENT_TOOLKIT_MODE: local'];
  if (hcloudBin) {
    envLines.push(`          HCLOUD_BIN: '${hcloudBin.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  }
  if (devkitPacks !== null) {
    envLines.push(`          DEVKIT_PACKS: '${devkitPacks.replace(/'/g, "''")}'`);
  }
  return [
    DSH_MCP_PATCH_START,
    '- insert:',
    '    - id: huaweicloud-devkit',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: huaweicloud',
    '        transport: stdio',
    '        command: node',
    '        args:',
    `          - '${dshMcpServerPath().replace(/'/g, "''")}'`,
    '        env:',
    ...envLines,
    '        failOnStartupError: false',
    '    - id: huaweicloud-hook',
    `      name: '../../huaweicloud-plugins/hook-plugin.mjs'`,
    DSH_MCP_PATCH_END,
  ].join('\n');
}

function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function removeManagedDshPatchBlock(content: unknown): string {
  const pattern = new RegExp(
    `\\n?${escapeRegExp(DSH_MCP_PATCH_START)}[\\s\\S]*?${escapeRegExp(DSH_MCP_PATCH_END)}\\s*`,
    'g',
  );
  return asText(content || '')
    .replace(pattern, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function dshPatchHasOnlyCommentsOrEmptyList(content: unknown): boolean {
  const meaningful = asText(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return meaningful.length === 0 || (meaningful.length === 1 && meaningful[0] === '[]');
}

export function ensureDshMcpPatch(): boolean {
  const patchFile = dshPatchFile();
  let existing = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
  // Resolve the packs policy before any cleanup rewrites the patch: the
  // current DEVKIT_PACKS value lives inside the managed block that
  // removeManagedDshPatchBlock strips below.
  const dshPacks = packsCarryValue('DSH', readDevkitPacksFromYaml(patchFile));

  // Clean up any legacy managed block from pre-bundle versions.
  const cleaned = removeManagedDshPatchBlock(existing);
  if (cleaned !== existing) {
    writeFileSync(patchFile, cleaned);
    console.log(`  DSH patch legacy block cleaned: ${patchFile}`);
    existing = cleaned;
  }

  // Pre-2.0 installs rewrote the bundled patch to an absolute
  // src/mcp-server.mjs path (see bin/dsh-postinstall.cjs history). That file
  // no longer ships, so rewrite it to this install's dist location before the
  // "already configured" short-circuit below, or the server would silently
  // point at nothing.
  const distServerPath = join(PLUGIN_ROOT, 'dist', 'mcp-server.js').replace(/\\/g, '/');
  const migrated = cleaned.replace(/([^\s'"]*)\/plugins\/huaweicloud-core\/src\/mcp-server\.mjs/g, distServerPath);
  if (migrated !== cleaned) {
    writeFileSync(patchFile, migrated);
    console.log(`  DSH patch MCP path migrated to dist: ${patchFile}`);
    existing = migrated;
  }

  // If the bundled cordis.patch.yml already provides the MCP config, skip
  // writing a managed block to avoid duplicate entries.
  if (cleaned.includes('@deepseek-ai/dsh-mcp-client') && cleaned.includes('serverName: huaweicloud')) {
    console.log(`  DSH patch already configured via bundle: ${patchFile}`);
    return false;
  }

  // Fallback for standalone usage: write a managed block when no bundle.
  const block = dshPatchBlock(dshPacks);
  let next: string;
  if (dshPatchHasOnlyCommentsOrEmptyList(cleaned)) {
    const prefix = cleaned
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '[]')
      .join('\n')
      .trimEnd();
    next = `${prefix ? `${prefix}\n` : ''}${block}\n`;
  } else {
    next = `${cleaned}\n\n${block}\n`;
  }
  if (existing.replace(/\r\n/g, '\n') === next) {
    console.log(`  DSH patch unchanged: ${patchFile}`);
    return false;
  }
  mkdirSync(dirname(patchFile), { recursive: true });
  writeFileSync(patchFile, next);
  console.log(`  DSH patch updated: ${patchFile}`);
  return true;
}

export function removeDshMcpPatch(): boolean {
  const patchFile = dshPatchFile();
  if (!existsSync(patchFile)) return false;
  const existing = readFileSync(patchFile, 'utf8');
  const cleaned = removeManagedDshPatchBlock(existing);
  if (cleaned === existing.trimEnd()) return false;
  const prefix = cleaned
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '[]')
    .join('\n')
    .trimEnd();
  const next = dshPatchHasOnlyCommentsOrEmptyList(cleaned) ? `${prefix ? `${prefix}\n` : ''}[]\n` : `${cleaned}\n`;
  writeFileSync(patchFile, next);
  console.log(`  DSH patch cleaned: ${patchFile}`);
  return true;
}

export function dshPatchConfigured(): boolean {
  const patchFile = dshPatchFile();
  if (!existsSync(patchFile)) return false;
  try {
    const patch = readFileSync(patchFile, 'utf8');
    return (
      (patch.includes('id: huaweicloud-devkit') || patch.includes('id: mcp-huaweicloud')) &&
      patch.includes('@deepseek-ai/dsh-mcp-client') &&
      patch.includes('serverName: huaweicloud') &&
      patch.includes('id: huaweicloud-hook')
    );
  } catch {
    return false;
  }
}

// The dsh row's doctor binding: the generic payload section plus the DSH
// package-root skills-tree candidate. Skills are server data disclosed over
// MCP, and the DSH layout resolves them from the running package root:
// serverSkillDirNames() appends 'skills' to its argument, so the candidate
// is PLUGIN_ROOT itself — probing PLUGIN_ROOT/skills/skills would never
// exist (the pre-fix shape: the fallback was inert and a DSH-only healthy
// install false-FAILED the tree check).
export function dshPayloadDoctorSection(row: PayloadDoctorRow, shared: DoctorSharedState): PayloadDoctorSection {
  const base = payloadDoctorSection(row, shared);
  const packageRootTree = dshPatchConfigured() && skillsTreeMatches(PLUGIN_ROOT, shared.expectedSkills);
  return {
    ...base,
    triple: { ...base.triple, skillsTree: base.triple.skillsTree || packageRootTree },
  };
}
