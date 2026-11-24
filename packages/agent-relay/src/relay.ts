import { homedir } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { createHubApi } from './hub-api.ts';
import { createHubConnection, RelayError, validateHubOrigin } from './hub-connection.ts';
import type { HandoffClient } from './handoff.ts';
import { envelope, parseJson, readLines, type RpcId, type RpcMessage } from './jsonrpc.ts';
import { createMediaUploadHandler } from './media-upload.ts';
import type { PathPolicy } from './paths.ts';
import type { UploadTuning } from './uploader.ts';

export interface RunRelayOptions {
  hubOrigin: string; token: string; stdin: Readable; stdout: Writable; stderr: Writable;
  fetch?: typeof fetch; handoff?: HandoffClient;
  /** The relay's own data directory (config and credential); never readable as media. */
  dataDir?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Test seams for part sizing, retries and polling. */
  tuning?: Partial<UploadTuning>;
  pollMs?: number;
  /** Keep running after stdin closes until background uploads settle (default true). */
  waitForUploads?: boolean;
}

const FORWARD_CONCURRENCY = 4;

/**
 * C5: the stdio MCP relay. Every message is forwarded to `<hub>/mcp`, except `tools/call` for `media_upload`,
 * which reads the file on this computer and uploads it in resumable, hashed parts (§6.3).
 */
export async function runRelay(options: RunRelayOptions): Promise<void> {
  const hubOrigin = validateHubOrigin(options.hubOrigin);
  const { stdin, stdout, stderr } = options;
  const connection = createHubConnection({ hubOrigin, token: options.token, fetch: options.fetch });
  const api = createHubApi({ hubOrigin, token: options.token, fetch: options.fetch });
  const background = new Set<Promise<unknown>>();
  const log = (line: string) => { stderr.write(`${line}\n`); };
  const policy: PathPolicy = { homeDir: options.homeDir ?? homedir(), platform: options.platform, denyDirs: options.dataDir ? [options.dataDir] : [] };
  const uploads = createMediaUploadHandler({ api, policy, handoff: options.handoff, tuning: options.tuning, pollMs: options.pollMs, log,
    onBackground: work => { background.add(work); void work.finally(() => background.delete(work)); } });
  stdout.on('error', () => undefined);
  const emit = (message: RpcMessage) => { stdout.write(`${JSON.stringify(message)}\n`); };
  const cancelled = new Set<RpcId>();
  const localCalls = new Set<RpcId>();
  const pending = new Set<Promise<void>>();
  let active = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    while (active >= FORWARD_CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve));
    active++;
    return () => { active--; waiting.shift()?.(); };
  };

  async function forward(message: RpcMessage) {
    try { await connection.send(message, emit); }
    catch (error) {
      const relay = error instanceof RelayError ? error : new RelayError('The SmartSell relay could not reach the hub.', '目前連不上 SmartSell 中樞。');
      if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
        emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: relay.message, ...(relay.ownerMessage && { data: { owner_message: relay.ownerMessage } }) } });
      }
      log(`SmartSell relay: ${relay.message}`);
    }
  }

  async function mediaUpload(message: RpcMessage) {
    const id = message.id as RpcId;
    localCalls.add(id);
    try {
      const params = (message.params ?? {}) as { arguments?: unknown; _meta?: { progressToken?: string | number } };
      const result = await uploads.handle(params.arguments, { progressToken: params._meta?.progressToken, notify: notice => { if (!cancelled.has(id)) emit(notice); } });
      if (!cancelled.has(id)) emit({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (!cancelled.has(id)) emit({ jsonrpc: '2.0', id, error: { code: -32603, message: (error as Error).message || 'media_upload failed' } });
    } finally { localCalls.delete(id); cancelled.delete(id); }
  }

  const track = (work: Promise<void>) => { pending.add(work); void work.finally(() => pending.delete(work)); };

  for await (const line of readLines(stdin)) {
    const message = line === null ? undefined : parseJson(line);
    if (!envelope(message)) {
      emit({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid MCP request' } });
      if (line === null) break;
      continue;
    }
    if (message.method === 'tools/call' && (message.params as { name?: unknown } | undefined)?.name === 'media_upload' && message.id !== undefined) {
      track(mediaUpload(message));
      continue;
    }
    if (message.method === 'notifications/cancelled') {
      const target = (message.params as { requestId?: RpcId } | undefined)?.requestId;
      // A cancelled local media_upload sends no response; its upload keeps going in the background.
      if (target !== undefined && localCalls.has(target)) { cancelled.add(target); continue; }
    }
    if (message.method === 'initialize' || message.method === 'notifications/initialized') {
      // Session setup stays in order; everything after it may run concurrently.
      await Promise.allSettled(pending);
      await forward(message);
      continue;
    }
    const release = await slot();
    track(forward(message).finally(release));
  }
  await Promise.allSettled(pending);
  if (options.waitForUploads !== false) {
    // stdin closed: the client is done, but an upload may still be finishing (Node relay without the App, §6.3 step 9).
    while (background.size) await Promise.allSettled([...background]);
  }
}
