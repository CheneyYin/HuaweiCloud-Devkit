// Stable public face of the credential subsystem. The internals live in the
// src/auth family (the S1 store, the R11 placeholder policy, the CodeArts
// context reader, the STS expiry derivation, the OBS config writer, the
// resolution tiers with the #900 missing-credential error, and the runtime
// override); this module is the re-export seam every consumer imports — same
// exported names, same import path, same behavior (the safety-policy.ts
// precedent).

// The S1 store family (the JSON vault on disk, secret-ref resolution, the
// last-sync sidecar, backup/restore) and the R11 placeholder policy.
export {
  globalCredentialsPath,
  readGlobalCredentials,
  resolveStoredRefs,
  readGlobalCredentialsResolved,
  readGlobalCredentialsStrict,
  writeGlobalCredentials,
  setConfiguredBySession,
  lastSyncPath,
  readLastSync,
  writeLastSync,
  backupGlobalCredentials,
  restoreGlobalCredentialsBackup,
  type StoredCredentials,
  type WriteGlobalCredentialsInput,
  type LastSyncRecord,
  type LastSyncMetadata,
  type StrictS1Read,
} from './s1-store.ts';
export { isPlaceholder } from './credential-placeholder.ts';

// The CodeArts context reader, the STS expiry derivation, and the OBS config
// writer.
export {
  getParentCwd,
  isCodeArtsContext,
  readCodeArtsCredentials,
  pickDevkitMcpServer,
  type CodeArtsCredentials,
} from './codearts-context.ts';
export { parseStsExpiry, type StsExpiryInput } from './sts-expiry.ts';
export { obsConfigPath, writeObsConfig, type WriteObsConfigInput } from './obs-config.ts';

// The resolution tiers (env > CodeArts > S1-with-refs, with the R9/STS
// precedence rules) and the session-scoped runtime credential override.
export { resolveCredentials, type ResolvedCredentials, type ResolveCredentialsOptions } from './credential-resolver.ts';
export {
  setRuntimeCredentials,
  clearRuntimeCredentials,
  hasRuntimeCredentials,
  resolveCredentialsWithRuntime,
} from './runtime-credentials.ts';
