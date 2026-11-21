import { DomainError, text, type Command, type Fields, type Role } from '../types.js';

export const agentModule = 'agent';

export function command(roles: readonly Role[], run: Command['run']): Command {
  return { roles, async run(ctx, input) {
    if (!roles.includes(ctx.role)) throw new DomainError('forbidden', 'Command is not available to this role', 403);
    return run(ctx, object(input, 'input'));
  } };
}

export function invalid(field: string): never {
  throw new DomainError('invalid_input', `Invalid ${field}`);
}

export function conflict(message: string): never {
  throw new DomainError('invalid_state', message, 409);
}

export function object(value: unknown, field: string): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(field);
  return value as Fields;
}

export function array(value: unknown, field: string, max = 50): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  return value;
}

export function integer(value: unknown, field: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
}

export function id(value: unknown): string {
  return text({ id: value }, 'id', 128);
}

export function time(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) invalid(field);
  return new Date(value).toISOString();
}
