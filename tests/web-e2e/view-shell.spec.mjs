import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';
import { previousCodexRouting } from '../../apps/web/src/view/pages/setup-codex-routing.ts';

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

test('guided enrollment registers both stdio clients and preflight leaves verification pending', async ({ page, dev }) => {
  const { app, rest } = await ownerSession(page, dev);
  const old = await rest('POST', '/agent-connections', { label: 'Previously issued', client: 'claude_code' }, 201);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(text) {
      if (!globalThis.allowPromptCopy) throw new Error('Clipboard disabled in fixture');
      globalThis.didCopyPrompt = text.startsWith("python3 -I - <<'SMARTSELL_SETUP'");
    } } });
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`${app}/get-started?step=agent`);
  const step = page.getByRole('region', { name: '主 Agent', exact: true });
  const next = step.getByRole('button', { name: '下一步', exact: true });
  const refresh = step.getByRole('button', { name: '重新檢查狀態' });
  const check = step.getByRole('textbox', { name: '核對提示詞' });
  await expect(check).toBeVisible();
  expect(!(await check.inputValue()).includes(old.token)).toBe(true);
  await step.getByRole('button', { name: '複製核對提示詞' }).press('Enter');
  await expect(step.getByText('已選取文字，請用鍵盤快捷鍵手動複製。')).toBeVisible();
  expect(await check.evaluate(field => field.selectionStart === 0 && field.selectionEnd === field.value.length)).toBe(true);
  await refresh.click();
  await expect(next).toHaveCount(0);
  await expectNoHorizontalOverflow(page, 'old connection at 360px');

  const home = await mkdtemp(join(tmpdir(), 'smartsell-agent-prompt-'));
  try {
    const bin = join(home, 'bin');
    await mkdir(bin);
    const codexHome = join(home, 'custom-codex-home');
    await mkdir(codexHome);
    const defaultRules = join(codexHome, 'AGENTS.md');
    const rules = join(codexHome, 'AGENTS.override.md');
    const userRules = '# Existing override\r\nKeep these rules verbatim.';
    await writeFile(defaultRules, '# Existing default');
    await writeFile(rules, userRules);
    // CLI doubles record only stdio registrations. The relay itself runs against the disposable server.
    const cliFixture = `#!/bin/sh
if [ "$1" = mcp ] && [ "$2" = get ]; then
  python3 -I -c 'import json, sys; from pathlib import Path; name, command, *args = Path.home().joinpath("codex.registration").read_text().splitlines(); assert name == sys.argv[1]; print(json.dumps({"enabled": True, "transport": {"type": "stdio", "command": command, "args": args}}))' "$3"
  exit $?
fi
[ "$1" = mcp ] && [ "$2" = add ] || exit 1
shift 2
if [ "$(basename "$0")" = claude ]; then
  [ "$1 $2 $3 $4" = "--transport stdio --scope user" ] || exit 1
  shift 4
fi
[ "$2" = -- ] && [ "$4" = -I ] && [ -f "$5" ] || exit 1
printf '%s\\n' "$1" "$3" "$4" "$5" > "$HOME/$(basename "$0").registration"
`;
    for (const cli of ['codex', 'claude']) await writeFile(join(bin, cli), cliFixture, { mode: 0o700 });
    const terminal = String.raw`
import errno, json, os, pty, sys, termios
path, secret = json.load(sys.stdin)
pid, fd = pty.fork()
if pid == 0:
    os.execl('/bin/sh', 'sh', path)
buffer = b''
sent = False
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError as error:
        if error.errno != errno.EIO: raise
        break
    if not chunk: break
    buffer += chunk
    if not sent and '貼上一次性接入碼'.encode() in buffer:
        assert not termios.tcgetattr(fd)[3] & termios.ECHO
        os.write(fd, secret.encode() + b'\n')
        sent = True
print(buffer.decode(errors='replace').replace(secret, '[redacted]'))
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;
    const run = (executable, args, input = '') => new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: home, env: { HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:${process.env.PATH}` }, timeout: 30_000 });
      let out = '';
      child.stdout.setEncoding('utf8').on('data', text => { out += text; });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.on('error', reject);
      child.on('close', code => resolve({ code, out }));
    });
    const installed = new Set();
    for (const [client, cli] of [['codex', 'codex'], ['claude_code', 'claude']]) {
      const english = cli === 'claude';
      if (english) await page.getByRole('combobox').filter({ has: page.getByRole('option', { name: 'English' }) }).selectOption('en');
      const panel = english ? page.getByRole('region', { name: 'Main agent', exact: true }) : step;
      await panel.getByRole('button', { name: english ? 'Add another connection' : '產生新的接入提示詞' }).click();
      await panel.getByRole('combobox', { name: english ? 'Agent client' : '用哪個 Agent' }).selectOption(client);
      await panel.getByRole('button', { name: english ? 'Generate setup prompt' : '產生接入提示詞', exact: true }).click();
      const field = panel.locator('.setup-agent-current').getByRole('textbox', { name: english ? 'Local terminal command' : '本機終端機指令', exact: true });
      await expect(field).toBeVisible();
      await expectNoHorizontalOverflow(page, `${cli} prompt at 360px`);
      const prompt = await field.inputValue();
      const enrollmentCode = await panel.getByRole('textbox', { name: english ? /One-time code/ : /一次性接入碼/ }).inputValue();
      expect(prompt.startsWith("python3 -I - <<'SMARTSELL_SETUP'")).toBe(true);
      expect(prompt.includes(`${dev.origin}/mcp`) && !prompt.includes(old.token) && !prompt.includes(enrollmentCode)).toBe(true);
      if (!english) {
        await page.evaluate(() => { globalThis.allowPromptCopy = true; });
        await step.getByRole('button', { name: '複製終端機指令' }).press('Enter');
        await expect(step.getByText('已複製提示詞。')).toBeVisible();
        expect(await page.evaluate(() => globalThis.didCopyPrompt)).toBe(true);
        await step.getByRole('button', { name: '暫時跳過這一步' }).click();
        await page.getByRole('region', { name: '桌面 Worker' }).getByRole('button', { name: '上一步' }).click();
        expect((await field.inputValue()) === prompt).toBe(true);
        await refresh.click();
        await expect(next).toHaveCount(0);
      }
      const installer = join(home, `${cli}.sh`);
      await writeFile(installer, `${prompt}\n`);
      const result = await run('python3', ['-I', '-c', terminal], JSON.stringify([installer, enrollmentCode]));
      expect(result.code, result.out).toBe(0);
      expect(result.out.includes('ss_command_')).toBe(false);
      expect(result.out).toContain('MCP 預檢通過');
      const directory = (await readdir(home)).find(name => name.startsWith('.smartsell-') && !installed.has(name));
      expect(Boolean(directory)).toBe(true);
      installed.add(directory);
      const folder = join(home, directory);
      expect((await stat(folder)).mode & 0o777).toBe(0o700);
      expect((await stat(join(folder, 'bearer'))).mode & 0o777).toBe(0o600);
      const [name, executable, ...args] = (await readFile(join(home, `${cli}.registration`), 'utf8')).trim().split('\n');
      const issued = (await rest('GET', '/agent-connections')).find(row => name === `smartsell-${row.id.replaceAll('-', '')}`);
      expect(issued).toMatchObject({ client });
      expect(issued.mcp_client_verified_at).toBeUndefined();
      const replay = await run('/bin/sh', [installer]);
      expect(replay.code, replay.out).toBe(0); // Retrying uses the saved bearer and requires no second code.
      const messages = [
        { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: cli, version: 'fixture' } } },
        { method: 'notifications/initialized' },
        { id: 2, method: 'tools/list' },
        { id: 3, method: 'tools/call', params: { name: 'smartsell_operations_describe', arguments: {} } },
      ];
      const native = await run(executable, args, messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
      expect(native.code).toBe(0);
      const responses = native.out.trim().split('\n').map(JSON.parse);
      expect(responses.find(message => message.id === 2).result.tools.map(tool => tool.name)).toContain('smartsell_operations_describe');
      expect(responses.find(message => message.id === 3).result.isError).toBeFalsy();
      if (english) {
        const row = panel.getByRole('listitem').filter({ hasText: 'Claude Code' });
        await expect(row).toContainText('Recent MCP activity', { timeout: 15_000 });
      } else {
        await refresh.click();
        await expect(next).toBeVisible();
        const installedRules = await readFile(rules, 'utf8');
        expect(installedRules.startsWith(`${userRules}\n\n`)).toBe(true);
        expect(installedRules.match(/BEGIN SmartSell managed social routing/g)).toHaveLength(1);
        expect(installedRules).toContain('mode: "recent_posts", platform: "x"');
        expect(await readFile(defaultRules, 'utf8')).toBe('# Existing default');
        await page.reload();
        const repair = step.locator('details').filter({ hasText: '修復 Codex 連線或補上社媒路由' });
        await repair.locator('summary').click();
        const repairCommand = await repair.getByRole('textbox', { name: '本機終端機指令', exact: true }).inputValue();
        const registration = join(home, `${cli}.registration`);
        const originalTime = (await stat(registration)).mtimeMs;
        const userSuffix = '\n\n# Other instructions\r\nLeave this intact.';
        const originalBlock = `${userRules}\n\n${previousCodexRouting}${userSuffix}`;
        const upgradedBlock = `${installedRules.trimEnd()}${userSuffix}`;
        expect(upgradedBlock).toContain('UUID v4');
        const editedBlock = originalBlock.replace('其他工作照常。', '使用者修改了這段。');
        await writeFile(rules, editedBlock);
        expect((await run('/bin/sh', [], `${repairCommand}\n`)).code).toBe(1);
        expect(await readFile(rules, 'utf8')).toBe(editedBlock);
        await writeFile(rules, originalBlock);
        for (let attempt = 0; attempt < 2; attempt++) {
          const repaired = await run('/bin/sh', [], `${repairCommand}\n`);
          expect(repaired.code, repaired.out).toBe(0);
          expect(await readFile(rules, 'utf8')).toBe(upgradedBlock);
          expect((await stat(registration)).mtimeMs).toBe(originalTime);
        }
      }
      const connections = await rest('GET', '/agent-connections');
      expect(connections.some(row => row.client === client && row.id !== old.id && row.mcp_client_verified_at)).toBe(true);
      expect(connections.some(row => row.id === old.id && !row.revoked && !row.last_used_at)).toBe(true);
    }
    await expect(page.getByRole('region', { name: 'Main agent' }).getByRole('button', { name: 'Next step' })).toBeVisible();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an agent enters a launch over MCP and the owner sees it and approves it in the dashboard', async ({ page, dev }) => {
  test.setTimeout(150_000);
  const { ws, root, app, rest } = await ownerSession(page, dev);

  // A person connects the agent; the token is shown once.
  const connection = await rest('POST', '/agent-connections', { label: agentLabel, client: 'claude_code', expires_days: 30 }, 201);
  expect(connection).toMatchObject({ label: agentLabel, client: 'claude_code', token: expect.any(String), mcp_url: `${dev.origin}/mcp` });

  // An issued credential alone leaves setup on the first step until the agent connects.
  await page.goto(`${dev.origin}/`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: '開始設定', exact: true })).toBeVisible();
  await expect(page).toHaveURL(url => url.pathname === `/app/${ws}/get-started`);
  const agentStep = main.getByRole('region', { name: '主 Agent', exact: true });
  await expect(agentStep.getByText('第 1 步，共 2 步', { exact: true })).toBeVisible();
  const issued = agentStep.getByRole('listitem').filter({ hasText: agentLabel });
  await expect(issued).toContainText('憑證已發出，尚未使用');
  await main.getByRole('link', { name: '稍後設定，前往總覽', exact: true }).click();
  await expect(page).toHaveURL(app);
  const nav = page.getByRole('navigation', { name: '看板導覽' });
  await expect(nav).toBeVisible();
  await expect(main.getByRole('heading', { name: '總覽', exact: true })).toBeVisible();
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
