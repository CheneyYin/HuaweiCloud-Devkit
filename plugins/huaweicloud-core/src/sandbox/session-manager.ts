// Stable public face of the sandbox session family. The internals live in the
// src/sandbox/ siblings; this module is the re-export seam every consumer
// imports — same exported names, same import path, same behavior:
//   devbridge-gateway.ts  — the DevBridge s2 gateway wire contract (tunnel
//                           domain, migration marker, gateway error bodies)
//   sandbox-output.ts     — stripTerminalEscapes, the single escape-stripping
//                           seam for sandbox output parsers (#946)
//   ws-exec-loader.ts     — the ws-exec barrel resolution across the three
//                           runtime layouts + the ws-exec structural shapes
//   hwlink-connection.ts  — workspace-id state, the terminal-session cache,
//                           the exec surfaces, tunnel sessions, close family
//   upload-file.ts        — the base64 single-file upload family
//   upload-transport.ts   — the file-server + HTTP-tunnel upload transport
//   upload-project.ts     — the project upload orchestration (archive, retry)
//   deploy-nginx.ts       — the nginx deploy family (ports, templates, verify)
//   deploy-check.ts       — the deploy-check script, parser, remediation
// devbridge-tunnel.ts keeps importing the DEVBRIDGE_* constants, execOneShot,
// and stripTerminalEscapes from this path (pinned by the structure guard);
// the sandbox siblings import each other's canonical modules directly.

// The DevBridge s2 gateway wire contract (tunnel domain, migration marker,
// gateway-level error bodies) lives in devbridge-gateway.ts; re-exported here
// as the stable public face (devbridge-tunnel.ts imports it from this path).
export {
  DEVBRIDGE_BAD_GATEWAY_MARKER,
  DEVBRIDGE_MIGRATION_MARKER,
  DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER,
  DEVBRIDGE_TUNNEL_DOMAIN,
  DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER,
} from './devbridge-gateway.ts';
// The single escape-stripping seam for sandbox output parsers (#946) lives in
// sandbox-output.ts; re-exported as the public face (devbridge-tunnel.ts and
// the upload/deploy parsers import it from this path).
export { stripTerminalEscapes } from './sandbox-output.ts';
// The ws-exec barrel loader and the ws-exec structural shapes live in
// ws-exec-loader.ts; resolveWsExecIndexUrl is re-exported as the public face.
export { resolveWsExecIndexUrl } from './ws-exec-loader.ts';
// The hwlink connection layer (workspace-id state, session cache, exec
// surfaces, close family) lives in hwlink-connection.ts; re-exported as the
// public face (packs/sandbox/tools.ts and the tests import these names here).
export {
  closeAllSessions,
  closeSession,
  execOneShot,
  execWithSession,
  getCurrentWorkspaceId,
  setWorkspaceId,
  _setSessionConnectorForTests,
} from './hwlink-connection.ts';
// The base64 single-file upload family lives in upload-file.ts; re-exported
// as the public face.
export {
  UPLOAD_BATCH_SIZE,
  UPLOAD_CHUNK_SIZE,
  UPLOAD_MAX_RETRIES,
  buildUploadResetCommand,
  classifyLocalUploadPath,
  splitBase64Chunks,
  uploadFileWithSession,
} from './upload-file.ts';
// The project upload orchestration lives in upload-project.ts (transport in
// upload-transport.ts); re-exported as the public face.
export { uploadProjectWithSession } from './upload-project.ts';
// The nginx deploy family lives in deploy-nginx.ts; re-exported as the public
// face (the port helpers and the #935 verify parsers are unit-tested through
// this path).
export {
  deployNginx,
  evaluateDeployNginxVerify,
  formatPortConflictWarning,
  formatPortDriftWarning,
  parseDeployNginxVerifyOutput,
  resolveNginxConfigPath,
  resolveProxyNodePort,
} from './deploy-nginx.ts';
export type { DeployNginxVerdict, ParsedDeployNginxVerify } from './deploy-nginx.ts';
// The deploy-check family (check script, stdout-contract parser, expose
// remediation) lives in deploy-check.ts; re-exported as the public face.
export { TUNNEL_URL_PATTERN, buildExposeRemediation, deployCheck, parseDeployCheckOutput } from './deploy-check.ts';
export type { ParsedDeployCheck } from './deploy-check.ts';
