export function renderGenerated(packId: string, skillName: string, relativeFile: string, content: string): string;
export function stripMarkerLine(content: string): string;
export function writeSkillsTree(options?: { packsDir?: string }): { skills: number; files: number };
