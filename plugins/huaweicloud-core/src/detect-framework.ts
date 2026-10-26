// Stable public face of the detect-framework subsystem. The internals live
// in the src/detect-framework-* family (the frameworks spec table, the
// package/project readers, the single-project spec matcher, and the scan
// orchestration with sub-app discovery and command patching); this module
// is the re-export seam every consumer imports — same exported names, same
// import path, same behavior (the safety-policy.ts precedent).

export { detectFramework, type SubApp, type FrameworkDetection } from './detect-framework-scan.ts';
