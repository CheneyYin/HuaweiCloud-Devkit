import { matchesBinName } from './tokens.ts';

// The devkit's own `secret exec` wrapper: a runner (npx/pnpm/yarn/node)
// launching the bin — bare, path-qualified, with an extension
// (.js/.cjs/.mjs/.ts/.exe) or an npx version spec (huaweicloud-devkit@latest)
// — then `secret exec [flags] -- <child>`. Unwrapped so an embedded hcloud
// child keeps the classification bare hcloud would get — the wrapper must
// not launder the write gate. The scan covers EVERY token (a devkit bin
// earlier in the line that is not an exec invocation — `secret list && …` —
// only skips that position, never aborts the scan) and does not stop at a
// `--` boundary (npm's own separator legitimately precedes the bin:
// `npx -- huaweicloud-devkit …`).
const DEVKIT_BIN_NAMES = [
  'huaweicloud-devkit',
  'huaweicloud-devkit.js',
  'huaweicloud-devkit.cjs',
  'huaweicloud-devkit.mjs',
  'huaweicloud-devkit.ts',
  'huaweicloud-devkit.exe',
  'setup-cli.js',
  'setup-cli.mjs',
  'setup-cli.ts',
  'setup.cjs',
] as const;

export function unwrapSecretExecWrapper(args: string[]): string[] | null {
  for (let i = 0; i + 2 < args.length; i++) {
    if (!matchesBinName(String(args[i]), DEVKIT_BIN_NAMES)) continue;
    // npm's own separator may sit between the bin and the subcommand
    // (`npm exec huaweicloud-devkit -- secret exec …`); skipping `--`
    // tokens here is safe — the devkit CLI itself takes no `--` before its
    // subcommand, so a literal `-- secret get` spelling is not a reveal,
    // and denying it is the safe direction anyway.
    let j = i + 1;
    while (String(args[j]) === '--') j++;
    if (String(args[j]).toLowerCase() !== 'secret' || String(args[j + 1]).toLowerCase() !== 'exec') continue;
    const dd = args.indexOf('--', j + 2);
    if (dd < 0 || dd + 1 >= args.length) continue;
    return args.slice(dd + 1);
  }
  return null;
}
