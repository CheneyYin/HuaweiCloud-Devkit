import { getProxyDispatcher } from './proxy/proxy-agent.ts';
import { asRecord } from './lib/as-record.ts';

const INDEX_URL =
  'https://gitcode.com/api/v5/repos/2501_91318609/skills-for-index/contents/skills-index/index.json?ref=main';
const CN_EN_MAP_URL =
  'https://gitcode.com/api/v5/repos/2501_91318609/skills-for-index/contents/skills-index/cn-en-map.json?ref=main';
const HTTP_TIMEOUT_MS = 10000;

const GENERIC_KEYWORDS = new Set([
  '华为云',
  'huawei',
  'huawei cloud',
  '云',
  'cloud',
  '技能',
  'skill',
  'skills',
  '所有',
  'all',
  '全部',
  '有什么',
  '有哪些',
  '相关',
  '列表',
  'list',
  '查找',
  '搜索',
  '发现',
  '浏览',
  'find',
  'search',
  'discover',
  'browse',
  'show',
  'explore',
  'agent',
  '市场',
  'market',
  '类目',
  'category',
  '安装',
  'install',
]);

interface MarketSkill {
  name?: string;
  description?: string;
  service?: string;
  category?: string;
  triggers?: string[];
}

interface MarketIndex {
  skills?: MarketSkill[];
  categories?: string[];
}

interface MarketplaceItem {
  score: number;
  name: string;
  category: string;
  service: string;
  description: string;
  triggers: string[];
  matched: string[];
  installCommand: string;
  installHint: string;
}

interface MarketplaceSearchResult {
  ok: boolean;
  query: string;
  category: string;
  count: number;
  results: MarketplaceItem[];
  fallback?: string[];
  expandedKeywords?: string[];
}

let cachedIndex: MarketIndex | null = null;
let cachedCnEnMap: Record<string, string> | null = null;

function toMarketSkill(value: unknown): MarketSkill {
  const raw = asRecord(value);
  return {
    name: typeof raw.name === 'string' ? raw.name : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    service: typeof raw.service === 'string' ? raw.service : undefined,
    category: typeof raw.category === 'string' ? raw.category : undefined,
    triggers: Array.isArray(raw.triggers)
      ? raw.triggers.filter((trigger): trigger is string => typeof trigger === 'string')
      : undefined,
  };
}

function toMarketIndex(value: unknown): MarketIndex {
  const raw = asRecord(value);
  return {
    skills: Array.isArray(raw.skills) ? raw.skills.map((skill) => toMarketSkill(skill)) : undefined,
    categories: Array.isArray(raw.categories)
      ? raw.categories.filter((category): category is string => typeof category === 'string')
      : undefined,
  };
}

function toCnEnMap(value: unknown): Record<string, string> {
  const raw = asRecord(value);
  const map: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === 'string') map[key] = val;
  }
  return map;
}

async function fetchJson(url: string, label = ''): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const dispatcher = await getProxyDispatcher(url);
    const fetchOpts: RequestInit & { dispatcher?: unknown } = {
      headers: { 'User-Agent': 'huaweicloud-devkit/1.0' },
      signal: controller.signal,
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const resp = await fetch(url, fetchOpts);
    const data: unknown = await resp.json();
    const record = asRecord(data);
    if (record.encoding === 'base64' && typeof record.content === 'string' && record.content) {
      const decoded = Buffer.from(record.content, 'base64').toString('utf8');
      return JSON.parse(decoded);
    }
    return data;
  } catch (error) {
    throw new Error(`Failed to fetch ${label}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function loadIndex(): Promise<MarketIndex> {
  if (!cachedIndex) cachedIndex = toMarketIndex(await fetchJson(INDEX_URL, 'index.json'));
  return cachedIndex;
}

async function loadCnEnMap(): Promise<Record<string, string>> {
  if (!cachedCnEnMap) cachedCnEnMap = toCnEnMap(await fetchJson(CN_EN_MAP_URL, 'cn-en-map.json'));
  return cachedCnEnMap;
}

export function clearMarketCache(): void {
  cachedIndex = null;
  cachedCnEnMap = null;
}

function isGeneric(kw: string): boolean {
  const k = kw.toLowerCase().trim();
  return GENERIC_KEYWORDS.has(k) || /华为云|huawei/i.test(k);
}

function expandKeywords(rawKeyword: string, cnEnMap: Record<string, string>): [string[], string[]] {
  if (!rawKeyword) return [[], []];
  const parts = rawKeyword.replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean);
  const expanded = [...parts];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (cnEnMap[p]) expanded.push(cnEnMap[p]);
    for (const [cn, en] of Object.entries(cnEnMap)) {
      if (en === lower) expanded.push(cn);
    }
  }
  const unique = [...new Set(expanded)].sort((a, b) => a.localeCompare(b));
  const specific = unique.filter((kw) => !isGeneric(kw));
  const generic = unique.filter((kw) => isGeneric(kw));
  return [specific, generic];
}

function scoreSkill(skill: MarketSkill, specificKws: string[], genericKws: string[]): [number, string[]] {
  if (!specificKws.length && !genericKws.length) return [1, []];
  let total = 0;
  const matched: string[] = [];
  const nameLower = (skill.name || '').toLowerCase();
  const descLower = (skill.description || '').toLowerCase();
  const serviceLower = (skill.service || '').toLowerCase();
  const triggers = (skill.triggers || []).map((t) => (t || '').toLowerCase());

  for (const kw of specificKws) {
    const k = kw.toLowerCase();
    let s = 0;
    if (nameLower.includes(k)) s += 10;
    else if (triggers.some((t) => t.includes(k))) s += 8;
    else if (descLower.includes(k)) s += 5;
    else if (serviceLower.includes(k)) s += 3;
    if (s > 0) {
      total += s;
      matched.push(kw);
    }
  }
  for (const kw of genericKws) {
    const k = kw.toLowerCase();
    let s = 0;
    if (nameLower.includes(k)) s += 10;
    else if (triggers.some((t) => t.includes(k))) s += 4;
    else if (descLower.includes(k)) s += 2;
    else if (serviceLower.includes(k)) s += 1;
    if (s > 0) {
      total += s;
      matched.push(kw);
    }
  }
  if (!specificKws.length && total === 0) {
    total = 1;
    if (descLower.length > 20) total += 1;
    if (triggers.length) total += 1;
  }
  return [total, matched];
}

function truncate(desc: string | undefined, limit = 150): string {
  if (!desc) return '';
  return desc.length > limit ? desc.slice(0, limit) + '...' : desc;
}

// Build a git-free install command: download the skills repo ZIP over HTTP,
// extract it, locate the skill folder by name, and copy it into the caller's
// agent skills directory. `npx skills add ...` requires git on PATH, which is
// absent on stripped Windows Server / sandbox environments (#F). When even HTTP
// download fails the returned fallback notes guide a manual download instead of
// trying to install git.
export function buildSkillInstallCommand(skill: MarketSkill, skillsDirHint = '<your-agent-skills-dir>'): string {
  const esc = (s: string | undefined) =>
    String(s || '')
      .replace(/\./g, '-')
      .replace(/[^A-Za-z0-9_-]/g, '-');
  const name = esc(skill.name);
  const rel = skill.category && skill.service ? `skills/${esc(skill.category)}/${esc(skill.service)}/${name}` : null;
  const findSrc = rel
    ? `SKILL_SRC="/tmp/hw-skills-net/huaweicloud-skills-master/${rel}"`
    : `SKILL_SRC=$(find /tmp/hw-skills-net/huaweicloud-skills-master/skills -type d -name "${name}" 2>/dev/null | head -1)`;
  // P4: the skills-dir hint is caller-supplied and spliced into shell — quote it
  // and strip shell metacharacters so a hostile/broken hint cannot inject args.
  const dirEsc = String(skillsDirHint || '').replace(/[^A-Za-z0-9_./~-]/g, '-');
  const targetDir = dirEsc === '' ? '<your-agent-skills-dir>' : dirEsc;
  return [
    '(curl -fsSL https://gitcode.com/huaweicloud/huaweicloud-skills/-/archive/master/huaweicloud-skills-master.zip -o /tmp/hw-skills.zip && unzip -oq /tmp/hw-skills.zip -d /tmp/hw-skills-net) || (curl -fsSL https://github.com/huaweicloud/huaweicloud-skills/archive/refs/heads/master.zip -o /tmp/hw-skills.zip && unzip -oq /tmp/hw-skills.zip -d /tmp/hw-skills-net)',
    `&& ${findSrc}`,
    // P5: short-circuit the && chain on a missing / non-skill folder — `echo`
    // exits 0, so the branch must end with `false` or cp -r would still run.
    `&& (test -d "$SKILL_SRC" || { echo "SKILL_SRC_NOT_FOUND"; false; })`,
    `&& (test -f "$SKILL_SRC/SKILL.md" || { echo "SKILL_SRC_NOT_FOUND"; false; })`,
    `&& mkdir -p "${targetDir}" && cp -r "$SKILL_SRC" "${targetDir}/${name}"`,
  ].join(' ');
}

const INSTALL_DOWNLOAD_HINT =
  'No git required — installs by downloading the repo ZIP over HTTP and copying the skill folder. ' +
  'If the command reports SKILL_SRC_NOT_FOUND, replace <your-agent-skills-dir> with this agent\u2019s skills directory ' +
  '(Claude Code ~/.claude/skills, OpenCode ~/.config/opencode/skills, Cursor ~/.cursor/skills) and re-run. ' +
  'If HTTP download itself fails, download https://github.com/huaweicloud/huaweicloud-skills/archive/refs/heads/master.zip ' +
  'manually, extract it, copy the skill folder, and tell the user how the skill was installed.';

export async function searchMarketplace(query = '', category = ''): Promise<MarketplaceSearchResult> {
  const idx = await loadIndex();
  const cnEnMap = await loadCnEnMap();
  const [specificKws, genericKws] = expandKeywords(query, cnEnMap);
  const hasSpecific = specificKws.length > 0;

  const results: MarketplaceItem[] = [];
  for (const skill of idx.skills || []) {
    if (category && skill.category !== category) continue;
    const [score, matched] = scoreSkill(skill, specificKws, genericKws);
    if (hasSpecific && score === 0) continue;
    results.push({
      score,
      name: skill.name || '',
      category: skill.category || '',
      service: skill.service || '',
      description: truncate(skill.description),
      triggers: (skill.triggers || []).slice(0, 5),
      matched,
      installCommand: buildSkillInstallCommand(skill),
      installHint: INSTALL_DOWNLOAD_HINT,
    });
  }
  results.sort((a, b) => b.score - a.score);

  if (!results.length) {
    return {
      ok: true,
      query,
      category,
      count: 0,
      results: [],
      fallback: [
        'Try broader or alternative keywords',
        'Remove category filter',
        'Switch CN<->EN (e.g., obs <-> object storage)',
        'List all: search with empty keyword and a category',
      ],
    };
  }

  const allKws = [...new Set([...specificKws, ...genericKws])];
  return {
    ok: true,
    query,
    category,
    count: results.length,
    expandedKeywords: allKws.length > 1 ? allKws : undefined,
    results,
  };
}

export async function getMarketplaceCategories(): Promise<{ ok: boolean; categories: string[] }> {
  const idx = await loadIndex();
  return { ok: true, categories: idx.categories || [] };
}
