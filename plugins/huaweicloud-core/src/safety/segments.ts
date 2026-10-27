import { DEFAULT_POLICY } from './default-policy.ts';
import { collectFeederWords, segmentBearsXargs } from './feeder.ts';
import { hasWritePrefix } from './policy.ts';
import { segmentScriptOf } from './script-stream.ts';
import { unwrapSecretExecWrapper } from './secret-exec.ts';
import { splitShellSegments, splitSimpleCommand } from './shell-text.ts';
import { unwrapSkillQualityCli } from './skill-quality-cli.ts';
import { basenameOf, COMMAND_POSITION_PREFIXES, isHcloudToken, OBSUTIL_WRITES, skipPrefixArguments } from './tokens.ts';
import { unwrapWithWindowsFlag } from './unwrap.ts';
import { hcloudPieceAt } from './windows-rebase.ts';
import { xargsChildArgs } from './xargs-argv.ts';

// Find hcloud-leading command segments: quote/heredoc-aware splitting
// (splitShellSegments), tokenization per segment, and command-position
// unwrapping before the leading-hcloud check. Two recursions keep nested
// and fed payloads classifiable: (a) a quoted `bash -c`/`eval` argument is
// itself a script — its separators are live commands, so the argument is
// re-scanned (depth-capped); (b) an `xargs hcloud …` segment draws its
// arguments from the PRECEDING piped segment, so those tokens are merged
// in as candidate operation words.
export function findHcloudCommandSegments(
  text: unknown,
  depth = 0,
  inheritedFeeder: string[] | null = null,
): string[][] {
  const segmentSeps: string[] = [];
  const scannerSegments = splitShellSegments(String(text), segmentSeps);
  const out: string[][] = [];
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
      // script from segmentScriptOf's head check — probe PAST the
      // prefixes (and their value flags) so the nested segment/feeder
      // semantics fire.
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
        const nested = segmentScriptOf(candidate);
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
    const hadXargs = segmentBearsXargs(tokens, unwrappedRaw);
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
      const baseFeeder = collectFeederWords(
        scannerSegments,
        segmentSeps,
        s,
        tokens,
        herestringAt,
        trailingRedirect,
        inheritedFeeder,
      );
      const { ownArgs, feeder } = xargsChildArgs(unwrapped, tokens, baseFeeder);
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
