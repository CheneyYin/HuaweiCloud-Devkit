#!/usr/bin/env node
// Skill dual-source sync for the v2-pack program.
//
// The authoritative sources of the pack-owned skills live inside their packs:
//   plugins/huaweicloud-core/src/packs/<id>/skills/<name>/**
// The install/runtime tree stays at the historic location agents read:
//   plugins/huaweicloud-core/skills/<name>/**
// That tree is GENERATED: `--write` copies each authoritative file and
// injects one marker line (an HTML comment, inert for agents and for
// markdownlint) right after the YAML frontmatter (or at the top when a file
// has no frontmatter). `--check` re-derives the expectation and fails on any
// drift, printing the authoritative path and the fix command
// (`npm run skills:sync`).
//
// Meta-skills and core service skills are still hand-written directly under
// skills/ and are not touched: a skills/ directory counts as generated only
// when its SKILL.md carries the marker line.
//
// CRLF is normalized to LF before comparison; the injected marker line itself
// is stripped from the generated side so content compares byte-level.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(repoRoot, 'plugins', 'huaweicloud-core');
const packsDir = join(pluginRoot, 'src', 'packs');
const skillsDir = join(pluginRoot, 'skills');

const MARKER_PREFIX = '<!-- generated from ';
const MARKER_SUFFIX = ' - do not edit -->';

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
  const marker = markerFor(packId, skillName);
  const normalized = content.replace(/\r\n/g, '\n');
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(normalized);
  if (frontmatter && relativeFile === 'SKILL.md') {
    const cut = frontmatter[0].length;
    return `${normalized.slice(0, cut)}${marker}\n${normalized.slice(cut)}`;
  }
  return `${marker}\n${normalized}`;
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

function run({ write }) {
  const failures = [];
  const packSkills = discoverPackSkills();
  const expectedTargets = new Set(packSkills.map(({ skillName }) => skillName));

  for (const { packId, skillName, sourceDir } of packSkills) {
    const targetDir = join(skillsDir, skillName);
    for (const file of walkFiles(sourceDir)) {
      const sourcePath = join(sourceDir, file);
      const targetPath = join(targetDir, file);
      const sourceContent = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
      if (write) {
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, renderGenerated(packId, skillName, file, sourceContent));
      } else if (!existsSync(targetPath)) {
        failures.push(
          `missing generated file: ${relative(repoRoot, targetPath)} (source: ${relative(repoRoot, sourcePath)})`,
        );
      } else {
        const actualStripped = stripMarkerLine(readFileSync(targetPath, 'utf8'));
        if (actualStripped !== sourceContent) {
          failures.push(
            `drift in ${relative(repoRoot, targetPath)} (authoritative source: ${relative(repoRoot, sourcePath)}) — run: npm run skills:sync`,
          );
        }
      }
    }
    if (write) {
      // Drop stale generated files that no longer exist in the source pack.
      if (existsSync(targetDir)) {
        const expectedFiles = new Set(walkFiles(sourceDir));
        for (const file of walkFiles(targetDir)) {
          if (!expectedFiles.has(file)) rmSync(join(targetDir, file));
        }
      }
    }
  }

  // Generated skill dirs without a pack source are stale and must go.
  for (const { name, dir } of generatedSkillDirs()) {
    if (expectedTargets.has(name)) continue;
    if (write) {
      rmSync(dir, { recursive: true, force: true });
    } else {
      failures.push(`stale generated skill with no pack source: skills/${name} — run: npm run skills:sync`);
    }
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

  const { failures, packSkills } = run({ write });
  if (failures.length > 0) {
    console.error(`skills sync ${write ? 'reported' : 'check'} FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    if (!write) console.error('Fix with: npm run skills:sync');
    process.exit(1);
  }
  // stdout stays empty: npm pack --json parses stdout as JSON and this script
  // runs as the prepack tail (same stderr-only rule as build-plugin.mjs).
  console.error(`skills sync ${write ? 'wrote' : 'check OK'}: ${packSkills} pack skill source(s) in sync.`);
}

// The round-trip pair is exported for the packs-sync test: --write output
// must pass --check without a prettier pass in between.
export { renderGenerated, stripMarkerLine };
