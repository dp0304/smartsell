import { createConnection, createServer, type Server } from 'node:net';
import { userInfo } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';

/** C12: what the relay sends the resident laptop App so it continues an upload after the tool call returns (§6.3 step 9). */
export interface HandoffMessage { type: 'handoff'; upload_id: string; path: string; sha256: string; bytes: number; mtime_ms: number }
export interface HandoffReply { ok: boolean; error?: string }
export interface HandoffClient { handoff(message: HandoffMessage): Promise<boolean> }

/** `<userData>/agent-relay/ipc.sock` on macOS and Linux; `\\.\pipe\smartsell-agent-<user>` on Windows. */
export function handoffSocketPath(dataDir: string, platform: NodeJS.Platform = process.platform, user = safeUser()) {
  if (platform === 'win32') return `\\\\.\\pipe\\smartsell-agent-${user.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
  return join(dataDir, 'ipc.sock');
}

function safeUser() {
  try { return userInfo().username; } catch { return 'user'; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Strict shape check used by both ends; anything else is refused. */
export function isHandoffMessage(value: unknown): value is HandoffMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message).sort().join(',');
  return keys === 'bytes,mtime_ms,path,sha256,type,upload_id' && message.type === 'handoff' &&
    typeof message.upload_id === 'string' && uuid.test(message.upload_id) &&
    typeof message.path === 'string' && message.path.length <= 4096 && (isAbsolute(message.path) || win32.isAbsolute(message.path)) &&
    typeof message.sha256 === 'string' && /^[a-f0-9]{64}$/.test(message.sha256) &&
    typeof message.bytes === 'number' && Number.isSafeInteger(message.bytes) && message.bytes > 0 &&
    typeof message.mtime_ms === 'number' && Number.isFinite(message.mtime_ms);
}

/** Relay side of C12: one JSON line out, one JSON line back. Resolves false when no App is listening. */
export function createHandoffClient(socketPath: string, { timeoutMs = 3000 } = {}): HandoffClient {
  return {
    handoff(message) {
      return new Promise(resolve => {
        let settled = false;
        let buffer = '';
        const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(ok); };
        const socket = createConnection(socketPath);
        const timer = setTimeout(() => finish(false), timeoutMs);
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          const index = buffer.indexOf('\n');
          if (index === -1) { if (buffer.length > 4096) finish(false); return; }
          try { finish((JSON.parse(buffer.slice(0, index)) as HandoffReply).ok === true); } catch { finish(false); }
        });
        socket.on('error', () => finish(false));
        socket.on('close', () => finish(false));
      });
    },
  };
}

/**
 * Reference App side of C12 (S9's app/upload-handoff.ts may use it). `accept` decides and starts continueUpload();
 * it must check the message against the hub session (path, SHA-256, size) before saying yes.
 */
export function createHandoffServer(socketPath: string, accept: (message: HandoffMessage) => Promise<boolean> | boolean): Promise<Server> {
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    const reply = (value: HandoffReply) => socket.end(`${JSON.stringify(value)}\n`);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', async (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8192) return socket.destroy();
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      let message: unknown;
      try { message = JSON.parse(buffer.slice(0, index)); } catch { return reply({ ok: false, error: 'invalid_json' }); }
      if (!isHandoffMessage(message)) return reply({ ok: false, error: 'invalid_message' });
      try { reply({ ok: await accept(message) }); } catch { reply({ ok: false, error: 'rejected' }); }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(server); });
  });
}
