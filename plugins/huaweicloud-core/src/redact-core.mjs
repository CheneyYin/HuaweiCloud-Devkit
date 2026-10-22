// Single-source string-path credential redaction. Two consumers must never
// drift again: safety-policy (redactString, the recursive object+string
// redactor behind redactSecrets) and risk-rule-engine (redactEvidence, the
// risk-finding evidence scrubber). Before this module the evidence path
// lacked api_key entirely, and NEITHER tolerated quoted JSON/Python-dict
// keys ("api_key": "…" — the closing quote between key and separator broke
// the key[:=] alignment, and the one-time agentarts memory api_key rode
// tool output unmasked; findings trap 27).

// Key tokens. The string path renders each as a separator-optional,
// case-insensitive fragment (access_key -> access[_-]?key, which also
// matches camelCase accessKey). Every token must ALSO be classified by the
// object path (isSecretKeyName via policy.json secretKeyNamePatterns or its
// hardcoded classes) — pinned behaviorally by test/safety-policy.test.mjs.
export const BLOB_KEY_TOKENS = ['user_data', 'metadata', 'private_key'];
export const CREDENTIAL_KEY_TOKENS = [
  'access_key',
  'secret_key',
  'api_key',
  'x_api_key',
  'security_token',
  'x_auth_token',
  'token',
  'authorization',
  'password',
  'passwd',
  'admin_pass',
  'credential',
  'secret',
];
export const AKSK_KEY_TOKENS = ['ak', 'sk'];

const keyPattern = (tokens) => tokens.map((t) => t.replace(/_/g, '[_-]?')).join('|');

const BLOB = keyPattern(BLOB_KEY_TOKENS);
const CREDS = keyPattern(CREDENTIAL_KEY_TOKENS);

// A quoted value may itself be backslash-escaped when the whole document is
// embedded as a JSON string value (invoke/FunctionGraph results):
// \"api_key\": \"…\". One escape level is tolerated on the quotes, and the
// quoted bodies match internal escape pairs ("a\"b").
const VALUE = '(\\\\?"(?:[^"\\\\]|\\\\.)*\\\\?"|\\\\?\'(?:[^\'\\\\]|\\\\.)*\\\\?\'|[^\\s,;]+)';

export function redactCredentialShapes(text) {
  return (
    String(text)
      // Opaque blob keys (cloud-init user_data, metadata, private_key) carry
      // base64/scripts that may embed SSH keys, DB passwords, bootstrap
      // tokens. QUOTED form: the value is a quoted string — redact exactly
      // it and let mid-JSON neighbors on the same line survive.
      .replace(new RegExp(`((["'])(?:${BLOB})\\2\\s*[:=]\\s*)("[^"]*"|'[^']*')`, 'gi'), '$1<redacted>')
      // UNQUOTED blob form: redact the ENTIRE rest of the line — the value
      // has no reliable terminator.
      .replace(new RegExp(`((?:${BLOB})\\s*[:=]\\s*).*`, 'gi'), '$1<redacted>')
      // Credential-shaped keys. The backreferenced quote pair tolerates
      // JSON/Python-dict keys and one backslash escape level.
      .replace(new RegExp(`(\\\\?["']?)(${CREDS})\\1(\\s*[:=]\\s*)(${VALUE})`, 'gi'), '$1$2$1$3<redacted>')
      // Bare AK/SK prefixes (agentarts/SDK CLIs print `ak: value` shapes);
      // same quote and escape tolerance. Keeps the historical separator
      // normalization to '='.
      .replace(new RegExp(`(\\\\?["']?)\\b(ak|sk)\\b\\1(\\s*[:=]\\s*)(${VALUE})`, 'gi'), '$1$2$1=<redacted>')
  );
}
