import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { workspacePath } from '@smartsell/sdk';
import { viewPrefix } from './keys';

type Source = Pick<EventSource, 'addEventListener' | 'close'>;
interface Entry { source: Source; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout>; firstAt?: number; dropped: boolean }
export interface StreamOptions { delay?: number; maxWait?: number; open?: (url: string) => Source; now?: () => number }

const streams = new Map<string, Entry>();

/**
 * One shared EventSource per workspace for every dashboard subscriber. `workspace.changed` carries no
 * payload and an agent import fires it per row, so invalidations are debounced; maxWait keeps a
 * continuous burst from postponing the refresh forever.
 */
export function subscribeViewStream(ws: string, listener: () => void, options: StreamOptions = {}) {
  const { delay = 1500, maxWait = 6000, open = url => new EventSource(url), now = Date.now } = options;
  let entry = streams.get(ws);
  if (!entry) {
    const created: Entry = { source: open(`${workspacePath(ws)}/stream`), listeners: new Set(), dropped: false };
    const fire = () => { created.timer = undefined; created.firstAt = undefined; for (const notify of [...created.listeners]) notify(); };
    const schedule = () => {
      const at = now();
      created.firstAt ??= at;
      clearTimeout(created.timer);
      created.timer = setTimeout(fire, Math.max(0, Math.min(delay, created.firstAt + maxWait - at)));
    };
    created.source.addEventListener('workspace.changed', schedule);
    // Changes made while the connection was down produce no event, so refresh once it is back.
    created.source.addEventListener('error', () => { created.dropped = true; });
    created.source.addEventListener('open', () => { if (created.dropped) { created.dropped = false; schedule(); } });
    streams.set(ws, created);
    entry = created;
  }
  const current = entry;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size) return;
    clearTimeout(current.timer);
    current.source.close();
    if (streams.get(ws) === current) streams.delete(ws);
  };
}

export const openStreamCount = () => streams.size;

export function useViewStream(ws: string) {
  const client = useQueryClient();
  useEffect(() => {
    if (!ws || typeof EventSource === 'undefined') return;
    return subscribeViewStream(ws, () => void client.invalidateQueries({ queryKey: viewPrefix(ws) }));
  }, [ws, client]);
}
