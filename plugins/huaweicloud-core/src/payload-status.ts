import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { listSkillDirs } from './lib/skill-tree.ts';
import { mcpServerInstalled } from './payload-files.ts';

// The status + residue family (the install-payload.ts internals split): the
// server-data skill listing the status sections report, the payload-triple
// lines, and the empty-skills-dir residue removal the uninstalls finish
// with.

// Skills status reads the server-data tree inside the plugin dir, mirroring
// where copyServerPayload places it. The listing is the shared SKILL.md-
// aware one (src/lib/skill-tree.ts) — the same membership the boot guard
// uses, so a hollow claimed dir (name present, SKILL.md missing) counts as
// missing here exactly as it does at boot.
export function serverSkillDirNames(pluginDir: string): string[] {
  return listSkillDirs(join(pluginDir, 'skills'));
}

export function serverSkillCount(pluginDir: string): number {
  return serverSkillDirNames(pluginDir).length;
}

// The payload triple every directory-based status section reports: server
// bundle, safety policy, skills tree. dshStatus and hermesStatus keep
// inline variants because their hook lines interleave with the triple.
export function payloadStatusLines(pluginDir: string): void {
  console.log(
    `  MCP Server: ${mcpServerInstalled(pluginDir) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  const skillCount = serverSkillCount(pluginDir);
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
}

// Remove the skills dir itself when the owned-skill removal emptied it (the
// dsh/officeace/hermes uninstalls) — an empty leftover dir is residue.
export function removeSkillsDirIfEmpty(skillsDir: string, removed: number): void {
  if (removed === 0) return;
  try {
    if (existsSync(skillsDir) && readdirSync(skillsDir).length === 0) {
      rmSync(skillsDir, { recursive: true, force: true });
      console.log(`  Removed empty skills directory: ${skillsDir}`);
    }
  } catch {
    // best-effort cleanup: an empty skills dir left behind is harmless
  }
}
