import { expandWords } from './feeder.ts';

// The xargs child's own argv: which tail tokens are placeholders (filled
// from stdin) and where the redirection boundary sits — everything after
// it is marker payload or heredoc body, which joins the feeder words
// instead of the argv.

// Placeholders: the literal {} / % runs AND the declared -I/--replace
// value (any replstr spelling) — stdin tokens fill those positions.
function declaredReplstr(tokens: string[]): string | null {
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
}

// Redirection tokens are not argv — input (`<<<`, `<`, glued `<<<Delete`),
// output (`>`, `>>`, `2>`, `1>`, `>&2`, `2>&1`), and heredoc markers
// (`<<EOF`, `<< EOF`) — and the words after a herestring/heredoc already
// joined the feeder. Keep them out of the own-args or they occupy the
// operation slot (`echo Delete | xargs hcloud ECS > /dev/null`).
function isRedirectToken(t: string): boolean {
  return (
    t === '<' ||
    /^0+$/.test(t) ||
    /^0+<$/.test(t) ||
    /^(?:\d*)>+<?&?/.test(t) ||
    /^0*<{3,}/.test(t) ||
    /^0*<<-?(?!<)/.test(t)
  );
}

export function xargsChildArgs(
  unwrapped: string[],
  tokens: string[],
  baseFeeder: string[],
): { ownArgs: string[]; feeder: string[] } {
  const replstr = declaredReplstr(tokens);
  const placeholders = new Set(
    unwrapped
      .slice(1)
      .filter((token) => /^[{}%]+$/.test(String(token)) || (replstr !== null && String(token) === replstr)),
  );
  const redirAt = unwrapped.slice(1).findIndex((token) => isRedirectToken(String(token)));
  const ownTail = redirAt < 0 ? unwrapped.slice(1) : unwrapped.slice(1, redirAt + 1);
  let feeder = baseFeeder;
  // A glued herestring payload (`<<<Delete`) and a heredoc body (words
  // between the marker and the delimiter) join the feeder.
  if (redirAt >= 0) {
    const marker = String(unwrapped[redirAt + 1] ?? '');
    const restTokens = unwrapped.slice(redirAt + 2).map(String);
    if (/^0*<{3,}/.test(marker)) {
      feeder = [...feeder, ...expandWords([marker.replace(/^0*<{3,}/, ''), ...restTokens])];
    } else if (/^0*<<-?/.test(marker)) {
      // Glued delimiter (`<<EOF`): the body runs until the delimiter word
      // repeats; spaced (`<<` + delim token): skip the declared delimiter
      // token first.
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
  return { ownArgs, feeder };
}
