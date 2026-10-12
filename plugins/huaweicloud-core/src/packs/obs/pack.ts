import type { Pack } from '../../lib/pack-types.ts';
import { OBS_TOOLS } from './tools.ts';

// The obs pack manifest. registry.ts references this from PACKS; the tool
// list is derived from the pack's own definitions, and PACK_OF stays the
// tool-ownership source of truth (structure.test.ts asserts the lockstep).
export const obsPack: Pack = {
  id: 'obs',
  title: 'OBS',
  description: 'OBS credential synchronization and static website hosting configuration for buckets.',
  skills: ['huawei-obs'],
  tools: OBS_TOOLS.map((tool) => tool.name),
};
