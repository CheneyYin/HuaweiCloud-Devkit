import { createServer, type Server } from 'node:http';
import { format } from 'node:util';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { createDevkitMcpServer, runInitializeSideEffects, normalizeToolCallParams } from './mcp-protocol.ts';

export const DEFAULT_PORT = 9528;
export const DEFAULT_HOST = '127.0.0.1';

interface RemoteServerOptions {
  port?: number;
  host?: string;
}

interface StartedRemoteServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startRemoteServer({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
}: RemoteServerOptions = {}): Promise<StartedRemoteServer> {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Accept, Authorization',
    );
    res.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // The shell keeps the method filter: GET stays 405 (legacy contract; the
    // SDK transport would turn it into a 406/200 SSE stream) and only POST
    // reaches the transport.
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, OPTIONS' });
      res.end();
      return;
    }

    let message: unknown;
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    // Notifications (incl. notifications/initialized) get no response body;
    // the stateless transport would 202 them, but skipping construction
    // entirely is cheaper and preserves the 202 status contract.
    if (
      message !== null &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      !Object.hasOwn(message as Record<string, unknown>, 'id')
    ) {
      res.writeHead(202);
      res.end();
      return;
    }

    if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
      const record = message as Record<string, unknown>;
      if (record.method === 'initialize') {
        try {
          await runInitializeSideEffects(record.params);
        } catch {}
      }
    }

    const sessionId =
      (typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '').trim() || 'default';

    // Stateless per-request transport: no session id, no resumability. The
    // response format stays JSON (enableJsonResponse) for dual-Accept
    // clients; Accept headers lacking either application/json or
    // text/event-stream are rejected 406 by the transport.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcpServer = createDevkitMcpServer({ sessionId });
    transport.onerror = (error) => {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`remote transport error: ${reason}\n`);
    };

    res.on('close', () => {
      void mcpServer.close().catch(() => {});
      void transport.close().catch(() => {});
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, normalizeToolCallParams(message as JSONRPCMessage));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: Number.isSafeInteger(code) ? (code as number) : -32603, message: String(error) },
          }),
        );
      }
      await mcpServer.close().catch(() => {});
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => resolvePromise());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('remote server did not bind a TCP address');
  }
  process.stdout.write(format('huaweicloud-devkit MCP server (remote) listening on %s:%s\n', host, address.port));

  return {
    server,
    port: address.port,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}
