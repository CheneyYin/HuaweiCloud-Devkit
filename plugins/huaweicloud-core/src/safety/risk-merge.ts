import { evaluateCommandRisk, mergeRiskDecision, type RiskDecision } from '../risk-rule-engine.ts';
import type { ClassifyOptions } from './policy.ts';

// The risk-rule merge seam for both classifiers: a non-deny base decision
// is merged with the catalog's evaluation of the command text, unless the
// caller skipped risk rules. One spelling so the argv face and the text
// face can never disagree on whether rules ran.

function commandRiskText(normalizedArgs: string[], options: ClassifyOptions): string {
  return options.rawCommand || ['hcloud', ...normalizedArgs].join(' ');
}

export function applyCommandRiskRules(
  base: RiskDecision,
  normalizedArgs: string[],
  options: ClassifyOptions,
): RiskDecision {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(commandRiskText(normalizedArgs, options));
  return mergeRiskDecision(base, risk);
}

export function applyRawCommandRiskRules(base: RiskDecision, command: string, options: ClassifyOptions): RiskDecision {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(command);
  return mergeRiskDecision(base, risk);
}
