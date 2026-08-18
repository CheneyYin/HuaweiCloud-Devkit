import { getProxyUrlForTarget } from './proxy-config.mjs';

let cachedDispatcher = undefined;
let cachedDispatcherProxyUrl = null;

async function importUndici() {
  try { return await import('node:undici'); }
  catch { return await import('undici'); }
}

export async function getProxyDispatcher(targetUrl) {
  const proxyUrl = getProxyUrlForTarget(targetUrl);
  if (!proxyUrl) return undefined;

  if (cachedDispatcher && cachedDispatcherProxyUrl === proxyUrl) {
    return cachedDispatcher;
  }

  const { ProxyAgent } = await importUndici();
  cachedDispatcher = new ProxyAgent(proxyUrl);
  cachedDispatcherProxyUrl = proxyUrl;
  return cachedDispatcher;
}

export function clearProxyDispatcherCache() {
  cachedDispatcher = undefined;
  cachedDispatcherProxyUrl = null;
}

export async function createProxyWebSocket(url, protocols) {
  const proxyUrl = getProxyUrlForTarget(url);
  if (!proxyUrl) {
    return new globalThis.WebSocket(url, protocols);
  }

  const dispatcher = await getProxyDispatcher(url);
  const { WebSocket: UndiciWebSocket } = await importUndici();

  const wsOptions = { dispatcher };
  if (protocols) {
    if (Array.isArray(protocols)) {
      wsOptions.protocols = protocols;
    } else {
      wsOptions.protocols = [protocols];
    }
  }

  return new UndiciWebSocket(url, wsOptions);
}

export function getWebSocketImpl(targetUrl) {
  const proxyUrl = getProxyUrlForTarget(targetUrl);
  if (!proxyUrl) return globalThis.WebSocket;

  return (url, protocols) => {
    const proxyUrlForTarget = getProxyUrlForTarget(url);
    if (!proxyUrlForTarget) {
      return new globalThis.WebSocket(url, protocols);
    }

    const wsPromise = (async () => {
      const dispatcher = await getProxyDispatcher(url);
      const { WebSocket: UndiciWebSocket } = await importUndici();

      const wsOptions = { dispatcher };
      if (protocols) {
        if (Array.isArray(protocols)) {
          wsOptions.protocols = protocols;
        } else {
          wsOptions.protocols = [protocols];
        }
      }

      return new UndiciWebSocket(url, wsOptions);
    })();

    return createSyncProxyWebSocketWrapper(wsPromise);
  };
}

function createSyncProxyWebSocketWrapper(wsPromise) {
  const pendingEvents = [];
  const eventHandlers = new Map();
  let ws = null;
  let settled = false;
  let readyState = 0;
  let binaryType = 'arraybuffer';

  const wrapper = {
    get readyState() { return ws ? ws.readyState : readyState; },
    get url() { return ws ? ws.url : ''; },
    get protocol() { return ws ? ws.protocol : ''; },
    get binaryType() { return ws ? ws.binaryType : binaryType; },
    set binaryType(v) {
      binaryType = v;
      if (ws) ws.binaryType = v;
    },

    send(data, callback) {
      if (ws) {
        if (ws.send.length >= 2) return ws.send(data, callback);
        try { ws.send(data); if (callback) callback(null); } catch (e) { if (callback) callback(e); }
        return;
      }
      pendingEvents.push({ type: 'send', data, callback });
    },

    close(code, reason) {
      if (ws) { ws.close(code, reason); return; }
      readyState = 3;
      pendingEvents.push({ type: 'close', code, reason });
    },

    addEventListener(type, handler) {
      if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
      eventHandlers.get(type).add(handler);
      if (ws) ws.addEventListener(type, handler);
    },

    removeEventListener(type, handler) {
      const handlers = eventHandlers.get(type);
      if (handlers) handlers.delete(handler);
      if (ws) ws.removeEventListener(type, handler);
    },

    on(type, handler) { wrapper.addEventListener(type, handler); },
    off(type, handler) { wrapper.removeEventListener(type, handler); },
  };

  function flushPendingEvents() {
    for (const evt of pendingEvents) {
      if (evt.type === 'send') {
        if (ws.send.length >= 2) ws.send(evt.data, evt.callback);
        else { try { ws.send(evt.data); if (evt.callback) evt.callback(null); } catch (e) { if (evt.callback) evt.callback(e); } }
      } else if (evt.type === 'close') {
        ws.close(evt.code, evt.reason);
      }
    }
    pendingEvents.length = 0;
  }

  wsPromise.then((resolvedWs) => {
    ws = resolvedWs;
    if ('binaryType' in ws) ws.binaryType = binaryType;
    for (const [type, handlers] of eventHandlers) {
      for (const handler of handlers) {
        ws.addEventListener(type, handler);
      }
    }
    flushPendingEvents();
  }).catch((err) => {
    readyState = 3;
    const handlers = eventHandlers.get('error');
    if (handlers) for (const h of handlers) h(err instanceof Error ? err : new Error(String(err)));
    const closeHandlers = eventHandlers.get('close');
    if (closeHandlers) for (const h of closeHandlers) h({ code: 1006, reason: err.message || String(err) });
  });

  return wrapper;
}
