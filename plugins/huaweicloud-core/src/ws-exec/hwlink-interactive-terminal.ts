/*
 * This file contains code derived from hwlink.
 *
 * Source:
 * https://gitcode.com/huawei-developers/hwlink
 *
 * Licensed under the ISC License.
 */

// The one-shot interactive hwlink terminal, extracted from
// hwlink-exec-client in the ws-exec family split: the terminal factory
// (multiplexer + terminal-channel composition, ready handshake, close
// plumbing) and its await-ready wrapper.

import { WebSocketExecError } from './ws-exec-client.ts';
import { HwlinkWebSocketMultiplexer } from './hwlink-multiplexer.ts';
import { HwlinkTerminalChannel } from './hwlink-terminal-channel.ts';
import { errorMessage, isFiniteNumber, normalizeSource, normalizeUrl } from './hwlink-normalize.ts';
import type { FrameReport, WebSocketConstructor } from './hwlink-multiplexer.ts';

interface CreateHwlinkTerminalOptions {
  url?: string;
  source?: unknown;
  username?: string;
  WebSocketImpl?: WebSocketConstructor;
  protocol?: string;
  cols?: number;
  rows?: number;
  onFrame?: (_frame: FrameReport) => void;
  onData?: (_data: Uint8Array) => void;
  onError?: (_error: WebSocketExecError) => void;
  onClose?: () => void;
  trace?: boolean;
}

interface HwlinkTerminalHandle {
  url: string;
  source: number;
  username: string;
  mux: HwlinkWebSocketMultiplexer;
  term: HwlinkTerminalChannel;
  ready: Promise<HwlinkTerminalHandle>;
  close: () => void;
  resize: (_nextCols: number, _nextRows: number) => void;
  sendInput: (_data: Uint8Array) => void;
  sendText: (_text: string) => void;
}

function createHwlinkTerminal(options: CreateHwlinkTerminalOptions = {}): HwlinkTerminalHandle {
  const {
    url,
    source,
    username = 'root',
    WebSocketImpl = globalThis.WebSocket,
    protocol = 'devenv',
    cols,
    rows,
    onFrame,
    onData,
    onError,
    onClose,
    trace = false,
  } = options;

  const normalizedUrl = normalizeUrl(url);
  const normalizedSource = normalizeSource(source);
  const mux = new HwlinkWebSocketMultiplexer(normalizedUrl, normalizedSource, {
    WebSocketImpl,
    protocol,
    onFrame,
    trace,
  });
  const term = new HwlinkTerminalChannel(username);
  let closed = false;
  let readySettled = false;
  let readyResolve: (_handle: HwlinkTerminalHandle) => void = () => {};
  let readyReject: (_error: unknown) => void = () => {};

  const ready = new Promise<HwlinkTerminalHandle>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  function settleReady(error?: unknown): void {
    if (readySettled) return;
    readySettled = true;
    if (error) readyReject(error);
    else readyResolve(handle);
  }

  function handleError(error: unknown, prefix: string): void {
    const wrapped = new WebSocketExecError(`${prefix}: ${errorMessage(error)}`, 1, {
      cause: error,
      phase: readySettled ? 'open' : 'opening',
    });
    settleReady(wrapped);
    if (onError) onError(wrapped);
    close();
  }

  function handleClose(): void {
    settleReady(
      new WebSocketExecError('hwlink terminal closed before ready', 1, {
        phase: 'opening',
      }),
    );
    if (closed) return;
    closed = true;
    if (onClose) onClose();
  }

  term.onReady(() => {
    if (isFiniteNumber(cols) && isFiniteNumber(rows)) {
      term.resize(cols, rows);
    }
    settleReady();
  });
  term.onData((data) => {
    if (onData) onData(data);
  });
  term.onError((error) => handleError(error, 'hwlink terminal error'));
  term.onClose(handleClose);
  mux.onError = (error) => handleError(error, 'hwlink websocket error');
  mux.onClose = handleClose;

  function close(): void {
    if (closed) return;
    closed = true;
    term.close();
    mux.close();
  }

  const handle: HwlinkTerminalHandle = {
    url: normalizedUrl,
    source: normalizedSource,
    username,
    mux,
    term,
    ready,
    close,
    resize: (nextCols: number, nextRows: number) => term.resize(nextCols, nextRows),
    sendInput: (data: Uint8Array) => term.sendInput(data),
    sendText: (text: string) => term.sendText(text),
  };

  term.attach(mux);
  return handle;
}

async function connectHwlinkInteractiveTerminal(
  options: CreateHwlinkTerminalOptions = {},
): Promise<HwlinkTerminalHandle> {
  const terminal = createHwlinkTerminal(options);
  await terminal.ready;
  return terminal;
}

export { connectHwlinkInteractiveTerminal, createHwlinkTerminal };
