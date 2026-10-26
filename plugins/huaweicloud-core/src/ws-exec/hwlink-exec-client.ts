// Stable public face of the hwlink exec client. The internals live in the
// src/ws-exec hwlink family (input normalization in hwlink-normalize, the
// one-shot interactive terminal in hwlink-interactive-terminal, the exec
// session + entry points in hwlink-exec-session, and the pending-exec
// correlation in hwlink-exec-pending); this module is the re-export seam
// every consumer imports — same exported names, same import path, same
// behavior (the safety-policy precedent).

export { connectHwlinkInteractiveTerminal, createHwlinkTerminal } from './hwlink-interactive-terminal.ts';
export {
  HwlinkTerminalExecSession,
  connectHwlinkTerminalSession,
  executeHwlinkCommand,
} from './hwlink-exec-session.ts';
export { normalizeSource } from './hwlink-normalize.ts';
