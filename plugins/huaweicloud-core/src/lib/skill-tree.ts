// The one listing of a skills tree. The boot guard (verifySkillTree), the
// installer's doctor check, and the build-time --check stray scan must all
// agree on what counts as a skill directory, or one of them accepts a tree
// the others reject: hollow claimed dirs (name present, SKILL.md missing)
// and symlinked dirs were exactly that divergence. Membership is dir-or-
// symlink carrying a SKILL.md. Zod-free so every consumer graph — the
// bundled server, the zod-free installer, and the .mjs build scripts —
// can import it (Node >= 22.18 type stripping for the .mjs side).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function listSkillDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && existsSync(join(root, d.name, 'SKILL.md')))
      .map((d) => d.name);
  } catch {
    return [];
  }
}
