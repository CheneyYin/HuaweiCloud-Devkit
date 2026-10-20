import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets, resolveAgentartsTier } from './safety-policy.mjs';
import { getProxySettings } from './proxy/proxy-config.mjs';
import { resolveCredentialsWithRuntime } from './auth/credentials.mjs';
import { createApprovalTokenStore } from './approval-tokens.mjs';

// agentarts (agentarts-sdk) approval wrapper. The command classification
// (tiers, labels, aliases) is the shared policy.json agentartsCommandPolicy
// consumed by both hook layers; this wrapper is the third consumer, so
// wrapper/hook/Python tiers can never drift. Measured facts behind the
// classification and the traps handled here are recorded in
// docs/agentarts-pr0-findings.md (agentarts-sdk 0.1.7).

const __dirname = dirname(fileURLToPath(import.meta.url));

const READONLY_TIMEOUT_MS = 60_000;
// Measured per-operation approved-tier defaults (PR0 D11 + the e2e run):
// launch's docker build dominates (~2-3 min), destroy is a control-plane
// delete (~10s but leave headroom), the invoke family carries the CLI's own
// 900s request timeout, everything else is quick control-plane I/O.
const OPERATION_TIMEOUT_MS = {
  launch: 600_000,
  destroy: 300_000,
  invoke: 900_000,
  'runtime invoke': 900_000,
  'runtime upload-files': 900_000,
  'runtime download-files': 900_000,
};
const DEFAULT_APPROVED_TIMEOUT_MS = 120_000;
const LARGE_OUTPUT_THRESHOLD = 50_000;
const OUTPUT_DIR = join('/tmp', 'huaweicloud-devkit');

// The pinned agentarts-sdk version. Primary source: safety/policy.json
// (agentartsSdkVersion) — that file ships with src/ in EVERY install layout
// (repo, npm dependency, and the per-agent copies setup makes). Fallback:
// the repo/package.json field. Never throws: an unresolvable pin degrades to
// null (doctor warns, wrapper hints say "the pinned version").
export function pinnedSdkVersion() {
  try {
    const policy = JSON.parse(readFileSync(join(__dirname, '..', 'safety', 'policy.json'), 'utf8'));
    if (typeof policy.agentartsSdkVersion === 'string' && policy.agentartsSdkVersion) {
      return policy.agentartsSdkVersion;
    }
  } catch {
    /* fall through to the package.json candidate */
  }
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    return typeof pkg.agentartsSdkVersion === 'string' ? pkg.agentartsSdkVersion : null;
  } catch {
    return null;
  }
}

// The Huawei Cloud PyPI mirror behind every taught install command and the
// devkit-managed install (agentarts-sdk ships on PyPI; the mirror is the
// restricted-network-friendly default, same posture as the README's npm
// mirror guidance, with the same lag caveat: fall back to official PyPI
// when the mirror lacks a newly pinned version). Single canonical literal —
// validate-package.mjs pins the skills' `-i <url>` literals against it.
export const AGENTARTS_SDK_MIRROR = 'https://mirrors.huaweicloud.com/repository/pypi/simple';

// The devkit-managed venv (provisioned by `npx huaweicloud-devkit
// install-agentarts`). Lives under the devkit state root, NOT ~/.huaweicloud
// — that directory is the hooks' credentialFilePatterns namespace.
export function agentartsVenvDir() {
  return join(process.env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud', 'agentarts-venv');
}

export function agentartsVenvBin() {
  return join(
    agentartsVenvDir(),
    process.platform === 'win32' ? join('Scripts', 'agentarts.exe') : join('bin', 'agentarts'),
  );
}

const agentartsApprovals = createApprovalTokenStore('agentarts');

// Measured non-interactive requirements (PR0 fixtures):
// - `destroy` prompts Confirm.ask unless --yes/-y.
// - `memory install/uninstall` prompt for platform selection when target is
//   omitted and for confirmation unless --yes; target must be explicit.
// - `gateway delete`/`delete-target` prompt with NO skip flag at all — the
//   wrapper hard-stops and points at the user terminal.
// - bare `agentarts config` is an interactive wizard — a subcommand is
//   required.
// - `--bearer-token`/`-bt` exists on 7 commands; argv is process-list
//   visible, so the wrapper rejects it outright (env-var auth only).
const NON_INTERACTIVE_GROUPS = new Set(['destroy', 'memory install', 'memory uninstall']);
const INTERACTIVE_BLOCKED_SUBCOMMANDS = new Set(['gateway delete', 'gateway delete-target']);
const MEMORY_INSTALL_TARGETS = new Set(['hermes', 'claude', 'codex', 'opencode', 'openclaw']);

// A positional value whose PRECEDING token names a secret (config set-env
// HUAWEICLOUD_SDK_AK <value>) must be scrubbed in every display/storage
// surface — redactSecrets only covers key[:=]value shapes. Mirrors the
// hcloud wrapper's redactArgsWithObs technique.
const SECRET_KEY_NAME_RE = /(?:api[_-]?key|access[_-]?key|secret[_-]?key|token|credential|password|passwd|ak|sk)$/i;

function scrubPositionalSecrets(args) {
  const scrubbed = [...args];
  for (let i = 1; i < scrubbed.length; i += 1) {
    const prev = String(scrubbed[i - 1]);
    const flagMatch = prev.match(/^--?([A-Za-z0-9_.-]+)(?:=(.*))?$/);
    const name = flagMatch ? flagMatch[1] : prev;
    if (SECRET_KEY_NAME_RE.test(name) && scrubbed[i] !== '<redacted>') {
      scrubbed[i] = '<redacted>';
    }
  }
  return scrubbed;
}

// CLI resolution priority: AGENTARTS_BIN env > the devkit-managed venv >
// PATH 'agentarts'. The env override stays the escape hatch (e2e scratch
// venvs, user-managed installs); the venv probe makes the devkit-managed
// pinned install shadow an arbitrary PATH version (the doctor compares
// against the same pin). The probe tests the CLI BINARY, not the venv
// directory — a half-built venv never shadows PATH.
export function resolveAgentartsCommand() {
  const explicit = process.env.AGENTARTS_BIN;
  if (explicit) {
    return process.platform === 'win32' && !explicit.toLowerCase().endsWith('.exe') ? `${explicit}.exe` : explicit;
  }
  const venvBin = agentartsVenvBin();
  if (existsSync(venvBin)) return venvBin;
  return process.platform === 'win32' ? 'agentarts.exe' : 'agentarts';
}

// Classification is delegated to resolveAgentartsTier (safety-policy.mjs) —
// the SAME function the hook decision path consumes, so wrapper tiers and
// hook denials can never drift. Aliases (deploy→launch, configure→config)
// are applied inside it; unknown groups/subcommands keep the policy
// defaultTier (fail-safe).
const classifyAgentartsInvocation = resolveAgentartsTier;

// Canonicalize args into the exact form the wrapper would execute: append
// the measured non-interactive flag where one exists and is safe (--yes for
// destroy). The approval token binds to THESE args, so what the user approves
// is what runs.
function canonicalizeArgs(rawArgs, classification) {
  const args = (Array.isArray(rawArgs) ? rawArgs : []).map(String);
  if (NON_INTERACTIVE_GROUPS.has(classification.operation) && !args.some((a) => /^(--yes|-y)$/.test(a))) {
    return [...args, '--yes'];
  }
  return args;
}

function argvContainsBearerToken(args) {
  return args.some((arg) => /^--bearer-token(=|$)/i.test(arg) || /^-bt$/i.test(arg));
}

function planningGuidance(classification, canonicalArgs) {
  const notes = [];
  if (classification.unregistered) {
    notes.push(
      `agentarts ${classification.operation || '(unknown)'} is not in the measured command registry (agentarts-sdk 0.1.7); classified fail-safe as cloud-write. Run \`agentarts ${classification.operation} --help\` first to verify the command shape.`,
    );
  }
  if (classification.operation === 'config' || classification.group === 'config') {
    notes.push('Bare `agentarts config` is an interactive wizard; a subcommand (set, get, list, …) is required.');
  }
  if (INTERACTIVE_BLOCKED_SUBCOMMANDS.has(classification.operation)) {
    notes.push(
      `agentarts ${classification.operation} prompts for confirmation with NO non-interactive flag; the wrapper cannot run it safely — execute it in your own terminal.`,
    );
  }
  if (
    (classification.operation === 'memory install' || classification.operation === 'memory uninstall') &&
    canonicalArgs.length > 0
  ) {
    const sub = canonicalArgs.find((a) => MEMORY_INSTALL_TARGETS.has(a.toLowerCase()));
    if (!sub) {
      notes.push(
        'memory install/uninstall requires an explicit target platform (hermes, claude, codex, opencode, openclaw) — omitting it starts an interactive selection.',
      );
    }
    if (!canonicalArgs.some((a) => /^(--yes|-y)$/.test(a))) {
      notes.push('memory install/uninstall requires --yes to skip its confirmation prompts.');
    }
  }
  return notes;
}

export function planAgentartsCommand(rawArgs, options = {}) {
  const providedArgs = (Array.isArray(rawArgs) ? rawArgs : []).map(String);
  if (argvContainsBearerToken(providedArgs)) {
    return {
      ok: false,
      service: 'AgentArts',
      executable: resolveAgentartsCommand(),
      args: redactSecrets(providedArgs),
      error:
        'Rejected: --bearer-token/-bt places the token in the process list. Authenticate via HUAWEICLOUD_SDK_AK/SK environment injection instead (see the huawei-agentarts skill).',
    };
  }

  const classification = classifyAgentartsInvocation(providedArgs, options);
  const executable = resolveAgentartsCommand();
  const blocked = INTERACTIVE_BLOCKED_SUBCOMMANDS.has(classification.operation);
  const bareConfig = classification.group === 'config' && !classification.subcommand;
  const missingTarget =
    (classification.operation === 'memory install' || classification.operation === 'memory uninstall') &&
    !providedArgs.some((a) => MEMORY_INSTALL_TARGETS.has(String(a).toLowerCase()));
  const hardStop = blocked || bareConfig || missingTarget;

  const canonicalArgs = hardStop ? providedArgs : canonicalizeArgs(providedArgs, classification);
  const notes = planningGuidance(classification, canonicalArgs);
  // Display/storage surfaces are POSITIONAL-SCRUBBED on top of redactSecrets:
  // `config set-env HUAWEICLOUD_SDK_AK <value>` must not carry the raw value
  // into the transcript or approvals.json. The approval token binds to the
  // REAL canonical args; re-supply the real values at run time (replace
  // <redacted> placeholders).
  const displayArgs = scrubPositionalSecrets(redactSecrets(canonicalArgs));
  const command = [executable, ...displayArgs].map((arg) => quoteShellArg(arg)).join(' ');

  const plan = {
    ok: true,
    service: 'AgentArts',
    executable,
    args: displayArgs,
    command,
    executableBlock: command,
    tier: classification.tier,
    labels: classification.labels,
    operation: classification.operation,
    warnings: notes,
    // Exit codes cannot be trusted (0.1.7 fails with exit 0); the run layer
    // parses output for failure signatures instead.
    safeToRun: classification.tier === 'readonly',
  };

  if (hardStop) {
    plan.safeToRun = false;
    plan.hardStop = true;
    plan.executionBlock = `${classification.operation} cannot run through the wrapper (${
      blocked
        ? 'interactive confirm with no skip flag'
        : bareConfig
          ? 'interactive wizard'
          : 'interactive target-platform selection'
    }) — run it in your own terminal.`;
    return plan;
  }

  if (classification.tier === 'local') {
    plan.executionBlock =
      'Local-tier command: run via Bash directly (hook-covered). No approval needed; `agentarts dev` is a long-running server the agent manages (background start, poll ping, kill).';
    return plan;
  }

  if (classification.tier === 'blocked') {
    plan.executionBlock =
      'Memory-space create/update/delete are deferred to the next toolkit release (the memory scenario ships later); run them in your own terminal if needed.';
    return plan;
  }

  if (classification.tier === 'approved' || classification.tier === 'unknown') {
    plan.approvalToken = agentartsApprovals.create(canonicalArgs);
    plan.approvalGuidance = `Cloud write (${classification.labels.join(', ') || 'billing'}). Present the exact command to the user; on explicit approval, call huaweicloud_agentarts_run_approved_command with these args and the approvalToken. Otherwise the user runs it in their own terminal.`;
  }
  return plan;
}

// Allowlist-style child environment: NEVER spread process.env (ambient
// variables, including stray credentials, must not leak into the child), and
// inject HUAWEICLOUD_SDK_AK/SK from the devkit runtime credential state —
// injection replaces, not adds. TLS trust anchors ride along with the proxy
// vars (a MITM proxy without its CA bundle turns into confusing TLS errors).
function buildChildEnv(options = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE,
  };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot;
    env.COMSPEC = process.env.COMSPEC;
  }
  const proxy = getProxySettings();
  if (proxy?.https_proxy) env.HTTPS_PROXY = proxy.https_proxy;
  if (proxy?.http_proxy) env.HTTP_PROXY = proxy.http_proxy;
  if (proxy?.no_proxy) env.NO_PROXY = proxy.no_proxy;

  if (options.injectCredentials !== false) {
    let creds;
    try {
      creds = resolveCredentialsWithRuntime({ allowMissing: true });
    } catch {
      creds = null;
    }
    if (creds?.ak && creds?.sk) {
      env.HUAWEICLOUD_SDK_AK = creds.ak;
      env.HUAWEICLOUD_SDK_SK = creds.sk;
    } else {
      // The measured auth chain is env → ~/.huaweicloud/credentials profile
      // → metadata: without injected env vars the CLI silently authenticates
      // from an unmanaged profile file (possibly a different account). The
      // wrapper contract is env-or-fail — never an accidental profile hit.
      env.HUAWEICLOUD_SDK_CREDENTIALS_FILE = '/dev/null';
    }
  }
  // Drop empty entries so spawn does not pass empty-string variables.
  for (const key of Object.keys(env)) {
    if (env[key] === undefined || env[key] === '') delete env[key];
  }
  return env;
}
// The CLI returns exit code 0 even on failure (measured: full traceback,
// exit 0) — success must be decided from the output. Signatures measured
// against 0.1.7: rich ERROR log lines, Python tracebacks, "Failed to …"
// operation errors, EOF-aborted prompts ("Aborted."), the "× ERROR:" echo
// the CLI prints for operation errors (no data-plane endpoint, auth
// failure), and the deploy stage's "Error building image:" (docker build
// failure surfaced through the CLI).
const FAILURE_SIGNATURE_RE =
  /Traceback \(most recent call last\)| - ERROR - |^Failed to |^Aborted\.$|^× ERROR:|^Error building image:/m;

function detectFailure(stdout, stderr) {
  return FAILURE_SIGNATURE_RE.test(`${stdout}\n${stderr}`);
}

function saveLargeOutput(rawStdout) {
  if (rawStdout.length <= LARGE_OUTPUT_THRESHOLD) return null;
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const filePath = join(OUTPUT_DIR, `agentarts-output-${Date.now()}.json`);
    // Redact BEFORE writing and keep the file private (0600).
    writeFileSync(filePath, redactSecrets(rawStdout), { encoding: 'utf8', mode: 0o600 });
    return filePath;
  } catch {
    return null;
  }
}

function defaultTimeoutMs(classification) {
  return OPERATION_TIMEOUT_MS[classification.operation] ?? DEFAULT_APPROVED_TIMEOUT_MS;
}

function quoteShellArg(arg) {
  const s = String(arg);
  return /^[\w./=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

async function runAgentarts(canonicalArgs, classification, options = {}) {
  const executable = resolveAgentartsCommand();
  const timeoutMs =
    options.timeoutMs ?? (classification.tier === 'readonly' ? READONLY_TIMEOUT_MS : defaultTimeoutMs(classification));
  const childEnv = buildChildEnv(options);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    // stdin is IGNORED, never piped and never written: interactive prompts
    // get EOF and abort (measured) instead of hanging until timeout, and no
    // caller-supplied stdin can ever reach the child.
    const child = spawn(executable, canonicalArgs, {
      shell: false,
      windowsHide: true,
      cwd: options.cwd || undefined,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        error: `agentarts command timed out after ${timeoutMs} ms.`,
        timedOut: true,
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({
        ok: false,
        error: `Failed to launch ${executable}: ${error.message}. Is agentarts-sdk installed (pip install agentarts-sdk==${pinnedSdkVersion() || 'the pinned version'} -i ${AGENTARTS_SDK_MIRROR}; AGENTARTS_BIN points at a non-PATH install)?`,
      });
    });
    child.on('close', (code) => {
      // Exit code is deliberately ignored: 0.1.7 returns 0 on failure.
      const failed = detectFailure(stdout, stderr);
      const largeOutputFile = saveLargeOutput(stdout);
      finish({
        ok: !failed,
        exitCode: code,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        failureDetected: failed,
        durationMs: Date.now() - startedAt,
        ...(largeOutputFile ? { largeOutputFile } : {}),
      });
    });
  });
}

// The env-or-fail credential contract: without devkit credentials the CLI
// would silently authenticate from ~/.huaweicloud/credentials (measured auth
// chain) — possibly a different account. Reject with a clear pointer
// instead of an accidental profile hit or a raw auth traceback.
function missingCredentialError() {
  return {
    ok: false,
    error:
      'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files.',
  };
}

function hasInjectableCredentials() {
  try {
    const creds = resolveCredentialsWithRuntime({ allowMissing: true });
    return Boolean(creds?.ak && creds?.sk);
  } catch {
    return false;
  }
}

export async function runAgentartsReadonlyCommand(rawArgs, options = {}) {
  const providedArgs = (Array.isArray(rawArgs) ? rawArgs : []).map(String);
  if (argvContainsBearerToken(providedArgs)) {
    return { ok: false, error: 'Rejected: --bearer-token/-bt is argv-visible; use env-var auth.' };
  }
  const classification = classifyAgentartsInvocation(providedArgs, options);
  if (classification.tier !== 'readonly') {
    return {
      ok: false,
      error: `Not a read-only agentarts command (tier: ${classification.tier}). ${
        classification.tier === 'approved'
          ? 'Use huaweicloud_agentarts_run_approved_command with an approval token.'
          : classification.tier === 'local'
            ? 'Local-tier commands run via Bash directly.'
            : 'This command is not available through the wrapper in this release.'
      }`,
    };
  }
  if (options.injectCredentials !== false && !hasInjectableCredentials()) {
    return missingCredentialError();
  }
  const result = await runAgentarts(providedArgs, classification, options);
  return { service: 'AgentArts', operation: classification.operation, tier: 'readonly', ...result };
}

export async function runAgentartsApprovedCommand(args = {}) {
  if (args.approvedByUser !== true) {
    throw new Error('approvedByUser must be true after explicit user approval for this exact command.');
  }
  const token = String(args.approvalToken || '');

  // Same precise JSON contract as the hcloud trio (#745).
  const inspection = agentartsApprovals.inspect(token);
  if (inspection.state === 'already_consumed') {
    return { status: 'ok', outcome: 'already_processed' };
  }
  if (inspection.state === 'expired') {
    return { status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED' };
  }
  if (inspection.state === 'not_found') {
    return { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' };
  }

  const stored = agentartsApprovals.consume(token);
  if (!stored) {
    const recheck = agentartsApprovals.inspect(token);
    if (recheck.state === 'expired') return { status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED' };
    if (recheck.state === 'already_consumed') return { status: 'ok', outcome: 'already_processed' };
    return { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' };
  }

  const providedArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (agentartsApprovals.hashArgs(providedArgs) !== stored.argsHash) {
    const redactedStored = JSON.stringify(stored.argsRedacted);
    const redactedProvided = JSON.stringify(redactSecrets(providedArgs));
    if (redactedStored !== redactedProvided) {
      throw new Error(
        'Provided args do not match the approved plan. Use the args you planned; if the plan shows <redacted> placeholders for secrets, replace them with the actual values (the plan already carries the non-interactive flags the wrapper will execute).',
      );
    }
  }

  const plan = planAgentartsCommand(providedArgs);
  if (!plan.ok || plan.hardStop || plan.tier !== 'approved') {
    return {
      status: 'rejected',
      code: 'PLAN_NO_LONGER_EXECUTABLE',
      detail: plan.executionBlock || plan.error || `tier changed to ${plan.tier}`,
    };
  }

  const credentialError = missingCredentialError();
  if (hasInjectableCredentials() === false) {
    return { status: 'rejected', code: 'NO_DEVKIT_CREDENTIALS', detail: credentialError.error };
  }

  const result = await runAgentarts(providedArgs, plan, {
    timeoutMs: args.timeoutMs,
    cwd: args.cwd,
  });
  return {
    status: 'ok',
    approved: true,
    operation: plan.operation,
    ...result,
  };
}

// Tool surface: definitions and handlers exported so tools.mjs stays a thin
// registration site (the definitions spread into TOOL_DEFINITIONS, the
// dispatch delegates here).
export const AGENTARTS_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_plan_cli_command',
    description:
      'Classify and plan an agentarts CLI command (agentarts-sdk, Huawei Cloud AgentArts) without executing it. Returns the tier (local/readonly/approved/blocked), canonical args (non-interactive flags included), warnings, and an approvalToken for approved-tier cloud writes.',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'agentarts arguments, excluding the agentarts executable (e.g. ["memory","list","--region","cn-southwest-2"]).',
        },
      },
    },
  },
  {
    name: 'huaweicloud_agentarts_run_readonly_command',
    description:
      'Run a read-only agentarts command (memory list/get/status, gateway get/list/get-target/list-targets) with runtime credential injection and output redaction. Exit codes are unreliable in agentarts 0.1.7 — success is decided from parsed output.',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds. Defaults to 60000.' },
        cwd: {
          type: 'string',
          description: 'Optional working directory (config-family commands resolve .agentarts_config.yaml from cwd).',
        },
      },
    },
  },
  {
    name: 'huaweicloud_agentarts_run_approved_command',
    description:
      'Run an approved-tier agentarts command only after the exact command has been shown and explicitly approved by the user. stdin is never written; interactive-only commands (gateway delete) are hard-stopped.',
    inputSchema: {
      type: 'object',
      required: ['args', 'approvalToken', 'approvedByUser'],
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'The exact args from the plan (including the non-interactive flags the plan added).',
        },
        approvalToken: {
          type: 'string',
          description: 'The approvalToken returned by huaweicloud_agentarts_plan_cli_command.',
        },
        approvedByUser: {
          type: 'boolean',
          description: 'Must be true only after the user explicitly approves this exact command.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Optional timeout in milliseconds. Defaults: 600000 for launch (docker build), 300000 for destroy, 900000 for the invoke family, 120000 otherwise.',
        },
        cwd: { type: 'string', description: 'Optional working directory.' },
      },
    },
  },
];

export async function callAgentartsTool(name, rawArgs = {}) {
  switch (name) {
    case 'huaweicloud_agentarts_plan_cli_command':
      return planAgentartsCommand(rawArgs.args || []);
    case 'huaweicloud_agentarts_run_readonly_command':
      return runAgentartsReadonlyCommand(rawArgs.args || [], {
        timeoutMs: rawArgs.timeoutMs,
        cwd: rawArgs.cwd,
      });
    case 'huaweicloud_agentarts_run_approved_command':
      return runAgentartsApprovedCommand(rawArgs);
    default:
      throw new Error(`Unknown agentarts tool: ${name}`);
  }
}
