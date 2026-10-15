// The native-disclosure receipt: the ownership memory for the core
// meta-skill copies an agent's native skill dir carries. One module, two
// consumers — the setup CLI (source import) and bin/dsh-postinstall.cjs
// (dynamic import of the compiled dist copy) — so the two writers of the
// same file can never drift on its state machine: the shape-broken boundary
// (parsable JSON, non-array names) is classified identically everywhere.
// Zod-free so every consumer graph can import it.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const NATIVE_RECEIPT_NAME = '.huaweicloud-devkit-native.json';

export function nativeReceiptPath(dir: string): string {
  return join(dir, NATIVE_RECEIPT_NAME);
}

export interface NativeReceipt {
  /** Core skill names this devkit placed in the dir (shape-validated on read). */
  names: string[];
  /** Which maintainer wrote the receipt: the setup CLI's plugin-dir sync or the DSH postinstall's package-root (marketplace) sync. */
  layout?: 'plugin-dir' | 'package-root';
  /** The npm package root the marketplace layout serves its payload from (layout 'package-root' only). */
  packageRoot?: string;
}

// ok = parsed and shape-valid (names filtered to the core-name shape);
// corrupt = present but torn or hand-mangled (the file's existence still
// proves devkit placement, so managed treatment — keep, warn, rewrite —
// applies); null = no receipt file (pre-MCP residue or a hand-placed copy).
export type NativeReceiptRead = { kind: 'ok'; receipt: NativeReceipt } | { kind: 'corrupt' } | null;

// Receipts only ever contained core skill names (huaweicloud-*), so only
// that shape earns delete rights; anything else in a tampered file is
// ignored, never deleted. Exported because the shape is part of the
// receipt contract: consumers that list possible leftovers (uninstall's
// corrupt-receipt warning) must not re-derive it and drift.
const CORE_NAME_SHAPE = /^huaweicloud-[a-z0-9-]*$/;

export function isCoreNameShape(name: string): boolean {
  return CORE_NAME_SHAPE.test(name);
}

// Control characters are stripped from packageRoot at READ time, the single
// point where the untrusted field enters every consumer: the value steers
// doctor's comparator, liveness probes, and terminal echoes, and an ESC
// sequence in it could forge [PASS]/[FAIL] lines in output. Built from
// fromCharCode because eslint's no-control-regex rightly flags control
// characters in regex literals. A real path containing control characters
// is not a path this devkit will follow — it degrades to the dead-maintainer
// handling, never to a redirected comparison.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

export function readNativeReceipt(dir: string): NativeReceiptRead {
  const receiptPath = nativeReceiptPath(dir);
  if (!existsSync(receiptPath)) return null;
  let parsed: { names?: unknown; layout?: unknown; packageRoot?: unknown } | null;
  try {
    parsed = JSON.parse(readFileSync(receiptPath, 'utf8')) as typeof parsed;
  } catch {
    return { kind: 'corrupt' };
  }
  // A parsable-but-shape-broken receipt is a torn or hand-mangled write:
  // corrupt, not "healthy with no names" — classifying it as ok would
  // silently drop the retired-name memory this file exists to carry.
  if (parsed === null || !Array.isArray(parsed.names)) return { kind: 'corrupt' };
  const receipt: NativeReceipt = {
    names: parsed.names.filter((n): n is string => typeof n === 'string' && CORE_NAME_SHAPE.test(n)),
  };
  if (parsed.layout === 'plugin-dir' || parsed.layout === 'package-root') receipt.layout = parsed.layout;
  // An absolute path only: packageRoot steers doctor's comparator and is
  // echoed into its output, so a relative or otherwise malformed value is
  // dropped rather than trusted. A dropped root degrades the receipt to a
  // root-less marketplace claim — consumers treat that as unverifiable
  // ownership (the hedged warnings), never as a redirected comparison.
  if (typeof parsed.packageRoot === 'string' && parsed.packageRoot.length > 0 && isAbsolute(parsed.packageRoot)) {
    receipt.packageRoot = parsed.packageRoot.replace(CONTROL_CHARS, '');
  }
  return { kind: 'ok', receipt };
}

export function writeNativeReceipt(dir: string, receipt: NativeReceipt): void {
  // Pid-suffixed temp: the setup CLI and dsh-postinstall are uncoordinated
  // writers on the same dir, and a shared .tmp path let one writer's rename
  // publish or lose the other's roster. renameSync publishes atomically, so
  // a crash can never leave a half-written receipt observable as "no
  // receipt" (which would demote a managed dir to residue treatment).
  const finalPath = nativeReceiptPath(dir);
  // The writer owns the dir: reclaim crashed predecessors' tmp files (any
  // pid's) in the same pass, so litter never accumulates across
  // installs/updates — no other actor sweeps them.
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(`${NATIVE_RECEIPT_NAME}.`) && entry.endsWith('.tmp')) {
        rmSync(join(dir, entry), { force: true });
      }
    }
  } catch {
    // best-effort: an unreadable dir cannot be swept, the write proceeds
  }
  const tmp = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n');
  renameSync(tmp, finalPath);
}
