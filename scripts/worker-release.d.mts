export const REPO_ROOT: string;
export const MANIFEST_KEYS: string[];
export interface ReleaseArgs {
  out: string | null; arch: 'arm64' | 'x64' | null; win: boolean; skipBuild: boolean; printConfig: boolean;
  electronZipDir: string | null; electronVersion: string | null; allowElectronVersion: boolean; help: boolean;
}
export interface ReleaseArtifact { path: string; arch: string; platform: string }
export interface ReleaseManifest { version: string; platform: string; file: string; sha256: string; bytes: number; built_at: string }
export function parseReleaseArgs(argv: string[]): ReleaseArgs;
export function defaultOutDir(options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; repoRoot?: string; exists?: (path: string) => boolean }): { dir: string; onHub: boolean };
export function releasePlatforms(hostPlatform: NodeJS.Platform, args: Pick<ReleaseArgs, 'win' | 'arch'>): string[];
export function sha256File(path: string): Promise<string>;
export function manifestFor(input: { version: string; platform: string; file: string; sha256: string; bytes: number; builtAt: string }): ReleaseManifest;
export function choosePackage(artifacts: ReleaseArtifact[], platform: string): ReleaseArtifact | null;
export function publishRelease(input: { outDir: string; artifacts: ReleaseArtifact[]; platforms: string[]; version: string; now?: () => Date }):
  Promise<{ manifest: ReleaseManifest; manifestPath: string; path: string }[]>;
export function main(argv: string[], deps?: { log?: (line: string) => void; platform?: NodeJS.Platform }): Promise<number>;
