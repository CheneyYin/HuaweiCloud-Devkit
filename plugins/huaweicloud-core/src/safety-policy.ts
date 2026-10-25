import { asText } from './lib/as-text.ts';
import { evaluateCommandRisk, mergeRiskDecision, type RiskDecision } from './risk-rule-engine.ts';
import { DEFAULT_POLICY } from './safety/default-policy.ts';
import { credentialFileCandidates } from './safety/credential-path.ts';
import { unwrapSecretExecWrapper } from './safety/secret-exec.ts';
import { unwrapSkillQualityCli } from './safety/skill-quality-cli.ts';
import { hasReadPrefix, hasWritePrefix, matchesAny, type ClassifyOptions } from './safety/policy.ts';
import { splitShellSegments, splitSimpleCommand, stripShellQuotes } from './safety/shell-text.ts';
import {
  basenameOf,
  COMMAND_POSITION_PREFIXES,
  isHcloudToken,
  OBSUTIL_WRITES,
  peelGluedRedirect,
  SHELL_FIRST_TOKENS,
  skipPrefixArguments,
} from './safety/tokens.ts';
import { stripExecutable, unwrapWithWindowsFlag } from './safety/unwrap.ts';
import { hcloudPieceAt, windowsScriptArgAt } from './safety/windows.ts';
import { SECRET_ARGS_RE, SECRET_SHADOW_RE, SECRET_TEXT_RE } from './safety/vocabulary.ts';

// Stable public face: the safety family under src/safety/ owns the
// internals; this module is the re-export seam every consumer imports.
export { loadPolicy } from './safety/default-policy.ts';
export type { Policy } from './safety/policy.ts';
export type { ClassifyOptions } from './safety/policy.ts';
export { deriveSecretOperationAlternation } from './safety/vocabulary.ts';
export { redactSecrets } from './safety/redact.ts';
export { splitShellSegments } from './safety/shell-text.ts';
export { isCredentialFilePath } from './safety/credential-path.ts';

function commandOperation(args: unknown): { service: string; operation: string; args: string[] } {
  const stripped = stripExecutable(Array.isArray(args) ? args.map((arg) => String(arg)) : [])
    .map(String)
    .filter(Boolean);
  const nonFlags = stripped.filter((arg) => !arg.startsWith('-')).map((arg) => peelGluedRedirect(arg));
  if (stripped[0]?.toLowerCase() === 'configure') {
    // nonFlags slot: a flag between `configure` and its subcommand
    // (`hcloud configure --cli-region=x show`) must not mask the
    // credential-gate operation.
    return { service: 'configure', operation: nonFlags[1] ?? nonFlags[0] ?? '', args: stripped };
  }
  return {
    service: nonFlags[0] || '',
    operation: nonFlags[1] || nonFlags[0] || '',
    args: stripped,
  };
}

function isLocalMetadataCommand(args: string[]): boolean {
  return args.some((arg) => /^(--help|-h|help|version|--version)$/i.test(String(arg)));
}

function commandRiskText(normalizedArgs: string[], options: ClassifyOptions): string {
  return options.rawCommand || ['hcloud', ...normalizedArgs].join(' ');
}

function applyCommandRiskRules(base: RiskDecision, normalizedArgs: string[], options: ClassifyOptions): RiskDecision {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(commandRiskText(normalizedArgs, options));
  return mergeRiskDecision(base, risk);
}

function applyRawCommandRiskRules(base: RiskDecision, command: string, options: ClassifyOptions): RiskDecision {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(command);
  return mergeRiskDecision(base, risk);
}

// Find hcloud-leading command segments: quote/heredoc-aware splitting
// (splitShellSegments), tokenization per segment, and command-position
// unwrapping before the leading-hcloud check. Two recursions keep nested
// and fed payloads classifiable: (a) a quoted `bash -c`/`eval` argument is
// itself a script — its separators are live commands, so the argument is
// re-scanned (depth-capped); (b) an `xargs hcloud …` segment draws its
// arguments from the PRECEDING piped segment, so those tokens are merged
// in as candidate operation words.
function findHcloudCommandSegments(text: unknown, depth = 0, inheritedFeeder: string[] | null = null): string[][] {
  const segmentSeps: string[] = [];
  const scannerSegments = splitShellSegments(String(text), segmentSeps);
  const out: string[][] = [];
  const scriptOf = (tokens: string[]): string | null => {
    if (!tokens.length) return null;
    const first = String(tokens[0] || '').toLowerCase();
    const base = basenameOf(String(tokens[0] || '')).toLowerCase();
    const shellLike = SHELL_FIRST_TOKENS.has(first) || (base !== first && SHELL_FIRST_TOKENS.has(base));
    // `-c`, `-lc`, `-xc` … any option cluster ending in c takes the
    // script; the script argument's `\"` pairs are span-internal escapes,
    // resolved at this consumption point. When the script word is ITSELF
    // a bin or wrapper head (`bash -c hcloud ECS …` — the flattened join
    // of the real `bash -c "hcloud ECS …"`), the tail tokens belong to
    // the same command: return them joined, or the nested scan sees a
    // bare bin and hits the empty-args guard on a legitimate read.
    const isScriptFlag = /^-[a-z]*c$/i.test(String(tokens[1] || ''));
    const resolveSpan = (s: string): string => String(s).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (shellLike && isScriptFlag && tokens[2]) {
      const script = resolveSpan(tokens[2]);
      const scriptHeadTok = splitSimpleCommand(script)[0];
      const headIsCommandish =
        isHcloudToken(String(scriptHeadTok ?? '')) ||
        SHELL_FIRST_TOKENS.has(String(scriptHeadTok ?? '').toLowerCase()) ||
        String(scriptHeadTok ?? '').toLowerCase() === 'eval' ||
        COMMAND_POSITION_PREFIXES.has(String(scriptHeadTok ?? '').toLowerCase());
      if (headIsCommandish && tokens.length > 3) {
        return [script, ...tokens.slice(3).map(String)].join(' ');
      }
      return script;
    }
    // eval evaluates the JOIN of all its arguments — the script string is
    // the whole tail, not just the first word.
    if (first === 'eval' && tokens[1]) {
      return tokens
        .slice(1)
        .map((t) => resolveSpan(t))
        .join(' ');
    }
    return windowsScriptArgAt(tokens, 0);
  };
  for (let s = 0; s < scannerSegments.length; s++) {
    const tokens = splitSimpleCommand(scannerSegments[s]!);
    // Nested scripts, BEFORE any unwrapping flattens them: a quoted
    // `bash -c`/`eval` argument is itself a command line whose separators
    // are live commands. Wrapper unwrapping runs to a FIXPOINT (an sqc
    // child that is itself a secret-exec or sqc invocation reaches its
    // innermost script too) — one level per wrapper kind would miss
    // same-wrapper compositions with compound inner scripts. The depth
    // budget is 16: adversarial nests five-plus deep genuinely execute
    // (`bash -c` × 5 around `hcloud x; hcloud <write>`), and beyond the
    // budget the unwrap path re-tokenizes WITHOUT re-splitting `;` — the
    // write launders. Bounded by input length, each level consumes a
    // wrapper token. The budget (18) sits one level past the Linux
    // executability ceiling (~17 levels before MAX_ARG_STRLEN bites);
    // larger inputs are stopped by the length cap at classification
    // entry.
    if (depth < 18) {
      const candidates: string[][] = [tokens];
      let cursor = tokens;
      for (let n = 0; n < 4; n++) {
        const next = unwrapSecretExecWrapper(cursor) ?? unwrapSkillQualityCli(cursor);
        if (!next) break;
        candidates.push(next);
        cursor = next;
      }
      // A command-position prefix in front of a shell head
      // (`sudo bash -c "echo Delete | xargs hcloud ECS"`) hides the
      // script from scriptOf's head check — probe PAST the prefixes (and
      // their value flags) so the nested segment/feeder semantics fire.
      let probe = tokens;
      for (let d = 0; d < 10; d++) {
        const probeHead = String(probe[0] ?? '').toLowerCase();
        const probeBase = basenameOf(String(probe[0] ?? '')).toLowerCase();
        const isEnvAssignmentToken = /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(probe[0] ?? ''));
        if (
          !COMMAND_POSITION_PREFIXES.has(probeHead) &&
          !COMMAND_POSITION_PREFIXES.has(probeBase) &&
          !isEnvAssignmentToken
        ) {
          break;
        }
        probe = isEnvAssignmentToken ? probe.slice(1) : skipPrefixArguments(probeBase || probeHead, probe.slice(1));
        candidates.push(probe);
      }
      for (const candidate of candidates) {
        const nested = scriptOf(candidate);
        if (nested !== null) {
          // The nested script's stdin is THIS segment's stdin: a piped
          // context feeds it, so the outer feeder threads down — an
          // xargs inside the script inherits the OUTER pipe
          // (`echo Delete | bash -c 'true; xargs hcloud ECS'`).
          const nestedFeeder = s > 0 ? splitSimpleCommand(scannerSegments[s - 1]!).slice(1) : inheritedFeeder;
          out.push(...findHcloudCommandSegments(nested, depth + 1, nestedFeeder));
        }
      }
    }
    const { stream: unwrappedRaw, windowsPayload } = unwrapWithWindowsFlag(tokens);
    // A wrapper payload headed by xargs (`cmd /c "xargs hcloud ECS"` —
    // the child inherits the pipe and appends the feeder): strip the bin
    // so the hcloud-leading check and the feeder merge both engage.
    const isXargsHead = (() => {
      const t = String(unwrappedRaw[0] ?? '').toLowerCase();
      return t === 'xargs' || basenameOf(String(unwrappedRaw[0] ?? '')).toLowerCase() === 'xargs';
    })();
    const unwrapped = isXargsHead ? unwrappedRaw.slice(1) : unwrappedRaw;
    if (!isHcloudToken(String(unwrapped[0] || ''))) continue;
    // xargs feed: the preceding segment's non-command tokens become argv
    // AFTER the segment's own arguments (xargs appends stdin to the tail).
    // xargs is detected on the PRE-unwrap segment tokens AND the
    // unwrapped stream: inside a quoted windows payload the whole
    // command is one token, and only the unwrapped head exposes the
    // `xargs` bin (`echo Delete | cmd /c "xargs hcloud ECS"` — the child
    // inherits the pipe and executes the merged write). A span token
    // whose FIRST word is xargs counts too.
    const isXargsToken = (token: unknown): boolean => {
      const t = String(token).toLowerCase();
      if (t === 'xargs' || basenameOf(String(token)).toLowerCase() === 'xargs') return true;
      if (/\s/.test(String(token))) {
        const firstWord = splitSimpleCommand(String(token))[0];
        return String(firstWord ?? '').toLowerCase() === 'xargs';
      }
      return false;
    };
    const hadXargs = tokens.some((t) => isXargsToken(t)) || unwrappedRaw.some((t) => isXargsToken(t));
    // Trailing redirection feeders: a herestring's words (`<<< Delete`)
    // and a `<`-terminated segment's NEXT segment (`< <(echo Delete)` —
    // the substitution split leaves the words in the following segment)
    // are INLINE-visible feeder content, same standard as the pipe.
    const herestringAt = tokens.findIndex((t) => /^0*<{3,}/.test(String(t)));
    // A heredoc marker (`<<EOF`, `<<-EOF`, `<< EOF`) — the body words are
    // stdin feeder content for the xargs-bearing opening segment.
    const heredocAt = tokens.findIndex((t) => /^0*<<-?(?!<)/.test(String(t)));
    const trailingRedirect = /<\s*$/.test(scannerSegments[s] ?? '') && s + 1 < scannerSegments.length;
    if (hadXargs && (s > 0 || inheritedFeeder !== null || herestringAt >= 0 || heredocAt >= 0 || trailingRedirect)) {
      // The feeder is the UNION of every visible source: the pipeline
      // WALK-BACK (through control headers, group braces, and argless
      // pass-through filters — the pipe's data reaches the xargs body
      // through them: `echo Delete | if true; then xargs hcloud ECS; fi`;
      // a `;`-separated consuming command stops the walk), the inherited
      // outer pipe (the script's stdin), herestring words, and
      // redirection-substitution words. Union is fail-closed: any
      // write-shaped word reaching the argv denies.
      const controlHeadWords = new Set([
        'if',
        'while',
        'until',
        'for',
        'case',
        'then',
        'do',
        'else',
        'elif',
        'fi',
        'done',
        'esac',
        '{',
        '}',
        '(',
        ')',
        '!',
      ]);
      const passThroughBins = new Set(['cat', 'sort', 'tee', 'head', 'tail', 'uniq', 'wc', 'tr']);
      const walkBackFeeder = (): string[] => {
        const words: string[] = [];
        let k = s - 1;
        while (k >= 0) {
          const segToks = splitSimpleCommand(scannerSegments[k]!);
          const headTok = String(segToks[0] ?? '').toLowerCase();
          const args = segToks.slice(1).map(String);
          const isCtrl = controlHeadWords.has(headTok) || (passThroughBins.has(headTok) && args.length === 0);
          const sepAfter = segmentSeps[k] ?? '';
          const sepBefore = k > 0 ? (segmentSeps[k - 1] ?? '') : '';
          // `)` (substitution/subshell body) and `>(` (process
          // substitution) flow like `|` — the substituted data reaches
          // the pipe (`cat <(echo Delete) | xargs hcloud ECS`).
          const flows = sepAfter === '|' || sepAfter === ')' || sepAfter === '>(';
          if (!isCtrl && !flows) {
            // A consuming command not pipe-connected to the xargs segment
            // (`echo Delete | true; xargs …`): no stdin flow.
            if (k === s - 1) return words;
            break;
          }
          words.push(...args);
          if (!isCtrl && sepBefore !== '|' && sepBefore !== ')' && sepBefore !== '>(') break;
          k -= 1;
        }
        return words;
      };
      // xargs splits stdin on IFS: a QUOTED feeder token carries
      // multiple words (`echo "ECS DeleteServers" | xargs hcloud` runs
      // `hcloud ECS DeleteServers`) — expand every feeder token into its
      // whitespace-separated words.
      const expandWords = (tokens: string[]): string[] =>
        tokens.flatMap((t) =>
          String(t)
            .split(/\s+/)
            .filter(Boolean)
            .map((w) => w.replace(/^['"]|['"]$/g, '')),
        );
      let feeder = expandWords([...walkBackFeeder(), ...(inheritedFeeder ?? [])]);
      if (herestringAt >= 0 && /^0*<{3,}$/.test(String(tokens[herestringAt]))) {
        // A BARE `<<<` marker: the following tokens are the payload. A
        // GLUED marker (`<<<"OBS rm"` tokenizes as `<<<"OBS` + `rm"`) is
        // handled by the redirect-marker branch below — running both
        // would duplicate the payload words.
        feeder = [...feeder, ...expandWords(tokens.slice(herestringAt + 1).map(String))];
      }
      if (trailingRedirect) {
        feeder = [
          ...feeder,
          ...expandWords(
            splitSimpleCommand(scannerSegments[s + 1]!)
              .slice(1)
              .map(String),
          ),
        ];
      }
      // Placeholders: the literal {} / % runs AND the declared -I/--replace
      // value (any replstr spelling) — stdin tokens fill those positions.
      const replstr = (() => {
        for (let t = 0; t < tokens.length; t++) {
          const token = String(tokens[t]!);
          if (token === '-I' || token === '--replace' || token === '--delimiter') {
            const next = tokens[t + 1];
            if (next !== undefined) return String(next);
          }
          const eq = token.match(/^(?:-I|--replace(?:=)?|--delimiter=)(.+)$/);
          if (eq) return eq[1]!;
        }
        return null;
      })();
      const placeholders = new Set(
        unwrapped
          .slice(1)
          .filter((token) => /^[{}%]+$/.test(String(token)) || (replstr !== null && String(token) === replstr)),
      );
      // Redirection tokens are not argv — input (`<<<`, `<`, glued
      // `<<<Delete`), output (`>`, `>>`, `2>`, `1>`, `>&2`, `2>&1`), and
      // heredoc markers (`<<EOF`, `<< EOF`) — and the words after a
      // herestring/heredoc already joined the feeder. Keep them out of
      // the own-args or they occupy the operation slot
      // (`echo Delete | xargs hcloud ECS > /dev/null`).
      const isRedirectToken = (t: string): boolean =>
        t === '<' ||
        /^0+$/.test(t) ||
        /^0+<$/.test(t) ||
        /^(?:\d*)>+<?&?/.test(t) ||
        /^0*<{3,}/.test(t) ||
        /^0*<<-?(?!<)/.test(t);
      const redirAt = unwrapped.slice(1).findIndex((token) => isRedirectToken(String(token)));
      const ownTail = redirAt < 0 ? unwrapped.slice(1) : unwrapped.slice(1, redirAt + 1);
      // A glued herestring payload (`<<<Delete`) and a heredoc body
      // (words between the marker and the delimiter) join the feeder.
      if (redirAt >= 0) {
        const marker = String(unwrapped[redirAt + 1] ?? '');
        const restTokens = unwrapped.slice(redirAt + 2).map(String);
        if (/^0*<{3,}/.test(marker)) {
          feeder = [...feeder, ...expandWords([marker.replace(/^0*<{3,}/, ''), ...restTokens])];
        } else if (/^0*<<-?/.test(marker)) {
          // Glued delimiter (`<<EOF`): the body runs until the delimiter
          // word repeats; spaced (`<<` + delim token): skip the declared
          // delimiter token first.
          const delim = marker.replace(/^0*<<-?/, '');
          const body = delim
            ? restTokens.slice(
                0,
                restTokens.findIndex((t, i) => t === delim && i > 0),
              )
            : restTokens.slice(
                1,
                restTokens.findIndex((t, i) => t === restTokens[0] && i > 0),
              );
          feeder = [...feeder, ...(body.length ? body : restTokens)];
        }
      }
      const ownArgs = ownTail.filter((token) => !placeholders.has(token));
      out.push([String(unwrapped[0]), ...ownArgs, ...feeder]);
      // Fail-closed per-word candidates: any single feeder word that
      // lands in the operation slot as the first appended argv word
      // (xargs appends stdin in order — `echo y && xargs hcloud ECS`
      // with an outer pipe feeds Delete behind the benign y). Only
      // write-prefixed words materialize candidates — a full-candidates
      // loop re-classifies each word against the whole payload and goes
      // quadratic on large legitimate feeders.
      for (const word of feeder) {
        const w = String(word).toLowerCase();
        if (
          hasWritePrefix(String(word), DEFAULT_POLICY) ||
          OBSUTIL_WRITES.has(w) ||
          (DEFAULT_POLICY.blockedConfigureSubcommands ?? []).includes(w)
        ) {
          out.push([String(unwrapped[0]), ...ownArgs, String(word)]);
        }
      }
      continue;
    }
    out.push(unwrapped);
    // A windows payload's brace grammar makes every LATER hcloud
    // occurrence a live command site (`try { read } finally { write }` —
    // `}` is not a segment separator, so the blocks stay one segment):
    // classify each further bin + following words as its own segment,
    // including bins GLUED to separator runs (`ListServers}catch{hcloud`).
    if (windowsPayload) {
      for (let i = 1; i < unwrapped.length; i++) {
        const pieceStream = hcloudPieceAt(unwrapped, i);
        if (pieceStream !== null && pieceStream.length > 1) {
          out.push(pieceStream);
        }
      }
    }
  }
  return out;
}

export function classifyHcloudArgs(args: unknown, options: ClassifyOptions = {}): RiskDecision {
  const policy = options.policy || DEFAULT_POLICY;
  const unwrappedTokens = stripExecutable(Array.isArray(args) ? args.map((arg) => String(arg)) : []);
  // Segment pass is UNCONDITIONAL: classifying only the leading command
  // reads the operation from line one of a multi-line script and lets a
  // write on any continuation line through. Every hcloud-leading segment
  // (split on ; && || | newline &) classifies; the most severe decision
  // wins. Prefer the RAW text for the split: tokenizing first and
  // re-joining collapses quoted command strings (`bash -c "hcloud …"` one
  // token) into a flat stream where the -c argument loses its grouping.
  if (!options._segmentDepth) {
    const hcloudSegments = findHcloudCommandSegments(options.rawCommand || unwrappedTokens.join(' '));
    if (hcloudSegments.length > 0) {
      const results = hcloudSegments.map((segment) => classifyHcloudArgs(segment, { ...options, _segmentDepth: 1 }));
      // results mirrors hcloudSegments, checked non-empty above; index 0 is defined.
      return (
        results.find((result) => result.decision === 'deny') ||
        results.find((result) => ['write', 'execution', 'secret', 'credential'].includes(result.risk ?? '')) ||
        results[0]!
      );
    }
    // A routed TEXT with no hcloud-leading segment is an orphan: prose
    // mentioning hcloud, a quoted package-name argument (`pip install
    // "hcloud"`), redirection remnants. The argv face's orphan
    // classification is a documented TS/py drift — text calls allow;
    // direct argv calls (tools, tests) and the segment recursion keep
    // the fallthrough classifier below.
    if (options.rawCommand !== undefined) {
      return applyCommandRiskRules(
        {
          decision: 'allow',
          risk: 'not_huaweicloud',
          reason: 'No Huawei Cloud safety rule matched.',
        },
        unwrappedTokens,
        options,
      );
    }
  }
  const { service, operation, args: normalizedArgs } = commandOperation(args);
  const joined = normalizedArgs.join(' ');

  if (!normalizedArgs.length && options._narrowRouted !== false) {
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

  const serviceShadow = stripShellQuotes(service).toLowerCase();
  if (serviceShadow === 'configure') {
    const subcommand = operation.toLowerCase();
    const subcommandShadow = stripShellQuotes(operation).toLowerCase();
    if (
      (policy.blockedConfigureSubcommands.map((cmd) => cmd.toLowerCase()).includes(subcommand) ||
        policy.blockedConfigureSubcommands.map((cmd) => cmd.toLowerCase()).includes(subcommandShadow)) &&
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

  if (
    policy.blockedSecretOperations.some(
      (op) =>
        op.toLowerCase() === operation.toLowerCase() || op.toLowerCase() === stripShellQuotes(operation).toLowerCase(),
    )
  ) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value reads are blocked so plaintext secrets do not enter the agent context.',
    };
  }

  if (SECRET_ARGS_RE.test(joined)) {
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

  const obsutilWrites = OBSUTIL_WRITES;
  const obsutilReads = ['ls', 'stat', 'cat', 'help', 'version'];
  const isObs = service.toLowerCase() === 'obs';
  // Lowercase the vocab lookup (py-twin parity): the real binary rejects
  // case-variant subcommands, but the policy must not lean on that — the
  // wired Node hook faces agent-constructed text, not the binary.
  const isObsWrite = isObs && obsutilWrites.has(operation.toLowerCase());
  const isObsRead = isObs && obsutilReads.includes(operation.toLowerCase());
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

export function classifyTextCommand(command: unknown, options: ClassifyOptions = {}): RiskDecision {
  const policy = options.policy || DEFAULT_POLICY;
  const text = asText(command || '');
  const shadowText = stripShellQuotes(text);

  // Length cap: a routed payload past 256 KiB cannot execute through any
  // wrapper chain (MAX_ARG_STRLEN), and classifying pathological nests
  // at that size costs minutes — a hook DoS. Denied fail-closed instead.
  if (text.length > 262_144) {
    if (
      /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"]/i.test(shadowText) ||
      /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"]/i.test(text)
    ) {
      return {
        decision: 'deny',
        risk: 'invalid',
        reason: 'Command payload too large to classify safely; denied fail-closed.',
      };
    }
  }

  // Raw, shadow, and path-normalized forms (shared with the MCP file gate):
  // a quote pair inside the path (`~/.config/huawei'cloud/secrets'/.master-
  // key`) or a redundant `//`/`/./` segment defeats the contiguous-substring
  // patterns while the shell reads the canonical path — the vault tree and
  // keyfile are the most sensitive at-rest data this gate protects.
  if (credentialFileCandidates(text).some((candidate) => matchesAny(candidate, policy.credentialFilePatterns))) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason:
        'Reading Huawei Cloud credential or profile files is blocked. Use redacted profile inspection tools instead.',
    };
  }

  // The vault CLI's own reveal surface: `secret get` prints a stored secret
  // to stdout, which is the agent context when run through the Bash tool.
  // `secret exec` (values reach only the child env) stays allowed. Matched
  // against the quote-stripped shadow so quoted subcommand spellings
  // (`secret 'get'`) do not slip past.
  if (matchesAny(shadowText, policy.blockedSecretCliPatterns)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason:
        'Printing vault secrets into the agent context is blocked. Run the value consumer instead: npx huaweicloud-devkit secret exec --env NAME=secret://<scope>/<name> -- <command> — a child you trust not to print its own environment, since its stdout is this conversation. Or use secret get --file from your own terminal.',
    };
  }

  // Order-independent reveal pair: `echo secret get <ref> --stdout | xargs
  // npx huaweicloud-devkit` reorders the argv through xargs while every
  // word is literal in the text — the patterns above assume bin-before-
  // subcommand order. Any payload carrying BOTH a devkit bin and a
  // `secret get` pair is a reveal regardless of order.
  if (
    /(^|[^a-z0-9.-])(?:huaweicloud-devkit|setup-cli\.(?:js|mjs|ts|cjs)|setup\.cjs)/i.test(shadowText) &&
    /(?:^|\s)secret\s+get\b/i.test(shadowText)
  ) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason:
        'Printing vault secrets into the agent context is blocked. Run the value consumer instead (npx huaweicloud-devkit secret exec --env NAME=secret://<scope>/<name> -- <command>), or use secret get --file from your own terminal.',
    };
  }

  // Obfuscated cloud-command invocation: ANSI-C escapes (`$'\x67et'`,
  // `$'\x68'uaweicloud-devkit` build argv the quote-stripping shadow cannot
  // reconstruct — the letters come from the escape, not the text) and
  // command substitution (`$(echo secret)`, a backtick form) hide tokens
  // from every presence pattern. Canonical devkit and hcloud commands never
  // contain `$'`, `$"`, `$(`, or a backtick, so a cloud-command-bearing
  // payload carrying one is denied as obfuscated rather than parsed.
  // The cloud-command-bearing clause below misses ANSI-C KEYWORD mangling
  // ($'\x68'cloud — the h exists only inside the escape, so no layer sees
  // 'hcloud'; stripShellQuotes keeps the hex digits, giving shadow 'x68cloud').
  // The write-vocabulary clause closes it fail-closed WITHOUT decoding
  // escapes: the shadow of `$'\x68'cloud ECS DeleteServers` still carries
  // 'deleteservers', so an expansion-bearing line with a write-op vocabulary
  // hit denies even when the cloud-CLI marker itself was destroyed (#927
  // audit: v2 and main both allowed this class before — the sibling
  // operation-token form `$'\x43'reateServers` was already denied).
  const writeVocabHit = DEFAULT_POLICY.writeOperationPrefixes.some((prefix) =>
    new RegExp(`(^|[^a-z])${prefix}`, 'i').test(shadowText),
  );
  if (
    (/(^|[^a-z0-9.-])(?:huaweicloud-devkit|setup-cli\.(?:js|mjs|ts|cjs)|setup\.cjs)|(^|[^a-z0-9.-])hcloud(\.exe)?\s/i.test(
      shadowText,
    ) ||
      /secret:\/\//i.test(shadowText) ||
      writeVocabHit) &&
    /\$['"]|\$\(|`/.test(text)
  ) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason:
        'An obfuscated cloud CLI invocation (shell expansion inside the command) is blocked. Write the command in plain form; secret refs and subcommands must be literal.',
    };
  }

  // The env-dump family: trailing boundary so `environment.md` /
  // `env_setup.py` do not match; the HW_ token is SUFFIX-scoped to the
  // documented credential names so `env HW_REGION=x hcloud …` (a region
  // assignment, not a credential) stays legitimate; HCLOUD_ underscored so
  // the KooCLI bin name does not false-match; HUAWEICLOUD excludes the
  // `-devkit` suffix so the devkit bin name does not feed the family token;
  // `export -p` and `declare`/`typeset` are dump forms of the same class.
  const CRED_ENV_NAMES =
    '(?:HUAWEICLOUD(?!-devkit)|HWC_|HCLOUD_|OS_|HW_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY))';
  if (
    /(^|\s)(env|printenv|export\s+-p|declare|typeset|set|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:)(?![A-Za-z0-9_-])/i.test(
      shadowText,
    ) &&
    new RegExp(CRED_ENV_NAMES, 'i').test(shadowText)
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Dumping cloud credential environment variables is blocked.',
    };
  }

  // Argument-less full-dump forms — at COMMAND POSITION (start of the
  // payload or after a separator), so `make env` / `rg env` stay legitimate:
  // env/printenv/export/declare/typeset take flags; bare `set` dumps, but
  // `set -e`/`set -o pipefail` set shell options and dump nothing, so only
  // the flagless form denies. A following pipe or redirect means the dump
  // leaves the process either way.
  if (
    /(?:^|[;&|\n\r)]|\|\||&&)\s*(?:env|printenv|export|declare|typeset)(?![A-Za-z0-9_-])(?:\s+(?:--?[A-Za-z0-9-]+(?:=[^ ]*)?|-u\s+\S+))*(\s*[|>].*)?\s*$/i.test(
      shadowText,
    ) ||
    /(?:^|[;&|\n\r)]|\|\||&&)\s*set\s*$/i.test(shadowText) ||
    /(?:^|[;&|\n\r)]|\|\||&&)\s*(?:env|printenv|set)(?![A-Za-z0-9_-])\s*(?:\||>)/i.test(shadowText)
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Dumping the full process environment is blocked (it includes cloud credential variables).',
    };
  }

  // Credential variable references bypass the env-command gate above: HW_ is
  // the plugin's own documented credential prefix (HW_ACCESS_KEY/HW_SECRET_KEY/
  // HW_SECURITY_TOKEN), cloud environments also expose the AWS-style
  // HUAWEICLOUD_SECRET_ACCESS_KEY spelling (#770), and `echo $HW_SECRET_KEY` /
  // `printenv HW_ACCESS_KEY`
  // previously fell through to allow (#650 D4-2).
  //
  // The negative lookbehind exempts literal-NAME references — backslash-escaped
  // (`\$HW_*`) or single-quoted (`'$HW_*'`, which the shell never expands) —
  // while unescaped `$HW_*` is a potential expansion/dump regardless of the
  // command. No command-name whitelist, so no false negative (#650 review).
  // The $-expansion alternative stays on RAW text with its lookbehind: a
  // single-quoted '$HW_*' is a literal the shell never expands, so the
  // exemption is deliberate. The printenv alternative is a command-name
  // gate, so it runs on the shadow — quoting a command name does not stop
  // execution — and matches the credential name at ANY argument position.
  // Single-quoted spans are removed before the expansion test: the shell
  // never expands inside them, but a CLOSING quote before an unquoted $HW_
  // (`echo 'a'$HW_SECRET_KEY`) still expands — a char-level lookbehind
  // wrongly exempted that.
  const unSingleQuoted = text.replace(/'[^']*'/g, '');
  if (
    /(?<!['\\])\$\{?(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY)/i.test(
      unSingleQuoted,
    ) ||
    /(?:^|\s)printenv\s+.*(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY)/i.test(
      shadowText,
    )
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Printing cloud credential environment variables is blocked.',
    };
  }

  // Secret-retrieval vocabulary on the raw text AND the quote-stripped
  // shadow — the py hook searches both (a quote-mangled `show'secret'`
  // token is still a secret read), so the layers must agree. This check
  // runs BEFORE the hcloud routing return so a compound payload with
  // mangled vocabulary in a non-hcloud trailing segment (py's whole-payload
  // shadow) cannot slip past the TS face.
  if (SECRET_TEXT_RE.test(text) || SECRET_SHADOW_RE.test(shadowText)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value retrieval patterns are blocked.',
    };
  }

  // Routing on the shadow with a boundary class that admits `/`, `(`, and
  // backtick before the bin: path-qualified (`/usr/bin/hcloud`) and
  // substituted (`$(hcloud …)`) invocations must reach classification, not
  // just whitespace-preceded bare names. The bin's TAIL accepts closers
  // (`&('hcloud')`, `(hcloud)`) as well as whitespace. The RAW text is
  // tested too: the shadow strips quotes and backslashes, which GLUES the
  // bin into the preceding word (`cmd /c"hcloud …`, `C:\hcloud.exe …`)
  // and defeats the boundary class there, while the raw text still
  // carries the boundary character itself. A BROAD tail (also `;`, `&`,
  // `|`, `>`, and end-of-string) routes `… | xargs hcloud;` /
  // `xargs hcloud>` — py's per-segment gate denies those; the empty-args
  // fail-closed stays gated on the NARROW tail so the pinned bare
  // `hcloud` / `sudo hcloud` allows survive.
  const narrowRouted =
    /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"]/i.test(shadowText) ||
    /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"]/i.test(text);
  const broadRouted =
    /(^|[^a-z0-9.-])hcloud(\.exe)?([\s)\]}'";&|>]|$)/i.test(shadowText) ||
    /(^|[^a-z0-9.-])hcloud(\.exe)?([\s)\]}'";&|>]|$)/i.test(text);
  if (broadRouted) {
    return classifyHcloudArgs(splitSimpleCommand(text), {
      ...options,
      rawCommand: text,
      _narrowRouted: narrowRouted,
    });
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

export function assertAllowed(result: RiskDecision): RiskDecision {
  if (result.decision === 'deny') {
    // Fresh Error we immediately augment; the cast names the shape we attach.
    const error = new Error(result.reason) as Error & { policy: RiskDecision };
    error.policy = result;
    throw error;
  }
  return result;
}
