// Subscriber of GET /api/v1/agent/alerts/stream with the agent token: the same stream the laptop App shows as OS
// notifications (§5.9 channel 2). Reconnects with Last-Event-ID across hub restarts, so nothing is missed.
import type { OwnerAlert } from '../../packages/contracts/src/index.ts';

export interface StreamedAlert extends OwnerAlert { seq: number; received_at: string }

export interface AlertRecorder {
  all(): StreamedAlert[];
  /** Resolves with the first alert matching `match` (already received or arriving within `timeoutMs`). */
  waitFor(match: (alert: StreamedAlert) => boolean, timeoutMs: number, label: string): Promise<StreamedAlert>;
  readonly connected: boolean;
  readonly reconnects: number;
  close(): void;
}

export function alertText(alert: Pick<OwnerAlert, 'title' | 'body'>) { return `${alert.title}\n${alert.body}`; }

export function subscribeAlerts(origin: string, token: string, log: (line: string) => void = () => {}): AlertRecorder {
  const alerts: StreamedAlert[] = [];
  const waiters = new Set<() => void>();
  const stop = new AbortController();
  let lastId: string | undefined;
  let connected = false;
  let reconnects = 0;

  async function once() {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'text/event-stream' };
    if (lastId !== undefined) headers['last-event-id'] = lastId;
    const response = await fetch(`${origin}/api/v1/agent/alerts/stream`, { headers, signal: stop.signal });
    if (response.status !== 200 || !response.body) throw new Error(`alert stream answered ${response.status}`);
    connected = true;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let id: string | undefined; let event: string | undefined; const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'id') id = value;
          else if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
        if (id !== undefined) lastId = id;
        if (event === 'owner_alert' && data.length) {
          const alert = JSON.parse(data.join('\n')) as OwnerAlert;
          alerts.push({ ...alert, seq: Number(id), received_at: new Date().toISOString() });
          log(`alert ${alert.kind} ${alert.severity}: ${alert.title} | ${alert.body}`);
          for (const wake of [...waiters]) wake();
        }
      }
    }
  }

  void (async () => {
    while (!stop.signal.aborted) {
      try { await once(); } catch (error) { if (stop.signal.aborted) break; log(`alert stream: ${String(error)}`); }
      connected = false;
      if (stop.signal.aborted) break;
      reconnects++;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  })();

  return {
    all: () => [...alerts],
    get connected() { return connected; },
    get reconnects() { return reconnects; },
    waitFor(match, timeoutMs, label) {
      const found = alerts.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`timed out after ${timeoutMs} ms waiting for alert: ${label}\nreceived: ${alerts.map(item => `${item.kind}(${item.title})`).join(', ') || 'none'}`)); }, timeoutMs);
        const check = () => {
          const hit = alerts.find(match);
          if (hit) { clearTimeout(timer); waiters.delete(check); resolve(hit); }
        };
        waiters.add(check);
      });
    },
    close() { stop.abort(); },
  };
}
