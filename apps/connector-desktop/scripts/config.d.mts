export function httpsUrl(value: string | undefined, name: string, originOnly?: boolean): string | undefined;
export function releasePublicKey(value: string | undefined): string | undefined;
export function releaseConfig(platform: NodeJS.Platform): {
  api?: string; workbench?: string; update?: { feed: string; publisher?: string }; releasePublicKey?: string;
};
