// The hcloud / http / gateway family shares one evidence shape verbatim:
// `N matching <noun>(s): <top 3>` on hits, `0 matching <noun>(s),
// expected <range>. <label>: <top 10 or (none)>` on zero hits. One copy
// here instead of three per-kind ternaries.

import type { Range } from './types.ts';
import { describeRange } from './evaluate-matchers.ts';

export function matchedEvidence(
  noun: string,
  hits: string[],
  times: Range | undefined,
  allLabel: string,
  trace: string[],
): string {
  if (hits.length > 0) return `${hits.length} matching ${noun}(s): ${hits.slice(0, 3).join(' | ')}`;
  return `0 matching ${noun}(s), expected ${describeRange(times)}. ${allLabel}: ${trace.slice(0, 10).join(' | ') || '(none)'}`;
}
