// The installer's payload machinery: the file operations every per-agent
// deploy shares, the server payload (dist + safety + skills) placement, and
// the native core-skill disclosure seam. The table-consuming orchestration
// (nativeSkillDirs and friends) takes the PAYLOAD_TARGETS rows as a
// parameter so this module stays a leaf — the dispatch layer owns the table.
//
// Stable public face of the payload family (the safety-policy precedent):
// same exported names, same import path, same behavior. The internals live
// in the src/payload-* siblings — the layout roots + shared utils, the
// verified file ops, the server-payload placement, the skills-roster
// readers, the native-disclosure sync and cleanup families, the runtime-deps
// installer, and the status + residue family. No sibling imports the face.

// The layout roots + version + small shared utils (the one-climb root-level
// derivation, the deploy word, the error/sleep helpers).
export {
  PLUGIN_ROOT,
  PACKAGE_ROOT,
  pkgVersion,
  errorMessage,
  sleepSync,
  deployWord,
  type DeployMode,
} from './payload-utils.ts';

// The verified file operations (the retrying size-checked copy, the
// recursive dir copy, the stale-name prune, the #556 retrying removal).
export { copyFileVerified, mcpServerInstalled, copyDir, pruneStale, removeIfExists } from './payload-files.ts';

// The server-payload placement (the #758 agent-rules injection, the loud
// missing-source aborts, the `.installed` restart marker).
export { copyServerPayload } from './payload-placement.ts';

// The skills-roster readers (the ownership manifest, the expected roster,
// the core-pack name sets).
export {
  devkitOwnedSkillNames,
  shippedSkillRoster,
  tryCoreSkillNames,
  coreSkillNames,
  payloadCoreNames,
} from './payload-roster.ts';

// The native-disclosure placement family (the rows shape, the managed and
// scanned dir derivations, the per-target dispatch, the per-dir sync).
export {
  nativeSyncDirs,
  nativeSkillDirs,
  syncNativeSkillsForTarget,
  syncNativeCoreSkills,
  type NativeSyncRow,
} from './payload-native-sync.ts';

// The native-disclosure cleanup family (the pre-install reconcile and the
// receipt-gated uninstall removals).
export { cleanupNativeDirs, removeHuaweiCommandsFrom, removeOwnedSkillsFrom } from './payload-native-clean.ts';

// The runtime-deps installer (the npm spawn with the file-lock retry ladder).
export { installRuntimeDeps } from './payload-runtime-deps.ts';

// The status + residue family (the server-data skill listing, the payload
// triple lines, the empty-skills-dir removal).
export { serverSkillDirNames, serverSkillCount, payloadStatusLines, removeSkillsDirIfEmpty } from './payload-status.ts';
