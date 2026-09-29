import { z } from 'zod';

import { hdkitVoucherStatus, hdkitVoucherClaim } from '../../lib/hdkit/hdkitservice-api.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';

// Handlers migrated verbatim from src/tools.ts.

async function handleVoucherStatus(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return await hdkitVoucherStatus(args.domain_id);
}

async function handleVoucherClaim(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return await hdkitVoucherClaim(args.domain_id);
}

const voucherStatusSchema = z.looseObject({
  domain_id: z
    .string()
    .optional()
    .describe('Optional. Leave empty in production — account is resolved from IAM automatically.'),
});

const voucherClaimSchema = z.looseObject({
  domain_id: z
    .string()
    .optional()
    .describe('Optional. Leave empty in production — account is resolved from IAM automatically.'),
});

export const VOUCHER_TOOLS = [
  {
    name: 'huaweicloud_voucher_status',
    description:
      '查询代金券领取状态。用户首次使用、开始会话或询问插件能力时，应主动调用本工具检查：未领取（claimed=false）则主动提示可领取一张代金券；已领取（claimed=true）则不提示、不打扰。',
    schema: voucherStatusSchema,
    handler: handleVoucherStatus,
  },
  {
    name: 'huaweicloud_voucher_claim',
    description: '领取代金券（一人一次）。重复领取会返回已领取。',
    schema: voucherClaimSchema,
    handler: handleVoucherClaim,
  },
] as const satisfies readonly PackToolDefinition[];

export type VoucherToolName = (typeof VOUCHER_TOOLS)[number]['name'];

// Schema map keyed by tool name for src/tool-schemas.ts: TOOL_SCHEMAS spreads
// it in place, keeping the satisfies Record<ToolName, LooseToolSchema>
// completeness check over all 42 tools.
export const VOUCHER_TOOL_SCHEMAS: Readonly<Record<VoucherToolName, LooseToolSchema>> = {
  huaweicloud_voucher_status: voucherStatusSchema,
  huaweicloud_voucher_claim: voucherClaimSchema,
};

// Dispatch map for the callTool case labels in src/tools.ts. Typed over
// VoucherToolName, so a tool added to VOUCHER_TOOLS without a handler entry
// here — or the reverse — fails to compile instead of failing at runtime.
export const VOUCHER_TOOL_HANDLERS: Readonly<Record<VoucherToolName, PackToolDefinition['handler']>> = {
  huaweicloud_voucher_status: handleVoucherStatus,
  huaweicloud_voucher_claim: handleVoucherClaim,
};
