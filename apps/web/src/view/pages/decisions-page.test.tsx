import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@smartsell/sdk';
import { ViewLang, type DecisionItem } from '@smartsell/ui';

// i18n.ts reads the saved language and sets <html lang> when it loads.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) },
  document: { documentElement: { lang: 'zh-Hant' } },
});
const { ViewContext } = await import('../data/use-view');
const { viewKey } = await import('../data/keys');
const { DecisionsPage } = await import('./DecisionsPage');

const now = new Date().toISOString();
const decision = (id: string, kind: string): DecisionItem => ({
  id: `${kind}:${id}`, kind, severity: 'normal', title: `Item ${id}`, summary: null, created_at: now, due_at: null, brand_id: 'b1', campaign_id: 'c1',
  requested_by: { type: 'agent', label: null }, resource: { type: 'publish_target', id, version: 1, hash: null, route: null } as DecisionItem['resource'],
  preview: { text: null, fields: [] }, actions: [],
});
// The workspace-wide summary the nav badge reads, and the one scoped to brand b1 and plan c1.
const everywhere = { counts: { publish_approval: 9, change_set: 3, budget_approval: 0 }, total: 12, as_of: now };
const scoped = { counts: { publish_approval: 1, change_set: 0, budget_approval: 1 }, total: 2, as_of: now };

function render(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(viewKey('w1', '/views/decisions/summary'), { data: everywhere });
  client.setQueryData(viewKey('w1', '/views/decisions/summary', { brand_id: 'b1', campaign_id: 'c1' }), { data: scoped });
  client.setQueryData(viewKey('w1', '/views/decisions', { limit: '100' }), { data: [] });
  client.setQueryData(viewKey('w1', '/views/decisions', { brand_id: 'b1', campaign_id: 'c1', limit: '100' }), { data: [decision('t1', 'publish_approval'), decision('r1', 'budget_approval')] });
  const session = { csrf_token: 'x', workspaces: [{ id: 'w1', name: 'W' }] } as unknown as Session;
  return renderToStaticMarkup(<QueryClientProvider client={client}><ViewLang lang="zh"><MemoryRouter initialEntries={[path]}>
    <ViewContext.Provider value={{ ws: 'w1', session, workspace: session.workspaces[0]!, base: '/app/w1' }}>
      <Routes><Route path="/app/w1/decisions" element={<DecisionsPage />} /></Routes>
    </ViewContext.Provider>
  </MemoryRouter></ViewLang></QueryClientProvider>);
}
const chips = (out: string) => [...out.matchAll(/<button type="button" aria-pressed="(?:true|false)">([^<]+)<span class="vs-count"> (\d+)<\/span><\/button>/g)].map(match => [match[1], Number(match[2])]);

test('kind chips and the All total count the brand and plan the list is filtered to', () => {
  const out = render('/app/w1/decisions?brand=b1&campaign=c1');
  assert.deepEqual(chips(out), [['全部', 2], ['發布審批', 1], ['預算審批', 1]]);
  assert.match(out, /Item t1/);
});

test('without filters the chips read the same workspace-wide summary as the nav badge', () => {
  assert.deepEqual(chips(render('/app/w1/decisions')), [['全部', 12], ['發布審批', 9], ['變更集', 3]]);
});

test('a decision the server did not carry out stays explained after its card has left the list', async () => {
  const { rememberUnfinished } = await import('../data/use-view');
  rememberUnfinished('w1', { id: 'publish_approval:t9', kind: 'publish_approval', title: 'Winter launch', outcome: { kind: 'expired' } });
  rememberUnfinished('w1', { id: 'change_set:s1', kind: 'change_set', title: 'Caption fixes', outcome: { kind: 'partial', skipped: 2 } });
  const out = render('/app/w1/decisions');
  assert.match(out, /Winter launch/);
  assert.match(out, /已過截止時間而失效/);
  assert.match(out, /Caption fixes/);
  assert.match(out, /只套用了一部分：2 項/);
  assert.match(out, /知道了/);
  // Another workspace never sees them.
  rememberUnfinished('w2', { id: 'change_set:s2', kind: 'change_set', title: 'Other workspace', outcome: { kind: 'stale' } });
  assert.doesNotMatch(render('/app/w1/decisions'), /Other workspace/);
});
