import { createHash } from "node:crypto";
import { Problem, type Data } from "@smartsell/contracts";

export function object(value: unknown, name: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Problem(422, 'INVALID_INPUT', `${name} must be an object`);
  return value as Data;
}
export function str(value: unknown, name: string, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Problem(422, 'INVALID_INPUT', `Invalid ${name}`);
  return value.trim();
}
export function choose(value: unknown, name: string, values: readonly string[]): string {
  const result = str(value, name);
  if (!values.includes(result)) throw new Problem(422, 'INVALID_INPUT', `Invalid ${name}`);
  return result;
}
export function objects(value: unknown, name: string): Data[] {
  if (!Array.isArray(value) || value.length > 100) throw new Problem(422, 'INVALID_INPUT', `Invalid ${name}`);
  return value.map(entry => object(entry, name));
}
export function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Problem(422, 'INVALID_INPUT', `Invalid ${name}`);
  return [...new Set(value.map(entry => str(entry, name)))];
}
export function pick(source: Data, keys: readonly string[]): Data {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const row = value as Data;
    return '{' + Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
