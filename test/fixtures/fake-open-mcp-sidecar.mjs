#!/usr/bin/env node
// Minimal newline-JSON-RPC MCP server standing in for the real
// huaweicloud-open-mcp gateway in the open-mcp-pack tests. Known tools echo
// their arguments as structuredContent (the branch the REAL gateway's
// successful calls always take — its SDK derives structuredContent from the
// return annotations) plus a content-text mirror. Three synthetic tools pin
// the remaining normalization branches, and FAKE_FAIL_HANDSHAKE=1 makes
// initialize answer with a JSON-RPC error to exercise the spawn-failure
// path. Exits on stdin EOF, which is exactly the parent-death semantics the
// real gateway's stdio transport has and the sidecar lifetime contract
// depends on.
const KNOWN_TOOLS = new Set([
  'search_apis',
  'list_products',
  'get_product',
  'list_apis',
  'get_api',
  'get_api_examples',
  'failing_tool',
  'envelope_fail_tool',
  'raw_text_tool',
]);
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handleLine(line);
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === 'initialize') {
    if (process.env.FAKE_FAIL_HANDSHAKE === '1') {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fake handshake failure' } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
        capabilities: {},
        serverInfo: { name: 'fake-open-mcp-sidecar', version: '0.0.0' },
      },
    });
  } else if (request.method === 'tools/call') {
    const name = request.params?.name;
    if (typeof name !== 'string' || !KNOWN_TOOLS.has(name)) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      return;
    }
    if (name === 'failing_tool') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: 'fake gateway tool failure' }], isError: true },
      });
      return;
    }
    if (name === 'envelope_fail_tool') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'fake envelope failure' }) }],
          structuredContent: { ok: false, reason: 'fake envelope failure', tool: name },
          isError: false,
        },
      });
      return;
    }
    if (name === 'raw_text_tool') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: 'not json at all' }], isError: false },
      });
      return;
    }
    const payload = {
      ok: true,
      tool: name,
      arguments: request.params?.arguments ?? {},
      pid: process.pid,
    };
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false,
      },
    });
  } else if (request.id !== undefined) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  }
}
