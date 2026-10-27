// OBS command knowledge for the KooCLI execution path, extracted from the
// hcloud-cli monolith (the stable src/hcloud-cli.ts face re-exports
// redactArgsWithObs): which obsutil-style subcommands are write-capable
// (the planning hint), and the extra arg redaction standalone credential
// flags need.

import { redactSecrets } from './safety-policy.ts';

const OBS_WRITE_SUBCOMMANDS = new Set([
  'mb',
  'cp',
  'mv',
  'rm',
  'chattri',
  'restore',
  // KooCLI 7.3.12 write-capable additions (-method based, except
  // custom-domain which writes via -cname/certificate options), plus the
  // full-name put/delete public-access-block writes.
  'bucket-tagging',
  'object-tagging',
  'encryption',
  'custom-domain',
  'mirror-back-to-source',
  'put-public-access-block',
  'delete-public-access-block',
  'abort',
  'archive',
  'create-share',
  'update',
]);

// Planning-time warning for write-class OBS batches (consumed by the plan
// module; not part of the face's public surface).
export function obsWriteHint(args: unknown): string | null {
  if (!Array.isArray(args) || args.length < 2) return null;
  if (String(args[0]).toUpperCase() !== 'OBS') return null;
  if (!OBS_WRITE_SUBCOMMANDS.has(String(args[1]).toLowerCase())) return null;
  return 'OBS write operations are obsutil-style and always write-class. Before executing, present the full resource manifest (bucket/object list) to the user for ONE batch approval, then run each command through plan → approve (see huawei-iac skill, Provisioning Rules).';
}

// Redact executed args for MCP-visible output. Besides the generic key=value
// redaction (--cli-access-key=...), obsutil-style standalone credential flags
// (-i AK / -k SK / -t TOKEN) carry the temporary STS as following array elements,
// which redactSecrets can't match. We scrub those explicitly.
export function redactArgsWithObs(rawArgs: unknown): string[] {
  const arr = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  const out = [...arr];
  for (let i = 0; i < out.length; i += 1) {
    // The loop condition bounds i; out[i] is defined.
    const arg = out[i]!;
    if (arg === '-i' || arg === '-k' || arg === '-t') {
      if (i + 1 < out.length) out[i + 1] = '<redacted>';
      i += 1;
    } else if (/^-i[A-Za-z0-9]/.test(arg)) {
      out[i] = '-i<redacted>';
    } else if (/^-k[A-Za-z0-9]/.test(arg)) {
      out[i] = '-k<redacted>';
    } else if (/^-t[A-Za-z0-9]/.test(arg)) {
      out[i] = '-t<redacted>';
    }
  }
  // redactSecrets maps arrays element-wise; the per-string overload keeps the
  // result honestly typed as string[].
  return out.map((item) => redactSecrets(item));
}
