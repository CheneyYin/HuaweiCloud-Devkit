// Ordered-subsequence matching over one recording channel — the flagship
// orderings surface (plan → approved run, discovery → execution, IAM
// validation → credential injection).

import type { SequenceExpectation } from './types.ts';
import type { ExpectationVerdict, Recordings } from './evaluate.ts';

// A cursor advances past extra records, so interleaved noise (boot prewarm,
// discovery probes) between the pinned steps is tolerated. Returns how far
// the cursor got — the failure evidence names the first unmatched step.
function matchSequence(
  exp: SequenceExpectation,
  recordings: Recordings,
): { matched: number; describe: (index: number) => string; channelTrace: string } {
  const describeStep = (index: number): string =>
    typeof exp.steps[index] === 'string' ? String(exp.steps[index]) : JSON.stringify(exp.steps[index]);
  if (exp.channel === 'toolCall') {
    const steps = exp.steps as string[];
    let cursor = 0;
    for (const call of recordings.toolCalls) {
      if (cursor < steps.length && call.name === steps[cursor]) cursor++;
    }
    return {
      matched: cursor,
      describe: describeStep,
      channelTrace: recordings.toolCalls.map((c) => `${c.name}(ok=${c.ok})`).join(' | '),
    };
  }
  if (exp.channel === 'gateway') {
    const steps = exp.steps as string[];
    let cursor = 0;
    for (const req of recordings.gateway) {
      if (cursor < steps.length && req.tool === steps[cursor]) cursor++;
    }
    return {
      matched: cursor,
      describe: describeStep,
      channelTrace: recordings.gateway.map((g) => `${g.method}${g.tool ? `:${g.tool}` : ''}`).join(' | '),
    };
  }
  const steps = exp.steps as { method?: string; path: string }[];
  let cursor = 0;
  for (const req of recordings.http) {
    const step = steps[cursor];
    if (cursor < steps.length && req.path === step.path && (!step.method || req.method === step.method)) {
      cursor++;
    }
  }
  return {
    matched: cursor,
    describe: describeStep,
    channelTrace: recordings.http.map((h) => `${h.method} ${h.path}`).join(' | '),
  };
}

// The sequence expectation's verdict constructor lives beside its matcher:
// this module owns the ordered-subsequence expectation end-to-end.
export function sequenceVerdict(
  exp: SequenceExpectation & { kind: 'sequence' },
  recordings: Recordings,
): ExpectationVerdict {
  const seq = matchSequence(exp, recordings);
  const pass = seq.matched === exp.steps.length;
  return {
    expectation: exp,
    pass,
    evidence: pass
      ? `all ${exp.steps.length} step(s) in order`
      : `stopped at step ${seq.matched + 1}/${exp.steps.length} (${seq.describe(seq.matched)}). Channel trace: ${seq.channelTrace || '(empty)'}`,
  };
}
