// hcloud command planning, extracted from the hcloud-cli monolith (the
// stable src/hcloud-cli.ts face re-exports planHcloudCommand and the plan
// types): the pre-execution contract — quoted command echo, risk
// classification, OBS/SG/parameter warnings, required-parameter
// validation, and the approval token. The consent layer itself lives in
// src/lib/approval-tokens.ts.

import { classifyHcloudArgs, redactSecrets, type ClassifyOptions } from './safety-policy.ts';
import { createApprovalToken } from './lib/approval-tokens.ts';
import type { RiskDecision } from './risk-rule-engine.ts';
import { obsWriteHint } from './hcloud-obs-redact.ts';
import { applyPreflightFindings, preflightSecurityGroupCheck, type SgFinding } from './hcloud-sg-preflight.ts';

// Approval tokens must survive a process boundary: plan and run land in
// different MCP sessions/processes (and headless subprocesses), so the old
// in-memory Map lost the token and plan→approve→run became unreachable (#578).
// The machinery lives in src/lib/approval-tokens.ts (the CLI face's
// consent layer for plan_cli_command / run_approved_command).

export interface HcloudPlan {
  executable: string;
  args: string[];
  command: string;
  executableBlock: string;
  warnings: Array<string | SgFinding>;
  classification: RiskDecision;
  sgFindings: SgFinding[];
  approvalToken: string;
  safeToRun: boolean;
}

export interface HcloudPlanWithArgs extends HcloudPlan {
  rawArgs: string[];
}

function quoteShellArg(value: unknown): string {
  const text = String(value);
  if (!text) return '""';
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\])/g, '\\$1')}"`;
}

function planningWarnings(args: string[]): string[] {
  const joined = args.join(' ');
  const warnings: string[] = [];
  if (/admin[_-]?pass|password|passwd|secret|token/i.test(joined)) {
    warnings.push(
      'This command appears to contain a password or secret field. Do not leave plaintext secrets in shell history; prefer local-only input or a runtime injection pattern.',
    );
  }
  return warnings;
}

const REQUIRED_PARAMS: Record<string, string[]> = {
  'ECS CreateServers': ['server.flavorRef', 'server.imageRef', 'server.nics.1.subnet_id'],
  'VPC CreateVpc': ['vpc.cidr'],
  'VPC CreateSubnet': ['subnet.vpc_id', 'subnet.cidr'],
  'VPC CreateSecurityGroupRule': [
    'security_group_rule.security_group_id',
    'security_group_rule.direction',
    'security_group_rule.protocol',
  ],
  'EIP CreatePublicip': ['bandwidth.share_type', 'publicip.type'],
  'FunctionGraph CreateFunction': ['func_name', 'runtime', 'handler', 'memory_size', 'package', 'timeout'],
  'FunctionGraph CreateFunctionTrigger': ['function_urn', 'trigger_type_code'],
  'APIG CreateInstanceV2': ['spec_id'],
  'OBS mb': ['obs://'],
  'OBS rm': ['obs://'],
};

const PARAM_VALUE_HINTS: Record<string, string> = {
  'server.flavorRef': 'Run `hcloud ECS ListFlavors --cli-region=<r>` to find valid flavors',
  'server.imageRef': 'Run `hcloud IMS ListImages --cli-region=<r> --__imagetype=gold` to find valid image IDs',
  'server.nics.1.subnet_id': 'Run `hcloud VPC ListSubnets --cli-region=<r>` to find subnet IDs',
  'subnet.vpc_id': 'Run `hcloud VPC ListVpcs --cli-region=<r>` to find VPC IDs',
  func_name: 'Function name must be unique within project',
  runtime: 'Run `hcloud FunctionGraph ListRuntimes` to see available runtimes',
  spec_id: 'APIG spec: BASIC (no public IP) or PROFESSIONAL (requires --loadbalancer_provider)',
  'obs://': 'Bucket name must be globally unique and DNS-compliant (lowercase, numbers, hyphens only)',
};

function validateRequiredParams(args: string[]): { valid: boolean; missing: string[]; hints: string[] } {
  if (!args || args.length < 2) return { valid: true, missing: [], hints: [] };
  const key = `${args[0]} ${args[1]}`;
  const required = REQUIRED_PARAMS[key];
  if (!required) return { valid: true, missing: [], hints: [] };
  const argsStr = args.join(' ');
  const missing = required.filter((param) => !argsStr.includes(param));
  const hints = missing.map((param) => PARAM_VALUE_HINTS[param]).filter((hint): hint is string => Boolean(hint));
  return { valid: missing.length === 0, missing, hints };
}

export function planHcloudCommand(args: unknown, options: ClassifyOptions = {}): HcloudPlan {
  const normalizedArgs = Array.isArray(args) ? args.map(String) : [];
  const classification = classifyHcloudArgs(normalizedArgs, options);
  const command = ['hcloud', ...normalizedArgs].map((arg) => quoteShellArg(arg)).join(' ');
  const warnings: Array<string | SgFinding> = planningWarnings(normalizedArgs);
  const obsHint = obsWriteHint(normalizedArgs);
  if (obsHint) warnings.push(obsHint);
  const sgFindings = preflightSecurityGroupCheck(normalizedArgs);
  if (sgFindings.length > 0) {
    for (const f of sgFindings) warnings.push(f);
  }
  const paramValidation = validateRequiredParams(normalizedArgs);
  if (paramValidation.missing.length > 0) {
    warnings.push('Missing required parameters: ' + paramValidation.missing.join(', '));
    if (paramValidation.hints && paramValidation.hints.length > 0) {
      warnings.push('Find valid values: ' + paramValidation.hints.join('; '));
    }
  }
  return {
    executable: 'hcloud',
    args: normalizedArgs.map((arg) => redactSecrets(arg)),
    // The plan echo is a COMMAND string, not child-process output — banner
    // stripping is an output concern, and an argument VALUE that happens to
    // carry banner-shaped text must never blank the command the user is asked
    // to approve (redactSecrets only).
    command: redactSecrets(command),
    executableBlock: redactSecrets(command),
    warnings,
    classification: applyPreflightFindings(classification, sgFindings),
    sgFindings,
    approvalToken: createApprovalToken(normalizedArgs),
    safeToRun: classification.decision === 'allow',
  };
}
