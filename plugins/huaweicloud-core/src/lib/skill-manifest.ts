// Pure roster extraction for the .manifest.json that travels with the
// generated skills tree. Kept free of fs access and of the registry import
// so the zod-free setup-cli graph and the tests share one parser: doctor
// reads the manifest as its roster of record (it cannot import the
// zod-dependent registry), and the unit tests exercise the malformed-input
// branches a spawned CLI test cannot reach cheaply.

export function parseSkillManifest(content: string): string[] {
  try {
    const parsed: unknown = JSON.parse(content);
    const skills = (parsed as { skills?: unknown } | null)?.skills;
    // Dedupe: a tampered manifest with duplicate names must not satisfy a
    // size-equality check by inflating the expected count.
    return Array.isArray(skills) ? [...new Set(skills.filter((name): name is string => typeof name === 'string'))] : [];
  } catch {
    return [];
  }
}
