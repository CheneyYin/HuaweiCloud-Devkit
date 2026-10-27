// Security-group preflight for ECS create plans, extracted from the
// hcloud-cli monolith (the stable src/hcloud-cli.ts face re-exports the
// SgFinding type): spawns the read-only VPC ListSecurityGroupRules call
// per referenced security group and turns public-exposure findings
// (0.0.0.0/0 ::/0 ingress on sensitive ports, open ICMP) into warn/deny
// planning findings the plan folds into its risk classification.

import { spawnSync } from 'node:child_process';

import { asRecord } from './lib/as-record.ts';
import { asString } from './lib/as-text.ts';
import { resolveHcloudCommand } from './hcloud-probe.ts';
import type { RiskDecision } from './risk-rule-engine.ts';

export interface SgFinding {
  severity: 'warn' | 'deny';
  title: string;
  message: string;
}

// Port fields arrive from the VPC API as JSON numbers or strings; both must stringify.
function asPortText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

// Consumed by the plan module (hcloud-plan.ts); not part of the face's
// public surface.
export function preflightSecurityGroupCheck(normalizedArgs: string[]): SgFinding[] {
  const service = normalizedArgs[0];
  const operation = normalizedArgs[1] ?? '';
  if (service !== 'ECS' || !/CreateServers|RunInstances/i.test(operation)) return [];

  const sgIds: string[] = [];
  for (const arg of normalizedArgs) {
    const m = arg.match(/^(?:--security_group_id(?:\.\d+)?|--server\.security_groups(?:\.\d+)?\.id)=(.+)/);
    if (m) sgIds.push(m[1]!);
  }
  if (sgIds.length === 0) return [];

  const regionArg = normalizedArgs.find((a) => a.startsWith('--cli-region='));
  const findings: SgFinding[] = [];
  for (const sgId of sgIds) {
    try {
      const { executable, argsPrefix } = resolveHcloudCommand();
      const spawnArgs = ['VPC', 'ListSecurityGroupRules', `--security_group_id.1=${sgId}`];
      if (regionArg) spawnArgs.push(regionArg);
      const r = spawnSync(executable, [...argsPrefix, ...spawnArgs], {
        shell: false,
        windowsHide: true,
        stdio: 'pipe',
        timeout: 20000,
      });
      const stdout = (r.stdout || '').toString();
      if (r.status !== 0 || !stdout.includes('security_group_rules')) continue;

      const bracketIdx = stdout.indexOf('{');
      const jsonText = bracketIdx >= 0 ? stdout.slice(bracketIdx) : stdout;
      const data: unknown = JSON.parse(jsonText);
      const rulesValue = asRecord(data).security_group_rules;
      const rules = Array.isArray(rulesValue) ? rulesValue : [];

      for (const rule of rules) {
        const record = asRecord(rule);
        const direction = asString(record.direction) ?? '';
        const remoteIp = asString(record.remote_ip_prefix) ?? asString(record.remote_address_group_id) ?? '';
        const portMin = asPortText(record.port_range_min || record.multiport || '');
        const portMax = asPortText(record.port_range_max || record.multiport || '');
        const protocol = (asString(record.protocol) ?? '').toLowerCase();
        if (direction !== 'ingress') continue;
        if (remoteIp !== '0.0.0.0/0' && remoteIp !== '::/0') continue;
        if (protocol === 'icmp' || protocol === 'icmpv6') {
          findings.push({
            severity: 'warn',
            title: `Security group ${sgId}: ICMP open to public`,
            message: `安全组 ${sgId} 对公网开放了 ICMP (ping)，可能被用于探测。是否继续？`,
          });
          continue;
        }
        const sensitivePorts = ['22', '3389', '3306', '5432', '6379', '9200', '27017', '8080', '8443'];
        const port = portMin || portMax;
        if (port && sensitivePorts.includes(port)) {
          findings.push({
            severity: 'deny',
            title: `Security group ${sgId}: port ${port} open to public`,
            message: `安全组 ${sgId} 已对公网开放 ${port} 端口（${protocol || 'TCP'}）。确认继续创建 ECS？`,
          });
        }
      }
    } catch (error) {
      // Preflight failed silently; don't block the plan
    }
  }
  return findings;
}

// Consumed by the plan module (hcloud-plan.ts); not part of the face's
// public surface.
export function applyPreflightFindings(classification: RiskDecision, sgFindings: SgFinding[]): RiskDecision {
  if (!sgFindings || sgFindings.length === 0) return classification;
  const hasDeny = sgFindings.some((f) => f.severity === 'deny');
  if (hasDeny) {
    // Non-empty was checked at the top of this function; index 0 is defined.
    return {
      ...classification,
      decision: 'deny',
      risk: 'public_exposure',
      reason: sgFindings[0]!.message,
    };
  }
  return classification;
}
