import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ViewLang } from '@smartsell/ui';
import { viewKey } from './data/keys';

// The shell imports page stylesheets (bundled by Vite); under Node a stylesheet is an empty module.
registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
// The app's i18n module reads browser storage at import time; give it just enough of a browser.
const globals = globalThis as unknown as { localStorage?: unknown; document?: unknown };
globals.localStorage ??= { getItem: () => null, setItem: () => undefined };
globals.document ??= { documentElement: {} };

const ws = 'w1';
async function render(presence: unknown) {
  const { ViewContext } = await import('./data/use-view');
  const { ViewShell } = await import('./ViewShell');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(viewKey(ws, '/agent-connections'), { data: [] });
  client.setQueryData(viewKey(ws, '/views/agent-presence'), { data: presence });
  const session = { user: { name: 'Owner', email: 'owner@example.com' }, workspaces: [{ id: ws, name: 'Shop' }] };
  const context = { ws, base: `/app/${ws}`, session, workspace: session.workspaces[0]! };
  const out = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/app/${ws}/ads`]}><ViewLang lang="zh">
    <ViewContext.Provider value={context}><ViewShell /></ViewContext.Provider></ViewLang></MemoryRouter></QueryClientProvider>);
  return { out, paths: client.getQueryCache().getAll().map(query => query.queryKey[3]) };
}

test('the shell lights the Agent indicator from the presence read, not the whole home view', async () => {
  const active = await render({ connections: 1, last_seen_at: new Date(Date.now() - 5 * 60_000).toISOString(), timezone: 'Asia/Taipei' });
  assert.match(active.out, /Agent 運作中/);
  assert.ok(active.paths.includes('/views/agent-presence'));
  assert.ok(!active.paths.includes('/views/home'));
  assert.match((await render({ connections: null, last_seen_at: null, timezone: 'UTC' })).out, /尚未連接 Agent/);
});
