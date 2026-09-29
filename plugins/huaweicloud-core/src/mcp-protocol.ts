import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { TOOL_DEFINITIONS, callTool } from './tools.ts';
import { PACK_OF } from './packs/registry.ts';
import { resolveEnabledPacks } from './packs/enable.ts';
import { getToolSchema, assertConstructedSchemas } from './tool-schemas.ts';
import { peekCachedUpdateInfo, applyUpdateHint, readInstalledVersion } from './update-check.ts';
import { initTelemetry } from './telemetry/telemetry.ts';
import { detectAgent } from './telemetry/agent-detect.ts';

const pkgVersion = readInstalledVersion() || '0.0.0';

// 会话内首个非 check/upgrade 工具调用附加 _updateInfo，只消费一次。
// 按会话隔离：同进程内不同会话(A/B)各自首次提示；stdio 用固定 'stdin'。
const consumedBySession = new Map<string, boolean>();

export interface DevkitServerOptions {
  sessionId?: string | null;
}

export function _decorateResult(sessionId: string | undefined | null, name: string, result: unknown): unknown {
  const key = sessionId || 'default';
  if (consumedBySession.get(key)) return result;
  try {
    const hint = peekCachedUpdateInfo();
    if (!hint) return result;
    const decorated = applyUpdateHint(result, name, hint);
    if (decorated !== result) consumedBySession.set(key, true);
    return decorated;
  } catch {
    return result; // 兜底装饰失败绝不影响工具调用
  }
}

export function _resetHintConsumption(): void {
  consumedBySession.clear();
}

export function _isHintConsumed(sessionId: string): boolean {
  return Boolean(consumedBySession.get(sessionId));
}

// Initialize side effects (user-hash prewarm for telemetry, agent detection)
// shared by both transports. The SDK offers no pre-initialize hook, so each
// transport invokes this from its JSON boundary after decoding an initialize
// request and before/while forwarding it. Awaited: the legacy dispatch held
// the initialize response for up to 3s on the hash race, and that ordering
// is observable behavior we keep.
//
// Both call sites hand over the full initialize params; the client identity
// lives one level down at params.clientInfo. A call site that passed params
// straight into detectAgent silently degraded agent detection to env-only.
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function toClientInfo(params: unknown): { name: string | null; version: string | null } {
  const info = asRecord(asRecord(params).clientInfo);
  return {
    name: typeof info.name === 'string' ? info.name : null,
    version: typeof info.version === 'string' ? info.version : null,
  };
}

export async function runInitializeSideEffects(params: unknown): Promise<void> {
  try {
    const { hdkitGenerateUserHash } = await import('./lib/hdkit/hdkitservice-api.ts');
    await Promise.race([
      hdkitGenerateUserHash(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {}

  const agent = detectAgent(toClientInfo(params));
  initTelemetry({ harness: agent.harness, version: agent.version });
}

// MCP permits omitting `arguments` on tools/call. The SDK hands
// request.params.arguments to the zod schema verbatim, where undefined fails
// "expected object". Transports call this right after decoding a tools/call
// body so the default lives once at the JSON boundary, before the SDK sees
// the message.
export function normalizeToolCallParams(message: JSONRPCMessage): JSONRPCMessage {
  if (
    message &&
    typeof message === 'object' &&
    !Array.isArray(message) &&
    'method' in message &&
    (message as { method?: unknown }).method === 'tools/call'
  ) {
    const params = (message as { params?: unknown }).params;
    if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
      const record = params as Record<string, unknown>;
      if (!('arguments' in record) || record.arguments === undefined || record.arguments === null) {
        return { ...message, params: { ...record, arguments: {} } };
      }
    }
  }
  return message;
}

export function createDevkitMcpServer({ sessionId }: DevkitServerOptions = {}): McpServer {
  assertConstructedSchemas();
  // Read per construction: stdio resolves once at boot (fail-fast exit on a
  // bogus DEVKIT_PACKS), the stateless remote re-reads env on every request,
  // so both transports share one code path with no transport branching.
  // Unknown pack ids throw here; core is always in the set, so its 17 tools
  // (15 + the two pack meta tools) are never filtered.
  const enabledPacks = resolveEnabledPacks();
  const server = new McpServer({ name: 'huaweicloud-devkit', version: pkgVersion });

  for (const tool of TOOL_DEFINITIONS) {
    if (!enabledPacks.has(PACK_OF[tool.name])) continue;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: getToolSchema(tool.name) },
      async (args): Promise<CallToolResult> => {
        const result = await callTool(tool.name, args as Record<string, never>, { sessionId });
        const decorated = _decorateResult(sessionId, tool.name, result);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(decorated, null, 2),
            },
          ],
          isError: false,
        };
      },
    );
  }

  return server;
}

// In-memory pair for tests: full SDK chain (registerTool, validation,
// decoration) without spawning a process.
export async function createLinkedDevkitServers(
  options: DevkitServerOptions = {},
): Promise<{ server: McpServer; transport: InMemoryTransport }> {
  const server = createDevkitMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, transport: clientTransport };
}
