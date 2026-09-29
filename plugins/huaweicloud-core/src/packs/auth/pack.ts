import type { Pack } from '../../lib/pack-types.ts';
import { AUTH_TOOLS } from './tools.ts';

// The auth pack manifest. registry.ts references this from PACKS; the tool
// list is derived from the pack's own definitions, and PACK_OF stays the
// tool-ownership source of truth (structure.test.ts asserts the lockstep).
export const authPack: Pack = {
  id: 'auth',
  title: 'Auth',
  description:
    'Unified Huawei Cloud credential status, vault sync, runtime injection, and reconciliation across KooCLI, OBS, and agent MCP registrations.',
  skills: [],
  tools: AUTH_TOOLS.map((tool) => tool.name),
};
