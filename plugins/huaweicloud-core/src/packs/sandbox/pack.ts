import type { Pack } from '../../lib/pack-types.ts';
import { SANDBOX_TOOLS } from './tools.ts';

// The sandbox pack manifest. registry.ts references this from PACKS; the tool
// list is derived from the pack's own definitions, and PACK_OF stays the
// tool-ownership source of truth (structure.test.ts asserts the lockstep).
export const sandboxPack: Pack = {
  id: 'sandbox',
  title: 'Sandbox',
  description:
    'Cloud sandbox workspace terminals: session and one-shot execution, file and project upload, nginx deployment and deployment checks, and hdkitservice onboarding.',
  skills: ['huawei-sandbox'],
  tools: SANDBOX_TOOLS.map((tool) => tool.name),
};
