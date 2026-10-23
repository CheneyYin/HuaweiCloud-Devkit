import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asText } from './lib/as-text.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = resolve(__dirname, '..', '..', '..', 'package.json');

export const KOO_CLI_BASE = 'https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli';

const VERSION_RE = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

export function getKooCliVersion(): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const kooCliVersion = (parsed as Record<string, unknown>).kooCliVersion;
    return typeof kooCliVersion === 'string' && kooCliVersion ? kooCliVersion : null;
  } catch {
    return null;
  }
}

export function parseHcloudVersion(out: unknown): string | null {
  if (!out) return null;
  const match = asText(out).match(VERSION_RE);
  return match ? match[0] : null;
}

// String#split never returns an empty array, so the [0] indexes below are defined.
export function compareVersion(a: unknown, b: unknown): number {
  const pa = asText(a || '')
    .split(/[-+]/)[0]!
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = asText(b || '')
    .split(/[-+]/)[0]!
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export function kooCliDownloadBase(): string {
  return `${KOO_CLI_BASE}/${getKooCliVersion() || 'latest'}`;
}

// A4 (#935): KooCLI 7.2.x prints a version-upgrade banner on EVERY command
// output (e.g. 「可执行 hcloud update 更新至 7.3.12」), which floods agent
// conversations and drowns the actual result. The strip is SHAPE-ANCHORED at
// the line start (optional 可执行/可以执行/请执行 lead-in + `hcloud update` +
// 更新至/update to + a dotted version), never a bare content match:
//   - a whole line that IS the banner is dropped;
//   - a line that STARTS with the banner keeps its remainder (same-line
//     banner+JSON survives with the JSON intact);
//   - anything else — a JSON value mentioning the phrase, an error message
//     telling the user to update, help text for the update command — is kept
//     verbatim. New banner phrasings must be enumerated here explicitly.
// Lives beside the version primitives because both the CLI executor and the
// probe consume it (the probe must not misparse the banner's TARGET version
// as the installed one).
const KOOCLI_UPDATE_BANNER_PREFIX =
  /^\s*(?:可执行|可以执行|请执行)?\s*hcloud\s+update\s+(?:更新至|update to)\s*\d[\w.-]*[\s。！!]*/;

export function stripKooCliUpdateBanner(output: unknown): string {
  const text = asText(output || '');
  if (!/hcloud\s+update/i.test(text)) return text;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(KOOCLI_UPDATE_BANNER_PREFIX);
    if (!m) {
      out.push(line);
      continue;
    }
    const rest = line.slice(m[0].length).replace(/^\s+/, '');
    // Only the banner's own (now empty) line is dropped — a legitimately blank
    // output line is preserved by never reaching this branch.
    if (rest !== '') out.push(rest);
  }
  return out.join('\n');
}
