// The skills-tree search index (the huaweicloud_search_docs handler),
// split out of tools.ts with the skill-disclosure family. Reads the same
// generated tree (SKILLS_ROOT from skill-disclosure.ts) and filters the
// index by the same pack-enablement posture (SKILL_OWNER from
// capability-catalog.ts).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveEnabledPacks } from './packs/enable.ts';
import { listSkillDirs } from './lib/skill-tree.ts';
import { parseSkillFrontmatter } from './lib/skill-frontmatter.ts';
import { SKILL_OWNER } from './capability-catalog.ts';
import { SKILLS_ROOT } from './skill-disclosure.ts';

export async function searchDocs(query: string, topic: string = 'all') {
  const q = String(query || '').toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  // Skills owned by a disabled pack are filtered out of the search index;
  // core-owned and unclaimed (foreign) skills stay searchable.
  const enabled = resolveEnabledPacks();
  const results: Array<{ source: string; name: string; snippet: string; relevance: number }> = [];
  try {
    if (existsSync(SKILLS_ROOT)) {
      const dirs = listSkillDirs(SKILLS_ROOT);
      for (const dir of dirs) {
        const owner = SKILL_OWNER.get(dir);
        if (owner && !enabled.has(owner)) continue;
        const skillPath = join(SKILLS_ROOT, dir, 'SKILL.md');
        if (!existsSync(skillPath)) continue;
        const content = readFileSync(skillPath, 'utf8');
        const fm = parseSkillFrontmatter(content);
        const description = fm.description ?? '';
        const name = fm.name ?? dir;
        if (topic !== 'all') {
          const topicLower = topic.toLowerCase();
          if (!name.toLowerCase().includes(topicLower) && !description.toLowerCase().includes(topicLower)) continue;
        }
        const descLower = description.toLowerCase();
        const nameLower = name.toLowerCase();
        const contentLower = content.toLowerCase();
        const relevance = tokens.reduce((score, token) => {
          return (
            score +
            (descLower.includes(token) ? 3 : 0) +
            (nameLower.includes(token) ? 2 : 0) +
            (contentLower.includes(token) ? 1 : 0)
          );
        }, 0);
        if (relevance > 0) {
          results.push({
            source: 'skills/' + dir + '/SKILL.md',
            name,
            snippet: description.substring(0, 200),
            relevance,
          });
        }
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), results: [] };
  }
  results.sort((a, b) => b.relevance - a.relevance);
  return { ok: true, query: q, topic, count: results.length, results: results.slice(0, 10) };
}
