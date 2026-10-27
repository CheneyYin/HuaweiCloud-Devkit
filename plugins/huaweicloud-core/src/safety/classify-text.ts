import { asText } from '../lib/as-text.ts';
import type { RiskDecision } from '../risk-rule-engine.ts';
import { classifyHcloudArgs } from './classify-hcloud.ts';
import { credentialFileCandidates } from './credential-path.ts';
import { DEFAULT_POLICY } from './default-policy.ts';
import { matchesAny, type ClassifyOptions } from './policy.ts';
import { applyRawCommandRiskRules } from './risk-merge.ts';
import { decodeAnsiCSpans, splitSimpleCommand, stripShellQuotes } from './shell-text.ts';
import { OBSUTIL_WRITES } from './tokens.ts';
import { SECRET_SHADOW_RE, SECRET_TEXT_RE } from './vocabulary.ts';

export function classifyTextCommand(command: unknown, options: ClassifyOptions = {}): RiskDecision {
  const policy = options.policy || DEFAULT_POLICY;
  const text = asText(command || '');
  const shadowText = stripShellQuotes(text);
  // The cap counts BYTES on both twins (interrogate round 5): UTF-16 units
  // (TS) vs code points (py) disagreed at the boundary on astral-plane
  // padding — the same payload denied on one layer and allowed on the
  // other. Bytes are also the honest reading of "256 KiB payload".
  const textBytes = Buffer.byteLength(text, 'utf8');
  // Continuation-dropped text (interrogate round 6): bash removes the
  // \<newline> pair BEFORE tokenization, reassembling `$'`/`$(`/backtick
  // across the break — the raw text of `h$\<LF>'\x63'loud …` carries only
  // `$\`, so every raw-text expansion check and the decode must run on the
  // reassembled form or a composed mangled write sails through. Dropping
  // pairs can only ever CREATE markers (a real `$'` survives the drop
  // untouched), so the dropped form subsumes the raw one.
  const contDropped = text.replace(/\\\n/g, '');

  // Length cap: a routed payload past 256 KiB cannot execute through any
  // wrapper chain (MAX_ARG_STRLEN), and classifying pathological nests
  // at that size costs minutes — a hook DoS. Denied fail-closed instead.
  // An EXPANSION-BEARING over-cap payload denies too (interrogate rounds
  // 5-6): the marker check runs on the continuation-dropped text (a single
  // linear scan) — no legitimate oversized expansion-bearing Bash payload
  // exists, and the round-4 decode skip must not make the over-cap slice
  // the one place a mangled write sails through.
  if (textBytes > 262_144) {
    if (
      /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"]/i.test(shadowText) ||
      /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"]/i.test(text) ||
      /\$['"]|\$\(|`/.test(contDropped)
    ) {
      return {
        decision: 'deny',
        risk: 'invalid',
        reason: 'Command payload too large to classify safely; denied fail-closed.',
      };
    }
  }
  // The ANSI-C-decoded shadow (interrogate round 3): the argv letters `$'…'`
  // spans build, reconstructed — `h$'\x63'loud` is the `hcloud` the shell
  // executes. Presence gates below that bear on cloud-command or
  // secret-reveal detection search BOTH shadows; with no `$'` span the
  // decoded candidate is the original text. Decoded from the
  // CONTINUATION-DROPPED text (round 6: the pair removal is part of bash's
  // own first pass, and the decode's outside-quote backslash branch would
  // otherwise consume the `\` of a composed `$\<LF>'` without opening the
  // span). Computed AFTER the length cap and skipped for over-cap payloads
  // (round 4: an unrouted 10 MB escape flood must not pay the decode's
  // linear pass — and the expansion-bearing cap deny above closes the
  // skip's mangled-write window at the same size).
  const decodedShadowText = textBytes > 262_144 ? shadowText : stripShellQuotes(decodeAnsiCSpans(contDropped));
  const shadowCandidates = [shadowText, decodedShadowText];

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
  // against the quote-stripped shadow (both candidates — the decoded one
  // catches ANSI-C-mangled subcommand spellings) so quoted forms
  // (`secret 'get'`) do not slip past.
  if (shadowCandidates.some((candidate) => matchesAny(candidate, policy.blockedSecretCliPatterns))) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason:
        'Printing vault secrets into the agent context is blocked. Run the value consumer instead: npx huaweicloud-devkit secret exec --env NAME=secret://<scope>/<name> -- <command> — a child you trust not to print its own environment, since its stdout is this conversation. Or use secret get --file from your own terminal.',
    };
  }

  // Order-independent reveal pair: `echo secret get <ref> --stdout | xargs
  // npx huaweicloud-devkit` reorders the argv through xargs while every word
  // is literal in the text — the patterns above assume bin-before-
  // subcommand order. Any payload carrying BOTH a devkit bin and a
  // `secret get` pair is a reveal regardless of order (both shadow
  // candidates — the decoded one catches ANSI-C-mangled spellings).
  if (
    shadowCandidates.some((candidate) =>
      /(^|[^a-z0-9.-])(?:huaweicloud-devkit|setup-cli\.(?:js|mjs|ts|cjs)|setup\.cjs)/i.test(candidate),
    ) &&
    shadowCandidates.some((candidate) => /(?:^|\s)secret\s+get\b/i.test(candidate))
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
  //
  // Interrogate round 3 adds the DECODED candidate (decodeAnsiCSpans): the
  // gate now also sees the argv letters the escapes actually build —
  // mangling past the marker (h$'\x63'loud $'\x4f'BS rm: no 'cloud', no
  // 'OBS' in the stripped shadow) can no longer hide the bin, the service
  // token, or the operation word, and mangled READS deny too (deny rather
  // than parse — the same verdict an op-mangled read with a literal bin
  // already gets; the #727 doctrine). The vocabulary itself: the policy
  // writeOperationPrefixes (this clause's pre-existing DEFAULT_POLICY read,
  // not options.policy), plus the OBS subcommand words in a MARKER-GATED
  // arm — the OBS TOKEN is the marker (word-bounded, also matches `obs://`);
  // a bare `cloud` substring was the round-2 marker and denied routine
  // huaweicloud-bearing PATHS, so it is gone — the decoded bin clause
  // carries the mangled-bin class instead. The py twin gates the same way.
  // An EMPTY prefix list cannot occur from the shipped policy (structure
  // guard floors it at >= 10) and loadPolicy now throws on a present-but-
  // empty list; the length arm mirrors the py WRITE_VOCAB_RE is-None arm
  // for any caller hand-feeding such a policy anyway. Residual, recorded:
  // the TS write gate itself (hasWritePrefix over []) stays fail-open on
  // that same abnormal shape when passed via options.policy — pre-existing
  // on main and v2, out of this fix's surface; command substitution
  // (`$(printf '\x68…')`) stays opaque to the decode — the OBS-token arm
  // still catches the service-token-literal form.
  const cloudCommandBearing = shadowCandidates.some(
    (candidate) =>
      /(^|[^a-z0-9.-])(?:huaweicloud-devkit|setup-cli\.(?:js|mjs|ts|cjs)|setup\.cjs)|(^|[^a-z0-9.-])hcloud(\.exe)?\s/i.test(
        candidate,
      ) || /secret:\/\//i.test(candidate),
  );
  const writeVocabHit =
    DEFAULT_POLICY.writeOperationPrefixes.length === 0 ||
    shadowCandidates.some((candidate) =>
      DEFAULT_POLICY.writeOperationPrefixes.some((word) => new RegExp(`(^|[^a-z])${word}`, 'i').test(candidate)),
    ) ||
    (shadowCandidates.some((candidate) => /\bOBS\b/i.test(candidate)) &&
      shadowCandidates.some((candidate) =>
        [...OBSUTIL_WRITES].some((word) => new RegExp(`(^|[^a-z])${word}`, 'i').test(candidate)),
      ));
  // The right conjunct runs on the CONTINUATION-DROPPED text (round 6): a
  // composed `$\<LF>'` carries the marker only after the pair drop, and the
  // drop never destroys a real one.
  if ((cloudCommandBearing || writeVocabHit) && /\$['"]|\$\(|`/.test(contDropped)) {
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
  // leaves the process either way. The flags alternation is deliberately
  // unambiguous: the long-flag branch carries (?!u\s) so a bare `-u` can
  // ONLY parse through the `-u <value>` branch — the two-branch overlap on
  // `-u ...` chains was exponential backtracking on failing tails
  // (CodeQL js/inefficient-regular-expression; measured: 26 repetitions of
  // ' -u -- ' took 14.3s, 28 took >120s pre-fix, 5000 take 1ms post-fix).
  // The python twin (hooks/huaweicloud-safety.py ARGLESS_DUMP_RE) must stay
  // structurally identical — hook-parity.test.ts pins the shared verdicts.
  if (
    /(?:^|[;&|\n\r)]|\|\||&&)\s*(?:env|printenv|export|declare|typeset)(?![A-Za-z0-9_-])(?:\s+(?:-u\s+\S+|--?(?!u\s)[A-Za-z0-9-]+(?:=[^ ]*)?))*(\s*[|>].*)?\s*$/i.test(
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
