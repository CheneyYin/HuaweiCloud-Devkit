import { asText } from '../lib/as-text.ts';
import { DEFAULT_POLICY, type Policy } from './default-policy.ts';
import { matchesAny } from './policy.ts';
import { stripShellQuotes } from './shell-text.ts';

// Credential-file path gate for non-Bash faces: the MCP `secret_set`
// channel=file reads a path directly, with no hook between the request and
// the read — the Bash-face credentialFilePatterns deny must apply there
// too, or the tool launders a hook-denied credential file into the vault.
// Tests the raw path AND its quote-stripped shadow (same evasion class as
// the text gate).
function normalizePathText(value: string): string {
  return value.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
}

export function credentialFileCandidates(text: string): string[] {
  const shadow = stripShellQuotes(text);
  return [text, shadow, normalizePathText(text), normalizePathText(shadow)];
}

export function isCredentialFilePath(path: unknown, policy: Policy = DEFAULT_POLICY): boolean {
  const value = asText(path || '');
  if (!value) return false;
  return credentialFileCandidates(value).some((candidate) => matchesAny(candidate, policy.credentialFilePatterns));
}
