import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseCoreSkillNames, parseSkillManifest } from './lib/skill-manifest.ts';
import { PLUGIN_ROOT } from './payload-utils.ts';

// The skills-roster readers (the install-payload.ts internals split): the
// shipped tree's ownership manifest (devkit-owned names), the expected
// roster from .manifest.json, and the core-pack name sets the native
// disclosure and its cleanups derive their delete rights from.

// Devkit-owned skill names. The shipped skills/ tree is the ownership
// manifest: a name is deletable only when the current tree still ships it,
// so a user-authored skill that merely shares the huawei* prefix survives
// every cleanup. Deliberately RAW directories (not the guard-side
// dir-or-symlink-with-SKILL.md listing in src/lib/skill-tree.ts): purge
// ownership wants the inclusive reading — a hollow claimed dir still owns
// its native copies.
export function devkitOwnedSkillNames(): Set<string> {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  if (!existsSync(skillsSrc)) return new Set();
  try {
    return new Set(
      readdirSync(skillsSrc, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name),
    );
  } catch {
    return new Set();
  }
}

// The expected skill roster, read from the shipped .manifest.json file rather
// than from the candidate directory listing. Doctor must not compare a
// directory against itself, so the roster of record is the file the build
// wrote beside the tree; parsing lives in src/lib/skill-manifest.ts (pure,
// unit-tested). An absent or unreadable manifest yields [] and the caller
// fails loud.
export function shippedSkillRoster(): string[] {
  const manifestPath = join(PLUGIN_ROOT, 'skills', '.manifest.json');
  if (!existsSync(manifestPath)) return [];
  return parseSkillManifest(readFileSync(manifestPath, 'utf8'));
}

// The core-pack skill names that may be disclosed natively, derived from the
// shipped manifest's packOf map (parseCoreSkillNames in the zod-free lib) —
// because this module must not import the zod-dependent packs registry.
// Null covers every unusable shape (missing tree, missing manifest,
// unparsable, no core entries): doctor warns, install/update throw via
// coreSkillNames. The loudness is load-bearing — an empty core set derived
// silently would invert the narrowed cleanup into deleting the very copies
// the sync owns.
export function tryCoreSkillNames(): Set<string> | null {
  const manifestPath = join(PLUGIN_ROOT, 'skills', '.manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return parseCoreSkillNames(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

export function coreSkillNames(): Set<string> {
  const core = tryCoreSkillNames();
  if (core === null) {
    throw new Error(
      `skills tree or manifest at ${join(PLUGIN_ROOT, 'skills')} lacks usable core-pack info ` +
        '(missing tree, missing .manifest.json, unparsable, or no core-pack entries) — the native core-skill sync refuses to guess. ' +
        'From a git checkout run: npm run build; from a broken install run: npx huaweicloud-devkit install',
    );
  }
  return core;
}

// The core roster a payload tree's own manifest discloses — the honest
// freshness roster for doctor, so a newer doctor CLI never demands a core
// skill the installed payload never shipped. Null when the payload
// manifest is absent or unusable.
export function payloadCoreNames(payloadTree: string): Set<string> | null {
  try {
    return parseCoreSkillNames(readFileSync(join(payloadTree, '.manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}
