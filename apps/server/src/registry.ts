import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Command, Commands, Role } from './modules/types';

export const moduleKeys = [
  'workspace', 'account', 'ingest', 'commerce', 'campaign', 'intel', 'content', 'asset', 'planning',
  'execution', 'inbox', 'creator', 'traffic', 'ads', 'lifecycle', 'analytics', 'agent', 'team', 'ops',
] as const;
export const operationName = /^[a-z][a-z0-9_]{0,79}$/;
const roles: Role[] = ['owner', 'admin', 'editor', 'reviewer', 'viewer'];

export type Registry = Map<string, Map<string, Command>>;
export type Extension = Record<string, unknown>;

export function register(registry: Registry, module: string, commands: Commands) {
  if (!moduleKeys.some(key => key === module)) throw new Error(`Unknown module: ${module}`);
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) throw new Error(`Invalid ${module} command exports`);
  const group = registry.get(module) ?? new Map<string, Command>();
  for (const [action, command] of Object.entries(commands)) {
    if (!operationName.test(action) || !command || typeof command.run !== 'function' ||
      !Array.isArray(command.roles) || !command.roles.length || command.roles.some(role => !roles.includes(role))) {
      throw new Error(`Invalid command: ${module}.${action}`);
    }
    if (group.has(action)) throw new Error(`Duplicate command: ${module}.${action}`);
    group.set(action, command);
  }
  registry.set(module, group);
}

async function entries(directory: URL) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function discover(root = new URL('./', import.meta.url), suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js',
  onMissingDependency?: (name: string, error: Error) => void) {
  const registry: Registry = new Map();
  const extensions = new Map<string, Extension>();
  async function load(name: string, url: URL) {
    try { return await import(fileURLToPath(url)); }
    catch (error) {
      if (!onMissingDependency || !(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
      onMissingDependency(name, error);
      return undefined;
    }
  }
  const modules = new URL('modules/', root);
  for (const module of moduleKeys) {
    const directory = new URL(`${module}/`, modules);
    const filename = `index${suffix}`;
    if (!(await entries(directory)).some(entry => entry.isFile() && entry.name === filename)) continue;
    const exports = await load(module, new URL(filename, directory));
    if (exports?.commands !== undefined) register(registry, module, exports.commands);
  }
  const extensionRoot = new URL('extensions/', root);
  for (const entry of (await entries(extensionRoot)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
    const name = entry.name.slice(0, -suffix.length);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;
    const exports: Extension | undefined = await load(`extension:${name}`, new URL(entry.name, extensionRoot));
    if (!exports) continue;
    extensions.set(name, exports);
    if (exports.workspaceCommands) {
      for (const [module, commands] of Object.entries(exports.workspaceCommands)) register(registry, module, commands as Commands);
    }
  }
  return { registry, extensions, missing: moduleKeys.filter(key => !registry.get(key)?.size) };
}
