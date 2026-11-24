import type { Readable } from 'node:stream';

/** Same 16 MB ceiling as the Python relay, for stdin lines and hub responses. */
export const MAX_MESSAGE = 16 * 1024 * 1024;

export type RpcId = string | number;
export interface RpcError { code: number; message: string; data?: unknown }
export interface RpcMessage {
  jsonrpc: '2.0'; id?: RpcId | null; method?: string; params?: unknown; result?: unknown; error?: RpcError;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function validId(value: unknown): value is RpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 2 ** 53);
}

/** JSON-RPC 2.0 envelope check, ported from the Python relay. */
export function envelope(message: unknown): message is RpcMessage {
  if (!isRecord(message) || message.jsonrpc !== '2.0') return false;
  if ('id' in message && !validId(message.id)) return false;
  if ('method' in message) {
    return typeof message.method === 'string' && message.method.length > 0 &&
      (!('params' in message) || isRecord(message.params) || Array.isArray(message.params)) && !('result' in message) && !('error' in message);
  }
  const error = message.error;
  return 'id' in message && !('params' in message) &&
    (('result' in message && !('error' in message)) ||
      (!('result' in message) && isRecord(error) && Number.isInteger(error.code) && typeof error.message === 'string'));
}

export const isRequest = (message: RpcMessage) => typeof message.method === 'string' && message.id !== undefined && message.id !== null;
export const isNotification = (message: RpcMessage) => typeof message.method === 'string' && message.id === undefined;

export function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Newline-delimited messages from a stream; yields `null` once for an overlong line and then stops. */
export async function* readLines(stream: Readable, max = MAX_MESSAGE): AsyncGenerator<string | null> {
  let pending: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    let chunk = typeof value === 'string' ? Buffer.from(value) : value as Buffer;
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a)) {
      const line = Buffer.concat([...pending, chunk.subarray(0, index)]);
      pending = [];
      size = 0;
      chunk = chunk.subarray(index + 1);
      if (line.length > max) { yield null; return; }
      const text = line.toString('utf8').replace(/\r$/, '');
      if (text.trim()) yield text;
    }
    if (chunk.length) {
      pending.push(chunk);
      size += chunk.length;
      if (size > max) { yield null; return; }
    }
  }
  if (size) {
    const text = Buffer.concat(pending).toString('utf8').replace(/\r$/, '');
    if (text.trim()) yield text;
  }
}
