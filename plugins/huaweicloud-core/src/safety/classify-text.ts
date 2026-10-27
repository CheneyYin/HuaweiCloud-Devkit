import { asText } from '../lib/as-text.ts';
import type { RiskDecision } from '../risk-rule-engine.ts';
import { classifyHcloudArgs } from './classify-hcloud.ts';
import { credentialFileCandidates } from './credential-path.ts';
import { DEFAULT_POLICY } from './default-policy.ts';
import { matchesAny, type ClassifyOptions } from './policy.ts';
import { applyRawCommandRiskRules } from './risk-merge.ts';
import { splitSimpleCommand, stripShellQuotes } from './shell-text.ts';
import { OBSUTIL_WRITES } from './tokens.ts';
import { SECRET_SHADOW_RE, SECRET_TEXT_RE } from './vocabulary.ts';

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
  //
  // The vocabulary itself: the policy writeOperationPrefixes UNIONED with
  // OBSUTIL_WRITES (the py twin's load_policy union, interrogate round 1) —
  // routing dies with the keyword under ANSI-C mangling, so this vocab is
  // the only layer that can fire, and non-prefix obsutil subcommand writes
  // (rm/cp/mv/sync/chattri…) mangle exactly like the prefix operations. An
  // EMPTY prefix list is an abnormal, hand-mangled policy (the shipped one
  // is structure-floored at >= 10): treated as a hit so the clause fails
  // CLOSED, mirroring the py WRITE_VOCAB_RE is-None arm. Residual,
  // recorded: the TS write gate itself (hasWritePrefix over []) stays
  // fail-open on that same abnormal shape — pre-existing on main and v2,
  // out of this fix's surface.
  const writeVocabHit =
    DEFAULT_POLICY.writeOperationPrefixes.length === 0 ||
    [...DEFAULT_POLICY.writeOperationPrefixes, ...OBSUTIL_WRITES].some((word) =>
      new RegExp(`(^|[^a-z])${word}`, 'i').test(shadowText),
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
