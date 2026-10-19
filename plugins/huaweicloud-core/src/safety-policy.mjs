import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateCommandRisk, mergeRiskDecision } from './risk-rule-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const policyPath = join(__dirname, '..', 'safety', 'policy.json');

export function loadPolicy() {
  return JSON.parse(readFileSync(policyPath, 'utf8'));
}

const DEFAULT_POLICY = loadPolicy();

function regexFrom(pattern) {
  return new RegExp(pattern, 'i');
}

function isSecretKeyName(key, policy = DEFAULT_POLICY) {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (
    /access.*key|secret.*key|security.*token|xauth.*token|authorization|password|passwd|adminpass|credential|private.*key|userdata|metadata/.test(
      normalized,
    )
  ) {
    return true;
  }
  return policy.secretKeyNamePatterns.some((pattern) => regexFrom(`^(${pattern})$`).test(key));
}

function redactString(text) {
  return (
    String(text)
      // Opaque blob keys (cloud-init user_data, metadata, private_key) carry
      // base64/scripts that may embed SSH keys, DB passwords, bootstrap tokens.
      // Redact the ENTIRE value of this arg — not just the first whitespace token.
      .replace(/((?:user[_-]?data|metadata|private[_-]?key)\s*[:=]\s*).*/gi, '$1<redacted>')
      .replace(
        /((?:access[_-]?key|secret[_-]?key|security[_-]?token|x[_-]?auth[_-]?token|token|authorization|password|passwd|admin[_-]?pass|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
        '$1<redacted>',
      )
      .replace(/(AK|SK)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g, '$1=<redacted>')
  );
}

export function redactSecrets(value, policy = DEFAULT_POLICY) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, policy));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        isSecretKeyName(key, policy) ? '<redacted>' : redactSecrets(val, policy),
      ]),
    );
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  return value;
}

function stripExecutable(args) {
  if (!args.length) return [];
  let current = args;
  // Unwrap shell wrappers (bash -c / sh -c 'hcloud ...', sudo hcloud ...,
  // cmd /c "hcloud ...", powershell -Command "hcloud ...") so wrapped write
  // commands keep their deny classification (#650 D4-16, #731 / #760).
  for (let depth = 0; depth < 5; depth++) {
    const first = String(current[0]).toLowerCase();
    const isShell = [
      'bash',
      'sh',
      'zsh',
      'dash',
      'bash.exe',
      'sh.exe',
      '/bin/bash',
      '/bin/sh',
      '/bin/zsh',
      '/bin/dash',
    ].includes(first);
    if (isShell && String(current[1]).toLowerCase() === '-c' && current[2]) {
      current = splitSimpleCommand(current[2]);
      continue;
    }
    // Windows: cmd /c "…" / cmd /k "…" / cmd.exe /c "…"
    if (first === 'cmd' || first === 'cmd.exe') {
      const flag = String(current[1] || '').toLowerCase();
      if ((flag === '/c' || flag === '/k') && current[2]) {
        current = splitSimpleCommand(current[2]);
        continue;
      }
    }
    // Windows: powershell -Command "…" / powershell -c "…" / pwsh -Command "…"
    if (first === 'powershell' || first === 'powershell.exe' || first === 'pwsh' || first === 'pwsh.exe') {
      const flag = String(current[1] || '').toLowerCase();
      if ((flag === '-command' || flag === '-c') && current[2]) {
        current = splitSimpleCommand(current[2]);
        continue;
      }
    }
    if (first === 'sudo' && current.length > 1) {
      current = current.slice(1);
      continue;
    }
    break;
  }
  const first = String(current[0]).toLowerCase();
  if (first === 'hcloud' || first.endsWith('/hcloud') || first.endsWith('\\hcloud') || first === 'hcloud.exe') {
    return current.slice(1);
  }
  return current;
}

function commandOperation(args) {
  const stripped = stripExecutable(args).map(String).filter(Boolean);
  if (stripped[0]?.toLowerCase() === 'configure') {
    return { service: 'configure', operation: stripped[1] || '', args: stripped };
  }
  const nonFlags = stripped.filter((arg) => !arg.startsWith('-'));
  return {
    service: nonFlags[0] || '',
    operation: nonFlags[1] || nonFlags[0] || '',
    args: stripped,
  };
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => regexFrom(pattern).test(value));
}

function hasWritePrefix(operation, policy) {
  const normalized = String(operation);
  return policy.writeOperationPrefixes.some((prefix) => new RegExp(`(^|[A-Za-z0-9])${prefix}`, 'i').test(normalized));
}

function hasReadPrefix(operation, policy) {
  return policy.readOperationPrefixes.some((prefix) => new RegExp(`^${prefix}`, 'i').test(operation));
}

function isLocalMetadataCommand(args) {
  return args.some((arg) => /^(--help|-h|help|version|--version)$/i.test(String(arg)));
}

function commandRiskText(normalizedArgs, options = {}) {
  return options.rawCommand || ['hcloud', ...normalizedArgs].join(' ');
}

function applyCommandRiskRules(base, normalizedArgs, options = {}) {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(commandRiskText(normalizedArgs, options));
  return mergeRiskDecision(base, risk);
}

function applyRawCommandRiskRules(base, command, options = {}) {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(command);
  return mergeRiskDecision(base, risk);
}

// Find hcloud command segments split by shell operators (; && || |) so a write
// command in the middle of a concatenated string keeps its deny classification
// (#650 review edge 1).
function findHcloudCommandSegments(text) {
  return String(text)
    .split(/(?:\|\||&&|;|\|)/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => splitSimpleCommand(segment))
    .filter((tokens) => {
      const first = String(tokens[0] || '').toLowerCase();
      return first === 'hcloud' || first.endsWith('/hcloud') || first.endsWith('\\hcloud') || first === 'hcloud.exe';
    });
}

export function classifyHcloudArgs(args, options = {}) {
  const policy = options.policy || DEFAULT_POLICY;
  // Second pass for shell-wrapped input (#650 D4-16 review edge 1): when the
  // leading command is not hcloud but a concatenated segment contains one,
  // classify every hcloud segment and merge to the most severe decision.
  const unwrappedTokens = stripExecutable(Array.isArray(args) ? args.map(String) : []);
  const unwrappedFirst = String(unwrappedTokens[0] || '').toLowerCase();
  const unwrappedIsHcloud =
    unwrappedFirst === 'hcloud' ||
    unwrappedFirst.endsWith('/hcloud') ||
    unwrappedFirst.endsWith('\\hcloud') ||
    unwrappedFirst === 'hcloud.exe';
  if (!unwrappedIsHcloud && !options._segmentDepth) {
    const hcloudSegments = findHcloudCommandSegments(unwrappedTokens.join(' '));
    if (hcloudSegments.length > 0) {
      const results = hcloudSegments.map((segment) => classifyHcloudArgs(segment, { ...options, _segmentDepth: 1 }));
      return (
        results.find((result) => result.decision === 'deny') ||
        results.find((result) => ['write', 'execution', 'secret', 'credential'].includes(result.risk)) ||
        results[0]
      );
    }
  }
  const { service, operation, args: normalizedArgs } = commandOperation(args);
  const joined = normalizedArgs.join(' ');

  if (!normalizedArgs.length) {
    return {
      decision: 'deny',
      risk: 'invalid',
      reason: 'Empty hcloud command arguments are not executable.',
    };
  }

  if (isLocalMetadataCommand(normalizedArgs)) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'local_metadata',
        reason: 'KooCLI local help and version commands are read-only and do not call Huawei Cloud resource APIs.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (service.toLowerCase() === 'configure') {
    const subcommand = operation.toLowerCase();
    if (
      policy.blockedConfigureSubcommands.map((cmd) => cmd.toLowerCase()).includes(subcommand) &&
      options.allowCredentialRead !== true
    ) {
      return {
        decision: 'deny',
        risk: 'credential',
        reason:
          'Direct hcloud configure inspection may expose profile credentials. Use the redacted toolkit tools instead.',
      };
    }
  }

  if (policy.blockedSecretOperations.some((op) => op.toLowerCase() === operation.toLowerCase())) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value reads are blocked so plaintext secrets do not enter the agent context.',
    };
  }

  if (/secret[_-]?string|secret[_-]?binary|showsecret|showsecretversion|getsecretvalue/i.test(joined)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'The command appears to retrieve a secret value. Use a runtime secret reference pattern instead.',
    };
  }

  const readOnly = hasReadPrefix(operation, policy);
  const executionOps =
    /(^|\.)(Invoke|SyncInvoke|AsyncInvoke|Send|Trigger|Execute|Start|Reboot|Restart|Stop|Publish|Deploy)/i;
  const isExecution = executionOps.test(operation) && !readOnly;
  const isWrite = !readOnly && hasWritePrefix(operation, policy);

  if (isExecution && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'execution',
      reason: 'Huawei Cloud execution/trigger operation blocked until approved.',
    };
  }

  if (isWrite && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'write',
      reason:
        'Huawei Cloud write operation blocked until the agent presents a plan and receives explicit user approval.',
    };
  }

  const obsutilWrites = [
    'mb',
    'cp',
    'mv',
    'rm',
    'delete',
    'mkdir',
    'sync',
    'restore',
    'chattri',
    'bucketpolicy',
    'lifecycle',
    'cors',
    'website',
    'sign',
    'share-add',
    'share-update',
    'share-rm',
  ];
  const obsutilReads = ['ls', 'stat', 'cat', 'help', 'version'];
  const isObs = service.toLowerCase() === 'obs' || service.toLowerCase() === 'hcloud obs';
  const isObsWrite = isObs && obsutilWrites.includes(operation);
  const isObsRead = isObs && obsutilReads.includes(operation);
  if (isObsWrite && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'write',
      reason: 'OBS write operation blocked until the agent presents a plan and receives explicit user approval.',
    };
  }
  if (isObsRead) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'read_only',
        reason: 'OBS read-only operation.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }
  if (isObsWrite && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'write',
        reason: 'OBS write operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (isExecution && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'execution',
        reason: 'Huawei Cloud execution/trigger operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (isWrite && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'write',
        reason: 'Huawei Cloud write operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  return applyCommandRiskRules(
    {
      decision: 'allow',
      risk: readOnly ? 'read_only' : 'unknown_read',
      reason: readOnly
        ? 'Command appears to be a read-only Huawei Cloud operation.'
        : 'Command does not match a known write or secret operation; treat output as untrusted and redact it.',
      service,
      operation,
      args: normalizedArgs,
    },
    normalizedArgs,
    options,
  );
}

function splitSimpleCommand(command) {
  return (
    String(command)
      .match(/"[^"]*"|'[^']*'|\S+/g)
      // Strip ALL quote characters (not just the outer pair): POSIX shells
      // remove quotes before executing, so an embedded-quote form like
      // `hcloud ECS De'leteServer …` actually runs `DeleteServer`. Stripping
      // only outer quotes left `De'leteServer` in the token and let the write/
      // secret/execution matchers miss it (#927). This hcloud classification
      // path only — credential-var lookbehind still sees raw text with quotes.
      .map((part) => part.replace(/['"]/g, '')) || []
  );
}

// Extract inner command text from shell wrappers: bash -c "…", sh -c '…',
// eval "…", $(…), `…`, Windows cmd/powershell. Returns an array of extracted
// inner strings (may include nested extractions). This lets classifyTextCommand
// inspect the actual payload instead of the wrapper tokens (#758 D4-16).
export function extractInnerCommand(text, depth = 0) {
  if (depth > 3) return [];
  const t = String(text || '');
  const results = [];
  let m;

  // bash -c "…" / sh -c '…' / /bin/bash -c "…" / bash.exe -c '…'
  const shellWrap = /\b(?:bash|sh|zsh|dash|\/bin\/(?:bash|sh|zsh|dash)|bash\.exe|sh\.exe)\s+-c\s+(["'])([\s\S]*?)\1/gi;
  while ((m = shellWrap.exec(t)) !== null) {
    if (m[2]) {
      results.push(m[2]);
      results.push(...extractInnerCommand(m[2], depth + 1));
    }
  }

  // eval "…" / eval '…'
  const evalWrap = /\beval\s+(["'])([\s\S]*?)\1/gi;
  while ((m = evalWrap.exec(t)) !== null) {
    if (m[2]) {
      results.push(m[2]);
      results.push(...extractInnerCommand(m[2], depth + 1));
    }
  }

  // $(…) command substitution (single-level; nested parens are a known limitation)
  const cmdSubst = /\$\(([^)]+)\)/g;
  while ((m = cmdSubst.exec(t)) !== null) {
    if (m[1]) {
      results.push(m[1]);
      results.push(...extractInnerCommand(m[1], depth + 1));
    }
  }

  // `…` backtick command substitution (POSIX sh). Treated the same as $(…):
  // the inner text is extracted as an independent candidate and recursed
  // into so that `hcloud ECS DeleteServer …` is classified correctly (#758).
  const backtickSubst = /`([^`]+)`/g;
  while ((m = backtickSubst.exec(t)) !== null) {
    if (m[1]) {
      results.push(m[1]);
      results.push(...extractInnerCommand(m[1], depth + 1));
    }
  }

  // Windows: cmd /c "…" / cmd /k '…' / cmd.exe /c "…" (#731 / #760).
  // /c runs and terminates; /k runs and keeps the shell — both can wrap hcloud.
  const cmdWrap = /\b(?:cmd|cmd\.exe)\s+\/[ck]\s+(["'])([\s\S]*?)\1/gi;
  while ((m = cmdWrap.exec(t)) !== null) {
    if (m[2]) {
      results.push(m[2]);
      results.push(...extractInnerCommand(m[2], depth + 1));
    }
  }

  // Windows: powershell -Command "…" / powershell -c '…' / pwsh -Command "…"
  // / pwsh.exe -c "…" (#731 / #760). Covers both Windows PowerShell and
  // PowerShell Core (pwsh). The -Command/-c flag executes the quoted string.
  const psWrap = /\b(?:powershell|powershell\.exe|pwsh|pwsh\.exe)\s+(?:-Command|-c)\s+(["'])([\s\S]*?)\1/gi;
  while ((m = psWrap.exec(t)) !== null) {
    if (m[2]) {
      results.push(m[2]);
      results.push(...extractInnerCommand(m[2], depth + 1));
    }
  }

  return results;
}

// Find the hcloud keyword in a command position (string start, after shell
// separators ; | &, after command-substitution openings $( `, or after sudo).
// Excludes hcloud mentioned in natural-language/echo text to avoid false-
// positive deny/write on documentation text (#758 D4-11 P1 fix). Candidates
// from extractInnerCommand (shell wrappers) start with hcloud directly so
// ^hcloud still catches wrapped commands and prompt-injections using
// separators. sudo\s+ preserves the dev-baseline behaviour where
// `sudo hcloud …` is treated as a real command, not documentation (#760 P0).
// Keyword-locator pattern shared by the raw-text match and the quote-stripped
// retry in extractHcloudSubcommand (`im` flag, no `g` — no lastIndex state).
const HCLOUD_KEYWORD_PATTERN = /(?:^|[;|&]\s*|\$\(\s*|`\s*|sudo\s+|\r?\n\s*)(hcloud(?:\.exe)?\b)/im;

// AgentArts CLI (agentarts-sdk) keyword locator — command-position semantics
// aligned with the hcloud pattern, extended for invocation shapes the
// agentarts floor must catch on its own (PR1 has no approval wrapper yet as
// the second line of defense): launcher prefixes with a bounded run of
// options and arguments (env -i, nice -n 5, xargs -r, timeout --foreground
// 300, g-prefixed GNU spellings, dotenv), env-var assignments (FOO=1
// agentarts …, VAR=/path/agentarts …), path invocation
// (/opt/venv/bin/agentarts …, ./agentarts …), sudo with options, values, and
// executor words (strace/time/ltrace/perf/valgrind/script), and the
// $AGENTARTS_BIN handle. The token-runs are BOUNDED ({0,6}/{0,8}): an
// unbounded star made every launcher word a quadratic backtracking start
// position, and a ~48KB padded command stalled the wired hook past its 5s
// runner timeout — a dead hook is a non-blocking error, i.e. allow.
// Natural-language mentions ("see agentarts docs") still never match: plain
// whitespace is not a command-position prefix. The (?![\w./-]) boundary
// excludes agentarts-sdk / agentarts-setup lookalikes, directory paths like
// docs/agentarts/README, and printenv/setenv variable-name mentions.
// Accepted deny-direction false positives: quoted strings and grep patterns
// containing `;|& agentarts <group>` or `<path>/ agentarts <group>`;
// assignment-shaped prose (`echo version=1.0 agentarts rocks`); prose after
// a launcher token-run (`watch -n 5 grep agentarts logfile`). The remedy in
// every case is the taught degraded path — run it in the user terminal.
const AGENTARTS_KEYWORD_PATTERN =
  /(?:^|[;|&]\s*|\$\(\s*|`\s*|\r?\n\s*|\b(?:g(?:timeout|xargs|nice|stdbuf|watch)|dotenv|env|nohup|exec|command|xargs|nice|setsid|stdbuf|watch|timeout)(?:\s+\S+){0,6}\s+|sudo(?:\s+(?:-\S+(?:\s+[^\s-]+)?|strace|ltrace|perf|valgrind|script|time)){0,8}\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+|[A-Za-z_][A-Za-z0-9_]*=|[\w.~\\/-]*[/\\])(?<kw>agentarts(?:\.exe)?|\$\{?AGENTARTS_BIN\}?)(?![\w./-])/im;

function extractHcloudSubcommand(text) {
  const t = String(text || '');
  // `m` flag + newline in the separator class: a hcloud command at the start
  // of any line (not just the first) must be located and fully classified —
  // previously `echo hello\nhcloud ECS DeleteServer …` fell through as
  // not_huaweicloud allow (#927).
  const match = HCLOUD_KEYWORD_PATTERN.exec(t);
  if (match) {
    const hcloudIndex = match.index + match[0].length - match[1].length;
    return t.slice(hcloudIndex);
  }
  // Keyword-embedded quotes fallback (#927 B1): POSIX shells strip quotes
  // before execution, so `hc'loud ECS DeleteServer …` runs `hcloud …` — but
  // the literal match above never sees the keyword through the quotes and the
  // command fell through as not_huaweicloud allow (its de-quoted form is
  // DENY). Retry on a quote-stripped COPY used only for hcloud keyword
  // location; the returned subcommand is the de-quoted text, matching the
  // de-quote semantics splitSimpleCommand already applies to tokens.
  // Credential/env-var checks in classifyTextCommand still run on the raw
  // text — the two paths stay independent — and natural-language mentions
  // ("see hcloud docs", "echo hcloud is a CLI") match the same anchored
  // pattern, so no new false positives are introduced.
  const stripped = t.replace(/['"]/g, '');
  const strippedMatch = HCLOUD_KEYWORD_PATTERN.exec(stripped);
  if (!strippedMatch) return null;
  const hcloudIndex = strippedMatch.index + strippedMatch[0].length - strippedMatch[1].length;
  return stripped.slice(hcloudIndex);
}

function extractAgentartsSubcommand(text) {
  const t = String(text || '');
  const match = AGENTARTS_KEYWORD_PATTERN.exec(t);
  if (match) {
    const agentartsIndex = match.index + match[0].length - match.groups.kw.length;
    return t.slice(agentartsIndex);
  }
  // Quote-embedded keyword fallback, same shape as the hcloud #927 retry:
  // `agen'tarts destroy …` runs `agentarts destroy …` after POSIX de-quoting,
  // but the literal match never sees the keyword through the quote.
  const stripped = t.replace(/['"]/g, '');
  const strippedMatch = AGENTARTS_KEYWORD_PATTERN.exec(stripped);
  if (!strippedMatch) return null;
  const agentartsIndex = strippedMatch.index + strippedMatch[0].length - strippedMatch.groups.kw.length;
  return stripped.slice(agentartsIndex);
}

// Classify an agentarts invocation from the de-quoted tokens that follow the
// `agentarts` keyword. Tiers and labels are measured facts
// (docs/agentarts-pr0-findings.md; fixtures in test/fixtures/agentarts/) and
// live in policy.json agentartsCommandPolicy so the Node hook, the Python
// hook, and the approval wrapper consume one source. Tier semantics for the
// hook layer: local/readonly allow, approved deny-for-Bash (user terminal or
// approved tooling), blocked deny outright (deferred capability).
export function classifyAgentartsArgs(tokens, options = {}) {
  const policy = options.policy || DEFAULT_POLICY;
  const commandPolicy = policy.agentartsCommandPolicy || {};
  const commands = commandPolicy.commands || {};
  const aliases = commandPolicy.aliases || {};
  const defaultTier = commandPolicy.defaultTier || 'approved';

  let args = (Array.isArray(tokens) ? tokens.map(String) : [])
    .map((token) => token.toLowerCase())
    // splitSimpleCommand can emit empty tokens for quoted-empty arguments
    // (`agentarts "" launch`); dropping them keeps the group resolution
    // aligned with the Python tokenizer.
    .filter((token) => token !== '');
  // extractAgentartsSubcommand returns text starting AT the keyword (same
  // contract as the hcloud path), so strip the executable token first —
  // exact name, .exe, path-invoked forms, and the $AGENTARTS_BIN handle.
  const first = args[0] || '';
  if (
    first === 'agentarts' ||
    first === 'agentarts.exe' ||
    first.endsWith('/agentarts') ||
    first.endsWith('\\agentarts') ||
    /^\$\{?agentarts_bin\}?$/.test(first)
  ) {
    args = args.slice(1);
  }
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += 1;
  const group = args[i];
  const base = { service: 'AgentArts', operation: group || '', args };

  // Typer eager flags: --help/-h are valid at every command level, so any
  // position makes the invocation local metadata; --version/-v only exist at
  // root level, so only the leading flag region (before the group token)
  // counts. A bare `agentarts` prints help.
  if (
    !group ||
    args.some((token) => /^(--help|-h)$/.test(token)) ||
    args.slice(0, i).some((token) => /^(--version|-v)$/.test(token))
  ) {
    if (
      !group &&
      options.segment &&
      (/\b(?:g)?xargs\b/.test(options.segment) || /\b(?:g)?xargs\b/.test(options.segment.replace(/['"]/g, '')))
    ) {
      // `… | xargs [-r/-n1/…] agentarts` (any spelling, incl. path or
      // $AGENTARTS_BIN) feeds the subcommand on stdin — unclassifiable and
      // therefore fail-safe deny rather than bare-help allow.
      return {
        decision: 'deny',
        risk: 'agentarts_write',
        reason:
          'agentarts invoked via xargs (arguments arrive on stdin and cannot be classified); run it in your own terminal (see the huawei-agentarts skill).',
        ...base,
      };
    }
    return applyRawCommandRiskRules(
      {
        decision: 'allow',
        risk: 'agentarts_local',
        reason: 'Local agentarts metadata operation.',
        ...base,
      },
      options.rawCommand || args.join(' '),
      options,
    );
  }

  const normalizedGroup = aliases[group] || group;
  const entry = commands[normalizedGroup];
  // Report the normalized group (launch, not the deploy alias) so the deny
  // reason matches the Python layer byte-for-byte.
  base.operation = normalizedGroup;
  let tier = defaultTier;
  let labels = [];
  if (entry) {
    tier = entry.tier || defaultTier;
    labels = entry.labels || [];
    const subcommands = entry.subcommands;
    const sub = args[i + 1];
    if (subcommands && sub && !sub.startsWith('-')) {
      const subEntry = subcommands[sub];
      if (subEntry) {
        tier = subEntry.tier || tier;
        labels = subEntry.labels || labels;
        base.operation = `${normalizedGroup} ${sub}`;
      }
      // Unknown subcommand under a group keeps the group default tier —
      // fail-safe, mirroring the unknown-top-level defaultTier.
    }
  }

  if (tier === 'approved' || tier === 'blocked') {
    const labelSuffix = labels.length ? ` (${labels.join(', ')})` : '';
    return {
      decision: 'deny',
      risk: tier === 'blocked' ? 'agentarts_blocked' : 'agentarts_write',
      reason:
        tier === 'blocked'
          ? `agentarts ${base.operation} is deferred to a later toolkit release; run it in your own terminal if needed (see the huawei-agentarts skill).`
          : `Bash execution of agentarts ${base.operation}${labelSuffix} is blocked: cloud write operations must run in your own terminal or through approved tooling (see the huawei-agentarts skill).`,
      ...base,
    };
  }

  return applyRawCommandRiskRules(
    {
      decision: 'allow',
      risk: tier === 'readonly' ? 'agentarts_read_only' : 'agentarts_local',
      reason:
        tier === 'readonly'
          ? 'Read-only agentarts operation; treat output as untrusted and redact it.'
          : 'Local agentarts operation.',
      ...base,
    },
    options.rawCommand || args.join(' '),
    options,
  );
}

// Segment sweep for the agentarts gate: shell operators and newlines can
// chain a write after a readonly agentarts command (`agentarts memory list
// && agentarts launch`), which a single first-keyword classification misses.
// Splits on the same operator set as findHcloudCommandSegments (plus
// newlines, where the keyword pattern also recognizes command position) and
// classifies every segment that invokes agentarts, merging to the most
// severe decision — the hcloud segment-sweep contract.
function classifyAgentartsText(text, options = {}) {
  const segments = String(text || '')
    .split(/(?:\|\||&&|;|\||&|\r?\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  let merged = null;
  for (const segment of segments) {
    const subcommand = extractAgentartsSubcommand(segment);
    if (!subcommand) continue;
    const decision = classifyAgentartsArgs(splitSimpleCommand(subcommand), {
      ...options,
      segment,
    });
    if (decision.decision === 'deny') return decision;
    if (!merged) merged = decision;
  }
  return merged;
}

export function classifyTextCommand(command, options = {}) {
  const policy = options.policy || DEFAULT_POLICY;
  const text = String(command || '');

  // Extract inner commands from shell wrappers (bash -c, sh -c, eval, $()).
  // Each candidate (original + extracted inners) is checked independently so a
  // wrapped credential dump or hcloud write is caught even when the wrapper
  // text alone doesn't match (#758 D4-16, also covers #682 env-dump vector).
  const candidates = [text, ...extractInnerCommand(text)];

  // Credential file reads — check all candidates.
  for (const candidate of candidates) {
    if (matchesAny(candidate, policy.credentialFilePatterns)) {
      return {
        decision: 'deny',
        risk: 'credential',
        reason:
          'Reading Huawei Cloud credential or profile files is blocked. Use redacted profile inspection tools instead.',
      };
    }
  }

  // Env var dumps — check all candidates (covers bash -c "env | grep HUAWEICLOUD", #682).
  for (const candidate of candidates) {
    if (
      /(^|\s)(env|printenv|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:)/i.test(candidate) &&
      /HUAWEICLOUD|HWC_|HW_|HCLOUD|OS_/i.test(candidate)
    ) {
      return {
        decision: 'deny',
        risk: 'credential',
        reason: 'Dumping cloud credential environment variables is blocked.',
      };
    }
  }

  // Credential variable references bypass the env-command gate above: HW_ is
  // the plugin's own documented credential prefix (HW_ACCESS_KEY/HW_SECRET_KEY/
  // HW_SECURITY_TOKEN), cloud environments also expose the AWS-style
  // HUAWEICLOUD_SECRET_ACCESS_KEY name, and `echo $HW_SECRET_KEY` /
  // `printenv HW_ACCESS_KEY` / `echo $HUAWEICLOUD_SECRET_ACCESS_KEY` previously
  // fell through to allow (#650 D4-2, #770 D4-2).
  //
  // The negative lookbehind exempts literal-NAME references — backslash-escaped
  // (`\$HW_*`) or single-quoted (`'$HW_*'`, which the shell never expands) —
  // while unescaped `$HW_*` is a potential expansion/dump regardless of the
  // command. No command-name whitelist, so no false negative (#650 review).
  for (const candidate of candidates) {
    if (
      /(?<!['\\])\$\{?(?:HUAWEICLOUD|HWC|HW|OS)_(?:SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|SDK_AK|SDK_SK)/i.test(
        candidate,
      ) ||
      /(?:^|\s)printenv\s+(?:HUAWEICLOUD|HWC|HW|OS)_(?:SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|SDK_AK|SDK_SK)/i.test(
        candidate,
      )
    ) {
      return {
        decision: 'deny',
        risk: 'credential',
        reason: 'Printing cloud credential environment variables is blocked.',
      };
    }
  }

  // hcloud command detection — extract the subcommand starting from the hcloud
  // keyword so prompt-injection prefixes ("Ignore previous instructions and
  // hcloud …") and shell wrappers ("bash -c \"hcloud …\"") are classified
  // correctly (#758 D4-16 + D4-11). Check all candidates (original + inners).
  // Non-deny decisions are held pending instead of returned immediately: a
  // readonly allow from the first matching candidate must not shadow a deny
  // in a later candidate or in the agentarts sweep below (e.g.
  // `agentarts memory list && bash -c "agentarts launch"`, or a mixed
  // `hcloud … && agentarts launch` chain) — deny wins across candidates,
  // mirroring the Python hook's loop semantics.
  let hcloudPending = null;
  for (const candidate of candidates) {
    const hcloudSubcommand = extractHcloudSubcommand(candidate);
    if (hcloudSubcommand) {
      const decision = classifyHcloudArgs(splitSimpleCommand(hcloudSubcommand), { ...options, rawCommand: text });
      if (decision.decision === 'deny') {
        return decision;
      }
      hcloudPending = hcloudPending || decision;
    }
  }

  // agentarts CLI detection — same candidate sweep with a per-candidate
  // segment sweep so chained writes after a readonly segment are caught.
  let agentartsPending = null;
  for (const candidate of candidates) {
    const agentartsDecision = classifyAgentartsText(candidate, { ...options, rawCommand: text });
    if (agentartsDecision) {
      if (agentartsDecision.decision === 'deny') {
        return agentartsDecision;
      }
      agentartsPending = agentartsPending || agentartsDecision;
    }
  }
  if (hcloudPending) {
    return hcloudPending;
  }
  if (agentartsPending) {
    return agentartsPending;
  }

  if (/ShowSecretVersion|ShowSecret|GetSecretValue|secret_string|secret_binary/i.test(text)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value retrieval patterns are blocked.',
    };
  }

  return applyRawCommandRiskRules(
    {
      decision: 'allow',
      risk: 'not_huaweicloud',
      reason: 'No Huawei Cloud safety rule matched.',
    },
    text,
    options,
  );
}

export function assertAllowed(result) {
  if (result.decision === 'deny') {
    const error = new Error(result.reason);
    error.policy = result;
    throw error;
  }
  return result;
}
