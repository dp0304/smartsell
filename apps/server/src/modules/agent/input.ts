import { Problem, type Data, type Row } from '@smartsell/contracts';

export function text(value: unknown, field: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Problem(400, 'INVALID_INPUT', `${field} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

export function integer(value: unknown, field: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Problem(400, 'INVALID_INPUT', `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function object(value: unknown, field: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Problem(400, 'INVALID_INPUT', `${field} must be an object`);
  }
  return value as Data;
}

export function array(value: unknown, field: string, max = 50): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Problem(400, 'INVALID_INPUT', `${field} must be an array of at most ${max} items`);
  }
  return value;
}

export function timestamp(value: unknown, field: string): string {
  const input = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input) || !Number.isFinite(Date.parse(input))) {
    throw new Problem(400, 'INVALID_INPUT', `${field} must be an ISO timestamp with a timezone`);
  }
  return new Date(input).toISOString();
}

export function checkVersion(row: Row, expected: number | undefined): void {
  if (expected === undefined) throw new Problem(428, 'VERSION_REQUIRED', 'If-Match is required');
  if (row.version !== expected) throw new Problem(409, 'VERSION_CONFLICT', 'The resource version changed');
}

export function conflict(message: string): never {
  throw new Problem(409, 'INVALID_STATE', message);
}
