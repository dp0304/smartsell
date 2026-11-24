export interface BrowserChoice { use: { channel?: string; launchOptions?: { executablePath: string } }; reason: string }
export function installedChromePaths(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string[];
export function playwrightBrowser(env?: NodeJS.ProcessEnv, deps?: { bundled(): boolean; exists(path: string): boolean }): BrowserChoice;
export function browserUse(env?: NodeJS.ProcessEnv): BrowserChoice['use'];
