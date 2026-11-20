import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

// The agent-first loop: a person connects an agent, the agent enters everything over MCP,
// and the person only looks at the dashboard and makes the decision the agent may not make.
const test = base.extend({ dev: localDev });
test.use({ viewport: { width: 1280, height: 800 }, trace: 'off', screenshot: 'off', video: 'off' });

const day = 86_400_000;
const agentLabel = 'E2E Claude';
const names = { brand: '晨光保養', store: '晨光官方商店', product: '夏日防曬乳', plan: '夏季防曬上市計劃', content: '防曬乳開箱貼文', account: '晨光粉絲專頁' };

/** First-time setup through REST; the browser context keeps the owner session cookie. */
async function ownerSession(page, dev) {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { name: 'Dashboard owner', email: 'owner@example.test', workspaceName: '晨光品牌', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { data: { workspaces: [workspace] } } = await setup.json();
  const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  expect(csrf.status()).toBe(200);
  const { csrf_token } = await csrf.json();
  const root = `/api/v1/workspaces/${workspace.id}`;
  async function rest(method, path, data, status) {
    const response = await page.request.fetch(`${dev.origin}${root}${path}`, { method, data,
      headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID() } });
    const text = await response.text();
    if (status === undefined) expect(response.ok(), `${method} ${path}: ${text}`).toBe(true);
    else expect(response.status(), `${method} ${path}: ${text}`).toBe(status);
    return text ? JSON.parse(text).data : undefined;
  }
  return { ws: workspace.id, root, app: `${dev.origin}/app/${workspace.id}`, rest };
}

/** A minimal MCP client over streamable HTTP, as a local agent would use it with the bearer token. */
function mcpClient(url, token) {
  async function rpc(method, params = {}) {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` } });
    const text = await response.text();
    expect(response.status, `MCP ${method}: ${text}`).toBe(200);
    // A server may answer with one JSON body or with a single SSE message.
    const body = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('') : text;
    const message = JSON.parse(body);
    expect(message.error, `MCP ${method}: ${body}`).toBeUndefined();
    return message.result;
  }
  const tool = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  return {
    rpc, tool,
    /** Calls a curated tool and returns its data; tool errors fail with the server's field message. */
    async write(name, args) {
      const result = await tool(name, { idempotency_key: `e2e-${name}-${randomUUID()}`, ...args });
      expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeFalsy();
      return result.structuredContent.data;
    },
  };
}

function responseFor(page, method, path) {
  const pending = page.waitForResponse(response =>
    response.request().method() === method && new URL(response.url()).pathname === path, { timeout: 10_000 });
  void pending.catch(() => {});
  return pending;
}

async function expectNoHorizontalOverflow(page, where) {
  const width = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(width.content, `document scroll width on ${where}`).toBeLessThanOrEqual(width.viewport);
}

test('an agent enters a launch over MCP and the owner sees it and approves it in the dashboard', async ({ page, dev }) => {
  test.setTimeout(150_000);
  const { ws, root, app, rest } = await ownerSession(page, dev);

  // A person connects the agent; the token is shown once.
  const connection = await rest('POST', '/agent-connections', { label: agentLabel, client: 'claude_code', expires_days: 30 }, 201);
  expect(connection).toMatchObject({ label: agentLabel, client: 'claude_code', token: expect.any(String), mcp_url: `${dev.origin}/mcp` });

  // Signing in lands on the dashboard overview. Before the agent has done anything, pages say what to ask it.
  await page.goto(`${dev.origin}/`);
  await expect(page).toHaveURL(app);
  const nav = page.getByRole('navigation', { name: '看板導覽' });
  await expect(nav).toBeVisible();
  await expect(page.getByRole('heading', { name: '總覽', exact: true })).toBeVisible();
  const main = page.getByRole('main');
  await nav.getByRole('link', { name: '商品', exact: true }).click();
  await expect(page).toHaveURL(`${app}/products`);
  await expect(page.getByRole('heading', { level: 1, name: '商品' })).toBeVisible();
  await expect(main.getByText('請你的 Agent：', { exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: '複製', exact: true }).first()).toBeVisible();

  // The agent's session: handshake, then only the tools an agent may use.
  const agent = mcpClient(connection.mcp_url, connection.token);
  const initialized = await agent.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'web-e2e-agent', version: '1' } });
  expect(initialized.instructions).toMatch(/HUMAN_REQUIRED/);
  const tools = (await agent.rpc('tools/list')).tools.map(entry => entry.name);
  for (const name of ['workspace_brand_create', 'commerce_product_create', 'campaign_create_draft', 'content_create_item',
    'content_create_variant', 'content_commit_revision', 'publishing_create_target', 'publishing_request_approval']) expect(tools).toContain(name);
  expect(tools).not.toContain('publishing_approve');

  const brand = await agent.write('workspace_brand_create', { body: { name: names.brand, slug: `morning-${Date.now()}` } });
  expect(brand.created_via).toBe('agent');
  // Registering an owned social account is a person's step, done for the brand the agent set up.
  const account = await rest('POST', '/social-accounts', { provider: 'meta_facebook', external_account_id: `e2e-${randomUUID()}`,
    display_name: names.account, brand_id: brand.id, owned_account_confirmed: true });
  const store = await agent.write('commerce_store_create', { body: { brand_id: brand.id, name: names.store, provider: 'shopify',
    default_currency: 'TWD', default_locale: 'zh-Hant' } });
  const product = await agent.write('commerce_product_create', { body: { store_id: store.id, title: names.product, status: 'active' } });
  expect(product.created_via).toBe('agent');
  const plan = await agent.write('campaign_create_draft', { body: { brand_id: brand.id, name: names.plan, kind: 'launch', timezone: 'UTC',
    starts_at: new Date(Date.now() - day).toISOString(), ends_at: new Date(Date.now() + 30 * day).toISOString(),
    products: [{ product_id: product.id, role: 'hero' }] } });
  const { item } = await agent.write('content_create_item', { body: { brand_id: brand.id, campaign_id: plan.id, title: names.content } });
  const { variant } = await agent.write('content_create_variant', { params: { id: item.id },
    body: { platform: 'facebook', market: 'TW', format: 'text', body_markdown: '夏天出門前，先擦一層防曬。' } });
  await agent.write('content_commit_revision', { params: { id: variant.id }, body: { expected_version: variant.version, base_revision_id: null } });
  // The agent reads the account the person registered instead of being handed an id.
  const accounts = await agent.write('account_list_social_accounts', { query: { brand_id: brand.id } });
  expect(accounts.map(row => [row.id, row.display_name])).toEqual([[account.id, names.account]]);
  const [listed] = accounts;
  const target = await agent.write('publishing_create_target', { body: { social_account_id: listed.id, content_variant_id: variant.id,
    scheduled_at: new Date(Date.now() + 2 * day).toISOString() } });
  const submitted = await agent.write('publishing_request_approval', { params: { id: target.id }, expected_version: target.version, body: {} });
  expect(submitted.plan_status).toBe('awaiting_approval');

  // The agent cannot approve its own submission: that decision belongs to a person.
  const refused = await agent.tool('smartsell_operation_call', { operation: 'publishing_approve', params: { id: target.id },
    expected_version: submitted.version, body: {}, idempotency_key: `e2e-approve-${randomUUID()}` });
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent.error.code).toBe('HUMAN_REQUIRED');
  expect((await rest('GET', `/publish-targets/${target.id}`)).plan_status).toBe('awaiting_approval');

  // Overview: the pending decision is at the top, attributed to the agent.
  const homeRead = responseFor(page, 'GET', `${root}/views/home`);
  await page.goto(app);
  expect((await homeRead).status()).toBe(200);
  await expect(page.getByRole('heading', { name: '總覽', exact: true })).toBeVisible();
  // The overview lists decisions as compact rows that link to the decision page.
  const overviewDecision = main.locator('.vs-needs-list > li').filter({ hasText: names.content });
  await expect(overviewDecision).toBeVisible();
  await expect(overviewDecision).toContainText(agentLabel);
  await expect(overviewDecision.getByRole('link', { name: '去決定' })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^待你決定/ })).toContainText('1');
  await expect(page.getByRole('link', { name: 'Agent 運作中' })).toBeVisible();

  // Products and plans show what the agent created.
  await nav.getByRole('link', { name: '商品', exact: true }).click();
  await expect(page).toHaveURL(`${app}/products`);
  await expect(main.locator(`a[href="/app/${ws}/products/${product.id}"]`).first()).toBeVisible();
  await expect(main.getByText(names.product, { exact: true }).first()).toBeVisible();
  await nav.getByRole('link', { name: '推廣計劃', exact: true }).click();
  await expect(page).toHaveURL(`${app}/plans`);
  await expect(page.getByRole('heading', { level: 1, name: '推廣計劃' })).toBeVisible();
  await expect(main.locator(`a[href="/app/${ws}/plans/${plan.id}"]`).first()).toBeVisible();
  await expect(main.getByText(names.plan, { exact: true }).first()).toBeVisible();

  // Phone width: every page stays inside the viewport and the navigation moves behind the menu button.
  await page.setViewportSize({ width: 360, height: 780 });
  for (const path of ['', '/products', '/plans', '/calendar', '/social', '/ads', '/decisions', '/agent', '/settings']) {
    await page.goto(`${app}${path}`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    // Measure once every read on the page has rendered, not the loading placeholder.
    await expect(main.locator('.busy')).toHaveCount(0, { timeout: 10_000 });
    await expectNoHorizontalOverflow(page, `${path || '/'} at 360px`);
  }
  await page.getByRole('button', { name: '選單', exact: true }).click();
  await expect(nav.getByRole('link', { name: '總覽', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });

  // Decisions: the person sees what the agent proposed, who asked, and decides in one click.
  const decisionsRead = responseFor(page, 'GET', `${root}/views/decisions`);
  await page.goto(`${app}/decisions`);
  const decisions = (await (await decisionsRead).json()).data;
  expect(decisions).toEqual([expect.objectContaining({ kind: 'publish_approval', title: names.content,
    requested_by: { type: 'agent', label: agentLabel }, resource: expect.objectContaining({ type: 'publish_target', id: target.id }) })]);
  const decision = main.getByRole('article').filter({ has: page.getByRole('heading', { name: names.content }) });
  await expect(decision).toBeVisible();
  await expect(decision).toContainText('發布審批');
  await expect(decision).toContainText(agentLabel);
  await expect(decision).toContainText('夏天出門前，先擦一層防曬。');
  await expect(decision).toContainText(names.account);
  const approval = responseFor(page, 'POST', `${root}/publish-targets/${target.id}/approve`);
  await decision.getByRole('button', { name: '核准', exact: true }).click();
  const approved = await approval;
  expect(approved.status(), await approved.text()).toBe(200);
  await expect(decision).toHaveCount(0, { timeout: 10_000 });
  await expect(main.getByText('沒有需要你決定的事', { exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^待你決定/ })).toHaveText('待你決定');
  expect((await rest('GET', `/publish-targets/${target.id}`)).plan_status).toBe('ready');
  expect(await rest('GET', '/views/decisions')).toEqual([]);

  // Agent page: the connection is listed and the activity feed shows each agent write, then the person's approval.
  await nav.getByRole('link', { name: 'Agent', exact: true }).click();
  await expect(page).toHaveURL(`${app}/agent`);
  await expect(page.getByRole('heading', { level: 1, name: 'Agent' })).toBeVisible();
  await expect(main.getByText(agentLabel, { exact: true }).first()).toBeVisible();
  const entry = (summary, title) => main.getByRole('listitem').filter({ hasText: summary }).filter({ hasText: title });
  for (const [summary, title] of [['建立了品牌', names.brand], ['建立了商品', names.product], ['建立了推廣計劃', names.plan],
    ['建立了內容', names.content], ['建立了發布排期', names.content], ['送審了發布排期', names.content]]) {
    await expect(entry(summary, title), summary).toHaveCount(1);
    await expect(entry(summary, title), summary).toContainText(agentLabel);
  }
  // The approval is the person's own row (the read model does not name its resource yet).
  const decided = main.getByRole('listitem').filter({ hasText: '核准了發布' });
  await expect(decided).toHaveCount(1);
  await expect(decided).not.toContainText(agentLabel);
  const activity = await rest('GET', '/views/activity?actor=agent');
  expect(activity.every(row => row.actor.type === 'agent' && row.source === 'mcp' && row.actor.label === agentLabel)).toBe(true);
  expect(activity.map(row => row.action)).toEqual(expect.arrayContaining(['workspace_brand_create', 'commerce_product_create',
    'campaign_create_draft', 'content_create_item', 'publishing_create_target', 'publishing_request_approval']));
  expect(activity.map(row => row.action)).not.toContain('publishing_approve');
});
