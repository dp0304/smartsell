import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp } from './src/app.js';
import { localStore } from './src/local.js';
import { LOCAL_SETUP_PASSWORD_MIN } from './src/setup-policy.js';

export type FirstOwner = { email: string; password: string; name: string; workspaceName: string };
const defaultFile = fileURLToPath(new URL('../../.local/smartsell.sqlite', import.meta.url));

/** Filesystem-owner bootstrap for the local preview. The normal setup route remains single use. */
export async function initializeLocalOwner(input: FirstOwner, env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'production' || env.DATABASE_URL || env.BACKGROUND_DATABASE_URL ||
      (env.SMARTSELL_STORE && env.SMARTSELL_STORE !== 'local')) {
    throw new Error('正式部署請使用 HTTPS 首次設定頁與部署環境的 SETUP_TOKEN。');
  }
  const store = localStore(resolve(env.SMARTSELL_DATA_FILE || defaultFile));
  const setupToken = randomBytes(32).toString('hex');
  const origin = 'http://127.0.0.1';
  const localOrigins = new Set([origin]);
  const { app } = buildApp({ store, registry: new Map(), secureCookie: false, origins: localOrigins, localSetupOrigins: localOrigins, setupToken });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/setup', remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1', origin, 'x-setup-token': setupToken }, payload: input });
    if (response.statusCode === 409) throw new Error('此工作區已完成首次設定。請以既有帳號登入。');
    if (response.statusCode !== 201) throw new Error(response.json<{ error: { message: string } }>().error.message);
    const cookie = response.cookies[0];
    if (cookie) await app.inject({ method: 'DELETE', url: '/api/v1/session', cookies: { [cookie.name]: cookie.value } });
  } finally { await app.close(); }
}

async function promptForOwner() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('請在本機互動式終端執行 pnpm setup:local。');
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const abort = new AbortController();
  rl.on('SIGINT', () => { abort.abort(); rl.close(); });
  const ask = (question: string) => rl.question(question, { signal: abort.signal });
  try {
    const email = (await ask('電子郵件 / Email: ')).trim();
    const name = (await ask('顯示名稱 / Name: ')).trim();
    const workspaceName = (await ask('工作區名稱 / Workspace: ')).trim();
    hidden = true;
    process.stdout.write(`密碼（至少 ${LOCAL_SETUP_PASSWORD_MIN} 個字元）/ Password (at least ${LOCAL_SETUP_PASSWORD_MIN} characters): `);
    const password = await ask('');
    process.stdout.write('\n再輸入一次 / Confirm: ');
    const confirm = await ask('');
    if (password !== confirm) throw new Error('兩次密碼不一致。');
    return { email, name, workspaceName, password };
  } finally { if (hidden) process.stdout.write('\n'); rl.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void promptForOwner().then(input => initializeLocalOwner(input)).then(() => {
    console.log('工作區已建立。執行 pnpm dev 後即可從工作台登入。');
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Local setup failed');
    process.exitCode = 1;
  });
}
