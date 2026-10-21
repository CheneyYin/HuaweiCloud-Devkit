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
// - `memory delete` prompts unless --force/-f (NOT --yes — a different flag).
// - `memory create --output json` is REQUIRED for the one-time api_key to be
//   printed at all (the table branch prints only Space ID/Status, losing the
//   key permanently — commands.py:121-131).
// - `gateway delete`/`delete-target` prompt with NO skip flag at all — the
//   wrapper hard-stops and points at the user terminal.
// - bare `agentarts config` is an interactive wizard — a subcommand is
//   required.
// - `--bearer-token`/`-bt` exists on 7 commands; argv is process-list
//   visible, so the wrapper rejects it outright (env-var auth only).
// Per-operation canonical flags: what to append when the caller omitted it,
// and how to detect an explicit occurrence (never double-append).
const CANONICAL_FLAGS = new Map([
  ['destroy', { append: ['--yes'], present: [/^(--yes|-y)$/] }],
  ['memory install', { append: ['--yes'], present: [/^(--yes|-y)$/] }],
  ['memory uninstall', { append: ['--yes'], present: [/^(--yes|-y)$/] }],
  ['memory delete', { append: ['--force'], present: [/^(--force|-f)$/] }],
  ['memory create', { append: ['--output', 'json'], present: [/^(--output|-o)(=|$)/] }],
]);
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
// the measured per-operation flag set where the caller omitted it. The
// approval token binds to THESE args, so what the user approves is what
// runs. memory create is special: `--output json` is the ONLY branch that
// prints the one-time api_key, so an explicit NON-json --output is a
// plan-level rejection (same posture as --bearer-token), not a rewrite —
// rewriting bound approval args is argv surgery the token hash cannot
// survive.
function canonicalizeArgs(rawArgs, classification) {
  const args = (Array.isArray(rawArgs) ? rawArgs : []).map(String);
  const rule = CANONICAL_FLAGS.get(classification.operation);
  if (!rule) return args;
  if (classification.operation === 'memory create') {
    const explicit = args.find((a) => rule.present[0].test(a));
    if (
      explicit !== undefined &&
      !/^(--output|-o)(=?)json$/i.test(explicit.replace(/\s+/g, '')) &&
      !/^(-o|--output)$/i.test(explicit)
    ) {
      return null;
    }
    if (explicit !== undefined) {
      // `--output json` / `-o json` present (value may be the next token) —
      // but a bare `-o`/`--output` with a non-json NEXT token also fails.
      const idx = args.indexOf(explicit);
      const inline = explicit.includes('=');
      if (!inline) {
        const value = args[idx + 1];
        if (value === undefined || !/^json$/i.test(value)) return null;
      }
    }
    if (explicit !== undefined) return args;
    return [...args, '--output', 'json'];
  }
  if (!args.some((a) => rule.present.some((re) => re.test(a)))) {
    return [...args, ...rule.append];
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
  if (canonicalArgs === null) {
    return {
      ok: false,
      service: 'AgentArts',
      executable,
      args: redactSecrets(providedArgs),
      error:
        'Rejected: memory create with a non-json --output permanently loses the one-time api_key (the table branch prints only Space ID/Status). Re-run with --output json (or omit it — the wrapper canonicalizes to json).',
    };
  }
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
    // Kept for custom policies: the stock policy no longer blocks any
    // command (PR11 unblocked memory create/update/delete).
    plan.executionBlock = `${classification.operation} is blocked by toolkit policy in this release — run it in your own terminal if needed.`;
    return plan;
  }

  if (classification.tier === 'approved' || classification.tier === 'unknown') {
    plan.approvalToken = agentartsApprovals.create(canonicalArgs);
    plan.approvalGuidance = `Cloud write${
      classification.labels.length ? ` (${classification.labels.join(', ')})` : ''
    }. Present the exact command to the user; on explicit approval, call huaweicloud_agentarts_run_approved_command with these args and the approvalToken. Otherwise the user runs it in their own terminal.`;
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
        error: `Failed to launch ${executable}: ${error.message}. Install the SDK: npx huaweicloud-devkit install-agentarts (or pip install agentarts-sdk==${pinnedSdkVersion() || 'the pinned version'} -i ${AGENTARTS_SDK_MIRROR}; AGENTARTS_BIN points at a non-PATH install).`,
      });
    });
    child.on('close', (code) => {
      // Exit code is deliberately ignored: 0.1.7 returns 0 on failure.
      const failed = detectFailure(stdout, stderr);
      const largeOutputFile = saveLargeOutput(stdout);
      // memory create: capture the ONE-TIME api_key from the RAW stdout —
      // BEFORE redactSecrets runs (the redacted payload would only ever
      // yield <redacted>). Written to a 0600 file under the devkit state
      // root; the payload carries only the path, never the key.
      const memoryApiKey = failed ? null : extractMemoryApiKey(stdout, classification.operation);
      if (memoryApiKey) {
        try {
          mkdirSync(dirname(memoryApiKey.file), { recursive: true });
          writeFileSync(memoryApiKey.file, `${memoryApiKey.apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
        } catch {
          // The create itself succeeded; a failed key capture must not flip
          // the outcome — surface it via the note below instead.
        }
      }
      // redactSecrets only masks `key[:=]value` SHAPES — a JSON body like
      // {"api_key": "K"} is a plain string to it and would leak the raw key
      // in stdout. A successful memory create carries exactly that shape, so
      // the captured key is scrubbed from the text explicitly before the
      // generic redaction pass.
      const payloadStdout =
        memoryApiKey && stdout.includes(memoryApiKey.apiKey)
          ? stdout.split(memoryApiKey.apiKey).join('<redacted>')
          : stdout;
      finish({
        ok: !failed,
        exitCode: code,
        stdout: redactSecrets(payloadStdout),
        stderr: redactSecrets(stderr),
        failureDetected: failed,
        durationMs: Date.now() - startedAt,
        ...(largeOutputFile ? { largeOutputFile } : {}),
        ...(memoryApiKey
          ? {
              spaceId: memoryApiKey.spaceId,
              memoryApiKeyFile: memoryApiKey.file,
              memoryApiKeyNote: `One-time data-plane API key saved (0600): ${memoryApiKey.file}. It is never printed — the user reads the file directly (data-plane env: HUAWEICLOUD_SDK_MEMORY_API_KEY).`,
            }
          : {}),
      });
    });
  });
}

// Extract the one-time memory api_key (+ space id) from a successful
// `memory create --output json` stdout. Dual-path defense: JSON.parse the
// trimmed output first (rich print_json should emit clean JSON), fall back
// to the same regex style the e2e uses for memory list (real output can
// carry log noise around the payload).
function extractMemoryApiKey(rawStdout, operation) {
  if (operation !== 'memory create') return null;
  const text = String(rawStdout || '');
  let apiKey = null;
  let spaceId = null;
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object') {
      apiKey = typeof parsed.api_key === 'string' ? parsed.api_key : null;
      spaceId = typeof parsed.id === 'string' ? parsed.id : null;
    }
  } catch {
    /* fall through to the regex path */
  }
  if (!apiKey) {
    const keyMatch = /"api_key"\s*:\s*"([^"]+)"/.exec(text);
    if (keyMatch) apiKey = keyMatch[1];
  }
  if (!spaceId) {
    const idMatch = /"id"\s*:\s*"([^"]+)"/.exec(text);
    if (idMatch) spaceId = idMatch[1];
  }
  if (!apiKey || !spaceId) return null;
  const stateRoot = process.env.HUAWEICLOUD_HOME || homedir();
  return {
    apiKey,
    spaceId,
    file: join(stateRoot, '.config', 'huaweicloud', `agentarts-memory-api-key-${spaceId}.txt`),
  };
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

// List agent runtimes: an SDK-only capability. The 0.1.7 CLI has NO list
// command (the 43 help fixtures prove it), so this runs an inline snippet
// through the python that owns the resolved agentarts CLI. Two contracts
// differ from the CLI runners, both deliberate:
// - Parameters travel as a SEPARATE argv element (sys.argv[1]) parsed with
//   json.loads — never woven into code. A JSON string is not a Python
//   literal (true/false/null), so weaving would silently corrupt any
//   future boolean/null parameter.
// - The snippet's exit codes are OURS and trustworthy (the CLI's exit-0
//   failure trap does not apply to code we control): 0 = success,
//   3 = agentarts module missing (advance to the next python candidate),
//   1 = failure. detectFailure still runs as the second defense layer.
const LIST_AGENTS_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk.service.runtime_client import RuntimeClient',
  '    from agentarts.sdk.utils.constant import get_control_plane_endpoint',
  '    params = json.loads(sys.argv[1])',
  '    client = RuntimeClient(control_endpoint=get_control_plane_endpoint(params.get("region")))',
  '    kwargs = {}',
  '    if params.get("agent_name"):',
  '        kwargs["agent_name"] = params["agent_name"]',
  '    if params.get("limit") is not None:',
  '        kwargs["limit"] = params["limit"]',
  '    if params.get("offset") is not None:',
  '        kwargs["offset"] = params["offset"]',
  '    agents = client.get_agents(**kwargs)',
  '    print(json.dumps(agents, ensure_ascii=False))',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'except Exception as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Python candidates for the snippet: the sibling python of a path-resolved
// CLI first (the devkit venv's or AGENTARTS_BIN's own interpreter — the
// one that certainly has the SDK when the CLI resolved from there), then
// the PATH fallbacks. A bare PATH-resolved CLI has no sibling; an activated
// venv's bin dir is already on PATH, so python3 resolves to it there.
export function pythonCandidatesForAgentarts() {
  const resolved = resolveAgentartsCommand();
  const candidates = [];
  if (resolved.includes('/') || resolved.includes('\\')) {
    candidates.push(join(dirname(resolved), process.platform === 'win32' ? 'python.exe' : 'python'));
  }
  candidates.push(process.platform === 'win32' ? 'python' : 'python3');
  if (process.platform !== 'win32') candidates.push('python');
  return [...new Set(candidates)];
}

function runPythonSnippet(candidate, args, childEnv, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(candidate, args, {
      shell: false,
      windowsHide: true,
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
      finish({ exitCode: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish({ exitCode: null, stdout, stderr, spawnError: error }));
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr }));
  });
}

// Read-only agent listing through the SDK API. Env-or-fail, allowlist child
// env, redaction, and the readonly timeout are the same contracts as the
// CLI readonly runner; only the executable (python, not the CLI) and the
// exit-code contract (ours, see LIST_AGENTS_SNIPPET) differ.
export async function listAgentartsAgents(params = {}, options = {}) {
  if (options.injectCredentials !== false && !hasInjectableCredentials()) {
    return missingCredentialError();
  }
  // The request carries ONLY what the caller passed (plus region, which the
  // wrapper must supply: the SDK's region env chain is not in the allowlist
  // child env). Omitted pagination keys keep the SDK defaults as the single
  // source of truth — the server-side base is unmeasured, so guessing one
  // here would weld the guess into every call.
  const request = { region: params.region || 'cn-southwest-2' };
  if (params.agent_name) request.agent_name = String(params.agent_name);
  if (params.limit !== undefined && params.limit !== null) request.limit = Number(params.limit);
  if (params.offset !== undefined && params.offset !== null) request.offset = Number(params.offset);
  const jsonArg = JSON.stringify(request);

  const childEnv = buildChildEnv(options);
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', LIST_AGENTS_SNIPPET, jsonArg];
  const runCandidate = options.runCandidate || ((candidate) => runPythonSnippet(candidate, args, childEnv, timeoutMs));

  for (const candidate of pythonCandidatesForAgentarts()) {
    const result = await runCandidate(candidate, args);
    const moduleMissing =
      result.exitCode === 3 || /ModuleNotFoundError|AGENTARTS_SDK_MISSING/.test(result.stderr || '');
    // Only "this python cannot run the SDK" advances the chain. A candidate
    // that found the SDK and failed (auth, network, API error) is FINAL —
    // retrying on a different interpreter would only mask the real error.
    if (result.spawnError || moduleMissing) continue;
    const failed = result.timedOut || result.exitCode !== 0 || detectFailure(result.stdout || '', result.stderr || '');
    let agents = null;
    if (!failed) {
      try {
        const parsed = JSON.parse(result.stdout);
        agents = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : null;
      } catch {
        agents = null;
      }
    }
    return {
      ok: !failed,
      service: 'AgentArts',
      operation: 'list-agents (SDK API; no CLI command in 0.1.7)',
      executable: candidate,
      exitCode: result.exitCode,
      failureDetected: failed,
      agents,
      count: Array.isArray(agents) ? agents.length : null,
      stdout: redactSecrets(result.stdout || ''),
      stderr: redactSecrets(result.stderr || ''),
      ...(result.timedOut ? { timedOut: true, error: `agentarts list timed out after ${timeoutMs} ms.` } : {}),
    };
  }
  return {
    ok: false,
    error: `No python candidate could import agentarts (tried: ${pythonCandidatesForAgentarts().join(', ')}). Install the SDK: npx huaweicloud-devkit install-agentarts (or pip install agentarts-sdk==${pinnedSdkVersion() || 'the pinned version'} -i ${AGENTARTS_SDK_MIRROR}).`,
  };
}

// Tool surface: definitions and handlers exported so tools.mjs stays a thin
// registration site (the definitions spread into TOOL_DEFINITIONS, the
// dispatch delegates here).
export const AGENTARTS_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_plan_cli_command',
    description:
      'Classify and plan an agentarts CLI command (agentarts-sdk, Huawei Cloud AgentArts) without executing it. Returns the tier (local/readonly/approved/blocked), canonical args (per-operation non-interactive flags included: destroy/memory install/uninstall append --yes, memory delete appends --force, memory create canonicalizes to --output json so its one-time api_key is printed), warnings, and an approvalToken for approved-tier cloud writes. memory create with an explicit non-json --output is rejected at plan (the key would be permanently lost).',
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
      'Run an approved-tier agentarts command only after the exact command has been shown and explicitly approved by the user. stdin is never written; interactive-only commands (gateway delete) are hard-stopped. memory create: the one-time data-plane api_key is captured from the raw output to a 0600 file under the devkit state root — the returned payload stays redacted and carries memoryApiKeyFile (the path, never the key).',
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
  {
    name: 'huaweicloud_agentarts_list_agents',
    description:
      'List AgentArts agent runtimes (read-only, no approval needed) via the pinned agentarts-sdk Python API — agentarts 0.1.7 has NO list CLI command, so this is the only in-toolkit path (degraded path: the console). Returns agents[] parsed from the SDK response. Params: region (default cn-southwest-2, the only control-plane region), agent_name (fuzzy filter), limit/offset (pagination — omit to keep the SDK defaults, the single source of truth).',
    inputSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'string',
          description: 'Control-plane region. Defaults to cn-southwest-2 (the only control-plane region).',
        },
        agent_name: { type: 'string', description: 'Fuzzy agent-name filter (SDK get_agents agent_name).' },
        limit: { type: 'number', description: 'Page size. Omit to use the SDK default.' },
        offset: { type: 'number', description: 'Pagination offset. Omit to use the SDK default.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds. Defaults to 60000.' },
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
    case 'huaweicloud_agentarts_list_agents':
      return listAgentartsAgents(rawArgs, { timeoutMs: rawArgs.timeoutMs });
    default:
      throw new Error(`Unknown agentarts tool: ${name}`);
  }
}
