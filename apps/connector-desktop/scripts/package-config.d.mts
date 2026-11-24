export const APP_ID: string;
export const PRODUCT_NAME: string;
export const PACKAGED_FILES: string[];
export const EXTRA_RESOURCES: { from: string; to: string; filter: string[] }[];
export function artifactName(platform: string, arch: string): string;
export interface BuilderConfigOptions {
  target: 'mac' | 'win';
  unsigned: boolean;
  arch?: 'arm64' | 'x64';
  output: string;
  electronDist?: string;
  electronVersion?: string;
  release?: { api?: string; workbench?: string; update?: { feed: string; publisher?: string } };
  macIdentity?: string;
  winPublisher?: string;
}
export function builderConfig(options: BuilderConfigOptions): Record<string, any>;
export function hostTarget(platform: string): 'mac' | 'win' | null;
