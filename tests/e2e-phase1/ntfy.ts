// A fake ntfy server (§10.2 stack step 2): records every JSON publish the hub sends. Loopback only.
import { createServer } from 'node:http';

export interface NtfyPush { topic: string; title: string; message: string; click: string | null; priority: number | null; at: string; authorization: string | null }
export interface FakeNtfy {
  readonly origin: string;
  /** The topic URL to configure in hub_alerts_update_channels. */
  readonly topicUrl: string;
  pushes(): NtfyPush[];
  close(): Promise<void>;
}

export async function startFakeNtfy(topic = 'smartsell-e2e'): Promise<FakeNtfy> {
  const pushes: NtfyPush[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* recorded as empty */ }
      pushes.push({
        topic: String(body.topic ?? ''), title: String(body.title ?? ''), message: String(body.message ?? ''),
        click: typeof body.click === 'string' ? body.click : null, priority: typeof body.priority === 'number' ? body.priority : null,
        at: new Date().toISOString(), authorization: request.headers.authorization ?? null,
      });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: String(pushes.length), event: 'message' }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    topicUrl: `${origin}/${topic}`,
    pushes: () => pushes.map(push => ({ ...push })),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
