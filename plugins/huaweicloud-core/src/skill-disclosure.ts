// The skills-serving handlers, split out of tools.ts: the tree location
// (SKILLS_ROOT), the reference listing, the reference-body cap, and the
// retrieve_skill / list_skills handlers that read the generated tree.
// searchDocs (the tree's text-search index) lives in search-docs.ts — the
// jscpd complex-file bar (cx < 50, arrow callbacks counted) forced the
// disclosure/search split.
//
// DEPTH SAFETY: this module MUST stay at src/ ROOT level. The esbuild
// bundle flattens every inlined module's import.meta.url to the bundle
// file's own URL (dist/mcp-server.js), so __dirname inside the bundle is
// dist/ for every module; SKILLS_ROOT's one-level climb resolves to the
// plugin root in BOTH shapes only because src/ and dist/ are siblings —
// the same property tools.ts had before the split. A src/<subdir>/ home
// would resolve one level too high in the tsc tree (the telemetry
// version-dir incident; see the one-climb structure guard).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEnabledPacks } from './packs/enable.ts';
import { PACKS } from './packs/registry.ts';
import { listSkillDirs } from './lib/skill-tree.ts';
import { parseSkillFrontmatter } from './lib/skill-frontmatter.ts';
// The catalog module owns the pack-claims inversion and the shared
// pack-refusal helpers these handlers serve beside their tree reads.
import { SKILL_OWNER, packNotFound, packNotEnabled, packEnablementRemediation } from './capability-catalog.ts';
import type { CallToolOptions } from './tools.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The skills tree is server data, not an agent-native artifact: it ships next
// to dist/ (esbuild preserves import.meta.url, so the bundled mcp-server.js
// resolves this relative to its own location) and is disclosed through the
// MCP tools (list_packs / pack_info / list_skills / retrieve_skill /
// search_docs); list_skills also carries the tree's location (skillRoot,
// stdio sessions only) so a same-machine agent can read the files with its
// own tools, and the stdio server instructions state the same location at
// initialize (mcp-protocol.ts instructionsFor) so the direct read needs no
// catalog detour. The installer separately places the six core meta-skills as
// native copies in directory-loading agents (setup-cli's PAYLOAD_TARGETS
// sync) — that placement lives in setup-cli, and this module never probes
// agent-native dirs. Exported for the instruction builder, which resolves
// the path at runtime (never baked at build time) from this same constant.
export const SKILLS_ROOT = join(__dirname, '..', 'skills');

// Deterministic (codepoint, not locale) reference listing shared by the
// skill disclosure tools. Regular files plus symlinks — the same read
// exposure the unfiltered readdir it replaced had (a symlink to a
// directory still throws at read time) — while subdirectories are
// excluded: they are not references retrieve_skill could read, so the
// catalog must not advertise them.
function referenceFilenames(skillName: string): string[] {
  const refDir = join(SKILLS_ROOT, skillName, 'references');
  if (!existsSync(refDir)) return [];
  return readdirSync(refDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Skill metadata catalog: one call disclosing every enabled non-core
// pack's skills (name, parsed description, version, owning pack, reference
// filenames) so an agent can browse before paying for retrieve_skill's
// full payload — and, on stdio sessions, the tree's location (skillRoot)
// so the agent can read the same files with its own tools the way it
// explores native skills: the taught default is the attempt-first direct
// read, with retrieve_skill as the fallback when the attempted read
// fails or is denied.
// Registry-driven on purpose (PACKS order, claimed
// skills only) rather than a tree walk: the output order is deterministic,
// every entry carries a defined pack, and the deliberate difference from
// searchDocs' ungated-straggler posture is that unclaimed directories do
// not exist here — verifySkillTree refuses to boot the server on any.
// Gating is disclosure-level on both fields' terms: catalog entries never
// reference a trimmed pack's skills, while skillRoot discloses the shared
// tree (every skill, including trimmed packs' and the six core
// meta-skills) — the same doctrine enable.ts applies to pack handlers.
// A missing SKILL.md for a claimed skill throws (readFileSync) and rides
// the callTool error pass-through: the boot guard makes hollow entries
// unreachable in a booted server (a file deleted or made unreadable after
// boot can still throw, riding the same pass-through), and fabricating
// metadata for a hollow entry would be worse than the honest crash.
export function listSkills(pack: string | undefined, opts: CallToolOptions = {}) {
  const packId = String(pack ?? '').trim();
  if (pack !== undefined && packId === '') {
    return { ok: false, error: 'Pack id is required.' };
  }
  const enabled = resolveEnabledPacks();
  if (packId) {
    const found = PACKS.find((entry) => entry.id === packId);
    if (!found) return packNotFound(packId);
    if (packId === 'core') {
      return {
        ok: false,
        error:
          'The core pack\u2019s six meta-skills (huaweicloud-*) are not listed here by design: directory-loading agents disclose them natively in the system prompt, and huaweicloud_retrieve_skill serves them identically everywhere.',
      };
    }
    if (!enabled.has(found.id)) return packNotEnabled(found.id);
  }
  const skills: Array<{
    name: string;
    description: string;
    pack: string;
    version: string | number;
    references: string[];
  }> = [];
  for (const entry of PACKS) {
    if (entry.id === 'core') continue;
    if (packId && entry.id !== packId) continue;
    if (!enabled.has(entry.id)) continue;
    for (const skillName of entry.skills) {
      const fm = parseSkillFrontmatter(readFileSync(join(SKILLS_ROOT, skillName, 'SKILL.md'), 'utf8'));
      skills.push({
        name: skillName,
        description: fm.description ?? '',
        pack: entry.id,
        version: fm.version ?? 1,
        references: referenceFilenames(skillName),
      });
    }
  }
  // skillRoot rides only surfaces that carry session state (stdio), the
  // same seam listPacks uses to drop packs_configure from the remote's
  // tool inventory: the stateless remote serves an unauthenticated CORS-*
  // face whose callers cannot reach the server host's filesystem, so a
  // host path there would be pure leakage with no utility. The key itself
  // is withheld rather than nulled — absence is the guard.
  const stdioSession = Boolean(opts.onPacksChanged);
  return {
    ok: true,
    count: skills.length,
    skills,
    ...(stdioSession ? { skillRoot: SKILLS_ROOT } : {}),
  };
}

// The per-reference body cap in retrieve_skill payloads. Named so the
// structure guard can pin the taught description ("capped at N characters")
// to this single constant — and so the truncation marker interpolates the
// same number instead of restating it.
const REFERENCE_CAP = 4000;

export async function retrieveSkill(name: string, opts: CallToolOptions = {}) {
  const skillName = String(name || '').trim();
  if (!skillName) return { ok: false, error: 'Skill name is required.' };
  // Boundary guard: the name joins a filesystem path in this handler, so
  // anything outside the skill-name shape (traversal segments, separators,
  // absolute paths) is rejected before touching disk; direct reads via the
  // disclosed skillRoot are the agent's own file tools' territory.
  if (!/^[a-z0-9-]+$/.test(skillName)) {
    return {
      ok: false,
      error: 'Invalid skill name "' + skillName + '". Skill names are lowercase letters, digits, and dashes.',
    };
  }
  const skillPath = join(SKILLS_ROOT, skillName, 'SKILL.md');
  if (!existsSync(skillPath)) {
    // The Available list advertises only enabled packs' skills: recommending a
    // name the owner gate would refuse misroutes the agent.
    const enabled = resolveEnabledPacks();
    const dirs = listSkillDirs(SKILLS_ROOT).filter((dir) => {
      const owner = SKILL_OWNER.get(dir);
      return !owner || enabled.has(owner);
    });
    return { ok: false, error: 'Skill "' + skillName + '" not found. Available: ' + dirs.join(', ') };
  }
  const owner = SKILL_OWNER.get(skillName);
  if (owner && !resolveEnabledPacks().has(owner)) {
    return {
      ok: false,
      error:
        'Skill "' +
        skillName +
        '" belongs to pack "' +
        owner +
        '" which is not enabled. ' +
        packEnablementRemediation(owner),
    };
  }
  const content = readFileSync(skillPath, 'utf8');
  const references: Array<{ filename: string; content: string }> = [];
  for (const filename of referenceFilenames(skillName)) {
    const refPath = join(SKILLS_ROOT, skillName, 'references', filename);
    const raw = readFileSync(refPath, 'utf8');
    // The cap is silent no longer: cross-references deeper into a reference
    // (e.g. the safety remediation citing §Bootstrap or a late diagnosis
    // section) must be visibly unreachable here, not hollow — remote/file-less
    // agents only have this fallback, so a bare truncation reads as "the
    // section does not exist". The marker names the fix: direct file access
    // to skillRoot (disclosed in the stdio payload below).
    references.push({
      filename,
      content:
        raw.length > REFERENCE_CAP
          ? `${raw.substring(0, REFERENCE_CAP)}\n\n[truncated at ${REFERENCE_CAP} chars — full file at <skillRoot>/${skillName}/references/${filename}]`
          : raw,
    });
  }
  const frontmatter = parseSkillFrontmatter(content);
  const version: string | number = frontmatter.version ?? 1;
  const description = frontmatter.description ?? '';
  // The same stdio seam listSkills uses: a retrieve that already happened
  // (the fallback path) still teaches the caller where the tree lives, so
  // the NEXT skill can be a direct read. Withheld on the stateless remote
  // for the same reason listSkills withholds it — a host path there is
  // pure leakage with no utility.
  const stdioSession = Boolean(opts.onPacksChanged);
  return {
    ok: true,
    name: skillName,
    version,
    description,
    content,
    references,
    ...(stdioSession ? { skillRoot: SKILLS_ROOT } : {}),
  };
}
