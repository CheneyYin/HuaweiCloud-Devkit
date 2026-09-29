import type { Pack } from '../registry.ts';
import { UPDATE_TOOLS } from './tools.ts';

// The update pack manifest. registry.ts references this from PACKS; the tool
// list is derived from the pack's own definitions, and PACK_OF stays the
// tool-ownership source of truth (structure.test.ts asserts the lockstep).
export const updatePack: Pack = {
  id: 'update',
  title: 'Update',
  description: 'Plugin version check and consent-gated in-place upgrade for huaweicloud-devkit.',
  skills: [],
  tools: UPDATE_TOOLS.map((tool) => tool.name),
};
