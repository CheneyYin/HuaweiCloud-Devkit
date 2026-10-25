// The CLI banner, shared by every command body that moved out of
// setup-cli.ts (the auth, proxy, and packs command families). A leaf module
// so every command module can import it without cycles.

import { pkgVersion } from '../install-payload.ts';

export const BANNER = `
╔══════════════════════════════════════════════╗
║     HuaweiCloud DevKit v${pkgVersion}${' '.repeat(Math.max(0, 22 - String(pkgVersion).length))}║
║     https://github.com/huaweicloud   ║
╚══════════════════════════════════════════════╝
`;
