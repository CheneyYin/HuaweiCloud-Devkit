import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { classifyHcloudArgs, redactSecrets, assertAllowed, type ClassifyOptions } from './safety-policy.ts';
import { createApprovalToken } from './lib/approval-tokens.ts';
import type { RiskDecision } from './risk-rule-engine.ts';
import { getProxySettings } from './proxy/proxy-config.ts';
import { resolveHcloudCommand } from './hcloud-probe.ts';
import { stripKooCliUpdateBanner } from './koocli-version.ts';
import { extractApiError, redactOutput } from './hcloud-api-error.ts';
import { obsWriteHint, redactArgsWithObs } from './hcloud-obs-redact.ts';
import { appendLangHint, UNSUPPORTED_SERVICE_RE, type UnsupportedCause } from './hcloud-catalog.ts';
import { isTemporaryStsExpired, resolveStsInjectArgs } from './hcloud-sts.ts';
import { applyPreflightFindings, preflightSecurityGroupCheck, type SgFinding } from './hcloud-sg-preflight.ts';

// The CLI face's consent layer lives in src/lib/approval-tokens.ts; these
// re-exports keep existing import sites (tests) compiling — the
// tool-schemas.ts re-export precedent.
export { hashArgs, createApprovalToken, consumeApprovalToken, inspectApprovalToken } from './lib/approval-tokens.ts';
// The #935 A4 banner strip (see koocli-version.ts) re-exported for the
// executor's existing test import sites.
export { stripKooCliUpdateBanner } from './koocli-version.ts';
// The OBS arg redaction and the API-error/output-redaction family, moved to
// their own modules — same names, same import path, same behavior.
export { redactArgsWithObs } from './hcloud-obs-redact.ts';
export { extractApiError, redactOutput, type ApiErrorInfo } from './hcloud-api-error.ts';
// The service-catalog, STS-injection, and SG-preflight families, moved to
// their own modules — same names, same import path, same behavior.
export {
  readServiceCatalogs,
  classifyUnsupported,
  type ServiceCatalogCache,
  type UnsupportedCause,
} from './hcloud-catalog.ts';
export { resolveStsInjectArgs } from './hcloud-sts.ts';
export type { SgFinding } from './hcloud-sg-preflight.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_FORCE_KILL_AFTER_MS = 2_000;
const DEFAULT_MAX_RETRIES = 1;
const LARGE_OUTPUT_THRESHOLD = 50_000;
const OUTPUT_DIR = join('/tmp', 'huaweicloud-devkit');

// Approval tokens must survive a process boundary: plan and run land in
// different MCP sessions/processes (and headless subprocesses), so the old
// in-memory Map lost the token and plan→approve→run became unreachable (#578).
// The machinery lives in src/lib/approval-tokens.ts (the CLI face's
// consent layer for plan_cli_command / run_approved_command).

function saveLargeOutput(rawStdout: string): string | null {
  if (rawStdout.length <= LARGE_OUTPUT_THRESHOLD) return null;
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const filePath = join(OUTPUT_DIR, `output-${Date.now()}.json`);
    writeFileSync(filePath, rawStdout, { encoding: 'utf8' });
    return filePath;
  } catch {
    return null;
  }
}

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

export interface HcloudRunResult {
  ok: boolean;
  code?: string;
  error?: string;
  errorCode?: string;
  errorMessage?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  plan?: HcloudPlanWithArgs;
  outputFile?: string;
  retries?: number;
  attempts?: number;
  authWarning?: string | null;
  langCause?: UnsupportedCause;
  langHint?: string;
  langNextStep?: string;
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

export interface HcloudRunOptions extends ClassifyOptions {
  metaDir?: string;
  timeoutMs?: number;
  forceKillAfterMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  cwd?: string;
  stdin?: string | ((_stream: NodeJS.WritableStream) => void);
  executable?: string;
  executableArgs?: unknown;
  env?: Record<string, string | undefined>;
}

export async function runHcloud(args: unknown, options: HcloudRunOptions = {}): Promise<HcloudRunResult> {
  const normalizedArgs = Array.isArray(args) ? args.map(String) : [];
  const plan: HcloudPlanWithArgs = {
    ...planHcloudCommand(normalizedArgs, options),
    rawArgs: normalizedArgs,
  };
  assertAllowed(plan.classification);

  // Fail fast when the platform-injected temporary STS is already expired —
  // otherwise hcloud would make a doomed IAM round trip and surface a
  // misleading error (e.g. "缺少 cli-domain-id"). Permanent AK/SK and
  // unknown-expiry tokens are never gated.
  if (isTemporaryStsExpired()) {
    return {
      ok: false,
      code: 'CREDENTIAL_EXPIRED',
      error:
        'Temporary STS credentials have expired. Re-login or start a new session so the platform injects fresh credentials, then retry.',
      stderr: '',
      stdout: '',
      plan,
    };
  }

  // Link B: when the runtime/environment carries live temporary STS credentials
  // (security token set), KooCLI/obsutil would not see them (they read S2/S3 only
  // and R3 forbids writing them to disk). Inject per-command so hcloud actually
  // authenticates with the platform-provided STS. Injection args are appended to
  // the EXECUTED args only; classification/approval used the original args.
  const stsInject = resolveStsInjectArgs(normalizedArgs);
  if (stsInject.length > 0) {
    plan.rawArgs = [...plan.rawArgs, ...stsInject];
  }

  const metaDir = options.metaDir;

  // KooCLI only switches language globally (`hcloud configure set --cli-lang=cn`); there is no
  // per-command `--cli-lang` flag (it is rejected as "不正确的参数:cli-lang"). So we never mutate
  // the command — we run it as-is and annotate `Unsupported service` with an actionable cause.
  const result = await runHcloudOnceWithRetries(plan, options);
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  const match = text.match(UNSUPPORTED_SERVICE_RE);
  if (match && !result.ok) {
    // UNSUPPORTED_SERVICE_RE's capture group always participates on a match.
    return appendLangHint(result, match[1]!, metaDir);
  }
  return result;
}

async function runHcloudOnceWithRetries(plan: HcloudPlanWithArgs, options: HcloudRunOptions): Promise<HcloudRunResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await runHcloudOnce(plan, options);
    if (result.ok || attempt >= maxRetries || !isRetryableNetworkError(result)) {
      const merged: HcloudRunResult = {
        ...result,
        retries: attempt,
        attempts: attempt + 1,
      };
      if (merged.ok) {
        const warning = await runtimeCurrentMismatchWarning();
        return warning ? { ...merged, authWarning: warning } : merged;
      }
      return merged;
    }
    await wait((options.retryBaseDelayMs ?? 500) * 2 ** attempt);
  }
  throw new Error('Unreachable retry state.');
}

async function runtimeCurrentMismatchWarning(): Promise<string | null> {
  try {
    const { hasRuntimeCredentials, scanState } = await import('./auth/reconcile.ts');
    if (!hasRuntimeCredentials()) return null;
    const scan = scanState();
    const { runtimeFingerprint, currentFingerprint } = scan.stores;
    if (runtimeFingerprint && currentFingerprint && runtimeFingerprint !== currentFingerprint) {
      return '会话内临时账号与 KooCLI current 档不一致：hcloud 命令仍使用 current 档账号。如需对齐请用 huaweicloud_auth_switch action=persist。';
    }
    return null;
  } catch {
    // reconcile unavailable → no warning, never block the command
    return null;
  }
}

function runHcloudOnce(plan: HcloudPlanWithArgs, options: HcloudRunOptions): Promise<HcloudRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const forceKillAfterMs = options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS;
  // One resolution chain with the prober (hcloud-probe's resolveHcloudCommand
  // over the shared lib/dep-resolve tier order): options.env is child
  // environment, never an executable override, and HCLOUD_BIN_ARGS_JSON is
  // honored here exactly as the prober honors it.
  const { executable, argsPrefix } = resolveHcloudCommand({
    executable: options.executable,
    executableArgs: options.executableArgs,
  });
  const executableArgs = argsPrefix.map(String);
  const cwd = options.cwd || undefined;
  const stdin = options.stdin ?? 'y\n';
  const childOptions: HcloudRunOptions = { ...options };
  delete childOptions.metaDir;
  const childEnv = { ...process.env, ...childOptions.env };

  return new Promise<HcloudRunResult>((resolve) => {
    const proxySettings = getProxySettings();
    const proxyEnv: Record<string, string> = {};
    if (proxySettings) {
      if (proxySettings.https_proxy) proxyEnv.HTTPS_PROXY = proxySettings.https_proxy;
      if (proxySettings.http_proxy) proxyEnv.HTTP_PROXY = proxySettings.http_proxy;
      if (proxySettings.no_proxy) proxyEnv.NO_PROXY = proxySettings.no_proxy;
    }
    const child = spawn(executable, [...executableArgs, ...plan.rawArgs], {
      shell: false,
      windowsHide: true,
      cwd,
      env: {
        ...process.env,
        ...proxyEnv,
        ...childEnv,
      },
    });
    if (stdin) {
      if (typeof stdin === 'function') {
        stdin(child.stdin);
      } else {
        child.stdin.write(String(stdin));
        child.stdin.end();
      }
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    function finish(result: HcloudRunResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(settleTimer);
      if (result.stdout && String(result.stdout).length > LARGE_OUTPUT_THRESHOLD) {
        // A4 (#935): the raw accumulator still carries the banner — the saved
        // file is agent-read (the truncated stdout points at it), so the strip
        // must apply here too, not only to the in-band redacted stdout.
        const outputFile = saveLargeOutput(stripKooCliUpdateBanner(stdout));
        if (outputFile) {
          result.outputFile = outputFile;
          result.stdout = String(result.stdout).slice(0, 2000) + `\n...(truncated, full output saved to ${outputFile})`;
        }
      }
      // Never surface raw args (may include the injected temporary STS) to MCP
      // clients / agent conversation — redact before resolve. The live `plan`
      // object itself is left untouched so retries keep executing the real args.
      if (result.plan && Array.isArray(result.plan.rawArgs)) {
        const redactedPlan: HcloudPlanWithArgs = {
          ...result.plan,
          rawArgs: redactArgsWithObs(result.plan.rawArgs),
        };
        result.plan = redactedPlan;
      }
      resolve(result);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), forceKillAfterMs);
      settleTimer = setTimeout(() => {
        // Same shape the close-path TIMEOUT and SPAWN_ERROR results carry:
        // exitCode/signal are always present (null when unknown — the child
        // never reported a close event on this backstop path).
        finish({
          ok: false,
          code: 'TIMEOUT',
          error: `hcloud command timed out after ${timeoutMs} ms.`,
          exitCode: null,
          signal: null,
          stdout: redactOutput(stdout),
          stderr: redactOutput(stderr),
          plan,
        });
      }, forceKillAfterMs + 500);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({
        ok: false,
        code: 'SPAWN_ERROR',
        error: error.message,
        exitCode: null,
        signal: null,
        plan,
      });
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          code: 'TIMEOUT',
          error: `hcloud command timed out after ${timeoutMs} ms.`,
          exitCode: code,
          signal,
          stdout: redactOutput(stdout),
          stderr: redactOutput(stderr),
          plan,
        });
        return;
      }
      const apiError = extractApiError(stdout);
      if (apiError) {
        finish({
          ok: false,
          exitCode: code,
          signal,
          errorCode: apiError.errorCode,
          errorMessage: apiError.errorMessage,
          stdout: redactOutput(stdout),
          stderr: redactOutput(stderr),
          plan,
        });
        return;
      }
      // #921: two ok-gate holes that surfaced from live testing are closed here:
      //   1. exit code 0 but the output carries a KooCLI parameter error (e.g.
      //      `--delete_ip` instead of `--delete_publicip`) — the command never
      //      executed; report ok:false with a PARAM_ERROR errorCode.
      //   2. non-zero exit code with "successfully" in the output — the old
      //      broad regex flagged ANY failure mentioning "successfully". It is
      //      narrowed to OBS obsutil-style commands (which are known to return
      //      non-zero exit codes on success, #57) AND require the output to
      //      carry no error indicators.
      const combined = `${stdout}${stderr}`;
      const paramError = combined.match(
        /\[?(?:ERROR|USE_ERROR)\]?[: ]*(?:unknown parameter|unknown option|incorrect (?:option|switch|parameter)|invalid (?:parameter|argument)|参数不存在|参数错误|无效的参数)[^\n]*/i,
      );
      if (paramError) {
        finish({
          ok: false,
          exitCode: code,
          signal,
          errorCode: 'PARAM_ERROR',
          errorMessage: paramError[0]?.trim() ?? '',
          stdout: redactOutput(stdout),
          stderr: redactOutput(stderr),
          plan,
        });
        return;
      }
      const isObsCommand = /^obs\b/i.test(String(plan.rawArgs?.[0] || ''));
      const successText = /successfully/i.test(combined);
      // Zero-count summaries are not errors: obsutil batch output routinely
      // prints "Failed count: 0" / "失败数量: 0" lines even on full success —
      // strip them before scanning for real error indicators.
      const summaryText = combined.replace(/(?:failed|失败)(?:\s*(?:count|数量)?\s*[:=]?\s*0)\b/gi, '');
      const errorIndicators = /error|failed|失败|invalid|not found|denied|拒绝/i.test(summaryText);
      finish({
        ok: code === 0 || (isObsCommand && successText && !errorIndicators),
        exitCode: code,
        signal,
        stdout: redactOutput(stdout),
        stderr: redactOutput(stderr),
        plan,
      });
    });
  });
}

function isRetryableNetworkError(result: HcloudRunResult): boolean {
  if (result.code === 'TIMEOUT') return false;
  const text = `${result.error || ''}\n${result.stdout || ''}\n${result.stderr || ''}`;
  return /\[NETWORK_ERROR\]|connection timed out|ECONNRESET|ETIMEDOUT|temporary failure|TLS handshake timeout/i.test(
    text,
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
