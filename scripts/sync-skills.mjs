#!/usr/bin/env node
// Skill dual-source sync for the v2-pack program.
//
// The authoritative sources of the pack-owned skills live inside their packs:
//   plugins/huaweicloud-core/src/packs/<id>/skills/<name>/**
// The install/runtime tree stays at the historic location agents read:
//   plugins/huaweicloud-core/skills/<name>/**
// That tree is GENERATED: each authoritative file is copied with one marker
// line injected (an HTML comment, inert for agents and for markdownlint)
// right after the YAML frontmatter (or at the top when a file has no
// frontmatter). `npm run build` regenerates it as a build artifact beside
// dist/ (writeSkillsTree below), `--write` does the same on demand, and
// `--check` re-derives the expectation and fails on any drift, printing the
// authoritative path and the fix command (`npm run build`).
//
// Every skill — meta and service alike — is pack-owned: src/packs/core/
// carries the six meta-skills, the other packs carry their service skills,
// and the whole skills/ tree is generated. Non-markdown payloads
// (agents/*.yaml manifests) copy verbatim: the marker is an HTML comment,
// legal in markdown and invalid YAML, and generated-ness is detected from
// SKILL.md alone.
//
// Writing follows the staging discipline build-plugin.mjs applies to dist/:
// render everything into skills.new/, write the roster manifest, and swap
// only on success — a crashed run can never leave a half-written tree where
// a complete one stood. The swap replaces the whole tree, so stray
// hand-created directories under skills/ are wiped exactly like stale files;
// the tree is wholly derived, same as dist/.
//
// CRLF is normalized to LF before comparison; the injected marker line itself
// is stripped from the generated side so content compares byte-level.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(repoRoot, 'plugins', 'huaweicloud-core');
const packsDir = join(pluginRoot, 'src', 'packs');
const skillsDir = join(pluginRoot, 'skills');
const stagingSkillsDir = join(pluginRoot, 'skills.new');

const MARKER_PREFIX = '<!-- generated from ';
const MARKER_SUFFIX = ' - do not edit -->';
const MANIFEST_NAME = '.manifest.json';

function markerFor(packId, skillName) {
  return `${MARKER_PREFIX}src/packs/${packId}/skills/${skillName}${MARKER_SUFFIX}`;
}

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// Every directory under src/packs/<id>/skills/ is a pack-owned skill source.
function discoverPackSkills() {
  const out = [];
  for (const packId of listDirs(packsDir)) {
    const packSkillsDir = join(packsDir, packId, 'skills');
    for (const skillName of listDirs(packSkillsDir)) {
      out.push({ packId, skillName, sourceDir: join(packSkillsDir, skillName) });
    }
  }
  return out;
}

// Inject the marker as a pure insertion: right after the YAML frontmatter
// closing delimiter for SKILL.md, first line otherwise. Prettier later
// settles a blank line between the frontmatter block and the marker;
// stripMarkerLine tolerates both shapes, so --write output passes --check
// with or without a format pass (strip∘render is the identity).
function renderGenerated(packId, skillName, relativeFile, content) {
  const normalized = content.replace(/\r\n/g, '\n');
  // Non-markdown payloads (agents/*.yaml) copy verbatim: the marker is an
  // HTML comment, legal in markdown and invalid YAML. Generated-ness is
  // detected from SKILL.md alone (isGeneratedSkillDir), so omitting the
  // marker here loses no signal, and the --check byte comparison still
  // covers these files (stripMarkerLine is the identity without a marker).
  if (!relativeFile.endsWith('.md')) return normalized;
  const marker = markerFor(packId, skillName);
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(normalized);
  if (frontmatter && relativeFile === 'SKILL.md') {
    const cut = frontmatter[0].length;
    // Prettier-settled shape: one blank line between the frontmatter block
    // and the marker (the source's own blank after the frontmatter
    // separates marker from content). Emitting the settled shape closes
    // the format loop structurally — the raw insertion previously failed
    // format:check, so every sync-without-format re-broke CI exactly the
    // way the batch-3 commit did (round-10 finding). stripMarkerLine
    // tolerates both shapes, so the --check round-trip is unaffected.
    return `${normalized.slice(0, cut)}\n${marker}\n${normalized.slice(cut)}`;
  }
  // Reference files: prettier settles one blank after a first-line marker.
  // A source that already starts with a blank produces that shape under
  // the plain concatenation; otherwise the blank is inserted here.
  return `${marker}\n${normalized.startsWith('\n') ? normalized : `\n${normalized}`}`;
}

// Strip the injected marker line (wherever it sits — first line for files
// without frontmatter, right after the frontmatter for SKILL.md) and
// normalize CRLF, yielding content comparable to the authoritative source.
// Prettier settles one blank line around the marker: between the frontmatter
// block and the marker for SKILL.md (detected by both neighbors blank — the
// other blank is the source's own), or after a first-line marker for
// reference files (detected by the missing left neighbor). Exactly that one
// blank is undone; every other case is a pure removal, the inverse of the
// insertion renderGenerated performs.
function stripMarkerLine(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const index = lines.findIndex((line) => line.startsWith(MARKER_PREFIX) && line.endsWith(MARKER_SUFFIX));
  if (index === -1) return normalized;
  lines.splice(index, 1);
  const after = lines[index];
  const beforeBlank = index > 0 && lines[index - 1] === '';
  if (after === '' && (beforeBlank || index === 0)) lines.splice(index, 1);
  return lines.join('\n');
}

// The marker line a generated file must carry, or null when absent. --check
// compares it against markerFor(packId, skillName): the content comparison
// below strips the marker before comparing, so without this check a stale
// marker path (a pack directory renamed with --write skipped) survives every
// gate, including prepack.
function markerLineOf(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  return normalized.split('\n').find((line) => line.startsWith(MARKER_PREFIX) && line.endsWith(MARKER_SUFFIX)) ?? null;
}

// A skills/ directory is generated iff its SKILL.md carries the marker.
function isGeneratedSkillDir(skillDir) {
  const skillMd = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return false;
  return readFileSync(skillMd, 'utf8').includes(MARKER_PREFIX);
}

const generatedSkillDirs = () =>
  listDirs(skillsDir)
    .map((name) => ({ name, dir: join(skillsDir, name) }))
    .filter(({ dir }) => isGeneratedSkillDir(dir));

// The roster manifest travels with the generated tree (prettier-clean JSON):
// consumers (pack verification, install-side roster checks) read it instead
// of re-deriving the expectation from src/packs. Invisible to every skill
// reader — not a directory, no SKILL.md, no huawei* prefix.
function manifestJson(skillNames) {
  const roster = [...skillNames].sort((a, b) => a.localeCompare(b));
  return `${JSON.stringify({ generatedBy: 'scripts/sync-skills.mjs', skills: roster }, null, 2)}\n`;
}

// Full regeneration with the staging discipline build-plugin.mjs applies to
// dist/: render every source into skills.new/, write the manifest, swap only
// on success. The rm+rename pair leaves the same two-statement missing
// window the dist swap accepts; C2's fail-loud seams cover it. Replacing the
// whole tree (not incremental writes) is what makes stale files, stale skill
// dirs, and stray hand-created dirs vanish in one pass.
export function writeSkillsTree() {
  const packSkills = discoverPackSkills();
  if (packSkills.length === 0) {
    throw new Error('no pack skill sources found under src/packs/*/skills/ — refusing to replace the skills tree');
  }
  rmSync(stagingSkillsDir, { recursive: true, force: true });
  let files = 0;
  for (const { packId, skillName, sourceDir } of packSkills) {
    const targetDir = join(stagingSkillsDir, skillName);
    for (const file of walkFiles(sourceDir)) {
      const sourceContent = readFileSync(join(sourceDir, file), 'utf8').replace(/\r\n/g, '\n');
      const targetPath = join(targetDir, file);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, renderGenerated(packId, skillName, file, sourceContent));
      files += 1;
    }
  }
  writeFileSync(join(stagingSkillsDir, MANIFEST_NAME), manifestJson(packSkills.map(({ skillName }) => skillName)));
  rmSync(skillsDir, { recursive: true, force: true });
  renameSync(stagingSkillsDir, skillsDir);
  return { skills: packSkills.length, files };
}

function run({ write }) {
  if (write) {
    const { skills, files } = writeSkillsTree();
    return { failures: [], packSkills: skills, files };
  }
  const failures = [];
  const packSkills = discoverPackSkills();
  const expectedTargets = new Set(packSkills.map(({ skillName }) => skillName));

  for (const { packId, skillName, sourceDir } of packSkills) {
    const targetDir = join(skillsDir, skillName);
    for (const file of walkFiles(sourceDir)) {
      const sourcePath = join(sourceDir, file);
      const targetPath = join(targetDir, file);
      const sourceContent = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
      if (!existsSync(targetPath)) {
        failures.push(
          `missing generated file: ${relative(repoRoot, targetPath)} (source: ${relative(repoRoot, sourcePath)})`,
        );
        continue;
      }
      const rawTarget = readFileSync(targetPath, 'utf8');
      // Non-markdown payloads carry no marker (see renderGenerated).
      const expectedMarker = file.endsWith('.md') ? markerFor(packId, skillName) : null;
      const actualMarker = markerLineOf(rawTarget);
      if (actualMarker !== expectedMarker) {
        failures.push(
          `stale generated marker in ${relative(repoRoot, targetPath)}: expected "${expectedMarker}", found ${actualMarker ?? 'none'} — run: npm run build`,
        );
      }
      const actualStripped = stripMarkerLine(rawTarget);
      if (actualStripped !== sourceContent) {
        failures.push(
          `drift in ${relative(repoRoot, targetPath)} (authoritative source: ${relative(repoRoot, sourcePath)}) — run: npm run build`,
        );
      }
    }
  }

  // Generated skill dirs without a pack source are stale.
  for (const { name } of generatedSkillDirs()) {
    if (expectedTargets.has(name)) continue;
    failures.push(`stale generated skill with no pack source: skills/${name} — run: npm run build`);
  }

  // The manifest must be present and current (it ships with the tree).
  const manifestPath = join(skillsDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    failures.push(`missing skills manifest: ${relative(repoRoot, manifestPath)} — run: npm run build`);
  } else if (readFileSync(manifestPath, 'utf8') !== manifestJson(expectedTargets)) {
    failures.push(`stale skills manifest: ${relative(repoRoot, manifestPath)} — run: npm run build`);
  }

  return { failures, packSkills: packSkills.length };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href;
if (invokedDirectly) {
  const args = new Set(process.argv.slice(2));
  const write = args.has('--write');
  if (!write && !args.has('--check')) {
    console.error('usage: node scripts/sync-skills.mjs --write | --check');
    process.exit(2);
  }

  const { failures, packSkills, files } = run({ write });
  if (failures.length > 0) {
    console.error(`skills sync ${write ? 'reported' : 'check'} FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    if (!write) console.error('Fix with: npm run build');
    process.exit(1);
  }
  // stdout stays empty: npm pack --json parses stdout as JSON and this script
  // runs as the prepack tail (same stderr-only rule as build-plugin.mjs).
  console.error(
    `skills sync ${write ? 'wrote' : 'check OK'}: ${packSkills} pack skill(s)${write ? `, ${files} file(s)` : ''} in sync.`,
  );
}

// The round-trip pair is exported for the packs-sync test: --write output
// must pass --check without a prettier pass in between. writeSkillsTree is
// consumed by build-plugin.mjs (the skills tree is a build artifact).
export { renderGenerated, stripMarkerLine };
