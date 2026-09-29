import { z } from 'zod';

import { searchMarketplace } from '../../search-market.ts';
import { getServiceIcon } from '../../icon-library.ts';
import { detectFramework } from '../../detect-framework.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';

// Handlers migrated verbatim from src/tools.ts.

async function handleSearchMarketplace(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return searchMarketplace(args.query || '', args.category || '');
}

async function handleGetServiceIcon(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return getServiceIcon(args.service || '', args.category || '');
}

async function handleDetectFramework(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const projectPath = args.projectPath;
  if (!projectPath) throw new Error('projectPath is required.');
  const result = detectFramework(projectPath);
  if (!result) {
    return { ok: false, error: 'No recognized web framework found in: ' + projectPath };
  }
  return { ok: true, ...result };
}

const searchMarketplaceSchema = z.looseObject({
  query: z.string().optional().describe('Search query across skill name, description, triggers, and service.'),
  category: z
    .string()
    .optional()
    .describe('Optional category filter: computing, storage, network, security, devtools, monitoring, etc.'),
});

const getServiceIconSchema = z.looseObject({
  service: z
    .string()
    .optional()
    .describe(
      'Service name, alias, or Chinese name, e.g. ecs, obs, modelarts, 对象存储, 虚拟私有云. Omit to browse by category only.',
    ),
  category: z
    .string()
    .optional()
    .describe('Optional category filter, e.g. 计算, 存储, 网络, 人工智能, 数据库, 安全, 企业应用.'),
});

const detectFrameworkSchema = z.looseObject({
  projectPath: z.string().describe('Absolute path to the local project directory to scan.'),
});

export const DISCOVERY_TOOLS = [
  {
    name: 'huaweicloud_search_marketplace',
    description:
      'Search the Huawei Cloud agent skill marketplace for available skills. Returns scored results with names, categories, and descriptions. Use when built-in skills are insufficient or the user asks what skills exist.',
    schema: searchMarketplaceSchema,
    handler: handleSearchMarketplace,
  },
  {
    name: 'huaweicloud_get_service_icon',
    description:
      'Find the official Huawei Cloud service logo from the Huawei Cloud Icons library (open.huaweicloud.com/openplatform/icons.html). Returns top 5 matches with CDN logo URLs, local paths, category, aliases, and product page links. Provide service (e.g. ecs, obs, modelarts, 对象存储) or category (e.g. 计算, 存储, 人工智能) to browse. Use when generating PPT, architecture diagrams (draw.io), or frontend pages that need official Huawei Cloud service logos.',
    schema: getServiceIconSchema,
    handler: handleGetServiceIcon,
  },
  {
    name: 'huaweicloud_detect_framework',
    description:
      'Scan a local project directory to identify the web framework (React/Vue/Angular/Next.js/Nuxt/VitePress/Docusaurus/Hugo/Hexo/Taro/uni-app), package manager, and monorepo tool. Returns framework type, build commands, output directory, and port. Use before deploying a web application to determine the correct build pipeline.',
    schema: detectFrameworkSchema,
    handler: handleDetectFramework,
  },
] as const satisfies readonly PackToolDefinition[];

export type DiscoveryToolName = (typeof DISCOVERY_TOOLS)[number]['name'];

// Schema map keyed by tool name for src/tool-schemas.ts: TOOL_SCHEMAS spreads
// it in place, keeping the satisfies Record<ToolName, LooseToolSchema>
// completeness check over all 42 tools.
export const DISCOVERY_TOOL_SCHEMAS: Readonly<Record<DiscoveryToolName, LooseToolSchema>> = {
  huaweicloud_search_marketplace: searchMarketplaceSchema,
  huaweicloud_get_service_icon: getServiceIconSchema,
  huaweicloud_detect_framework: detectFrameworkSchema,
};

// Dispatch map for the callTool case labels in src/tools.ts. Typed over
// DiscoveryToolName, so a tool added to DISCOVERY_TOOLS without a handler
// entry here — or the reverse — fails to compile instead of failing at
// runtime.
export const DISCOVERY_TOOL_HANDLERS: Readonly<Record<DiscoveryToolName, PackToolDefinition['handler']>> = {
  huaweicloud_search_marketplace: handleSearchMarketplace,
  huaweicloud_get_service_icon: handleGetServiceIcon,
  huaweicloud_detect_framework: handleDetectFramework,
};
