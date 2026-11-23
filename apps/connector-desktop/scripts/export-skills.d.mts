type SkillEntry = { id: string; content: string };
type SkillInstallResult = { path: string; installed: boolean };

export function installSkills(projectDirectory: string, entries: readonly SkillEntry[]): Promise<SkillInstallResult[]>;
export function run(entries: readonly SkillEntry[], args?: string[]): Promise<void>;
