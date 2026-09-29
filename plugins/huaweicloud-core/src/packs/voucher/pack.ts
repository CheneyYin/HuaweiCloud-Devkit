import type { Pack } from '../../lib/pack-types.ts';
import { VOUCHER_TOOLS } from './tools.ts';

// The voucher pack manifest. registry.ts references this from PACKS; the tool
// list is derived from the pack's own definitions, and PACK_OF stays the
// tool-ownership source of truth (structure.test.ts asserts the lockstep).
export const voucherPack: Pack = {
  id: 'voucher',
  title: 'Voucher',
  description: 'Voucher claiming status and one-time voucher redemption.',
  skills: ['huawei-voucher'],
  tools: VOUCHER_TOOLS.map((tool) => tool.name),
};
