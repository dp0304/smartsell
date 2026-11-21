import { readFile } from 'node:fs/promises';

const workspaceIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const brandingFields = ['workspace_id', 'label', 'accent', 'logo_data_url', 'portal_origin'];

async function run() {
  const [url, file, ...extra] = process.argv.slice(2);
  if (!url || !file || extra.length) throw new Error('Usage: node branding-batch.mjs <staff-api-origin> <branding.json>');
  const origin = new URL(url);
  if (url !== origin.origin || (origin.protocol !== 'https:' &&
    !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Error('Use an HTTPS staff API origin or a loopback HTTP origin');
  }
  const cookie = process.env.SMARTSELL_STAFF_SESSION_COOKIE;
  if (!cookie || !/^(?:__Host-)?smartsell_session=[A-Za-z0-9_-]{43}$/.test(cookie)) {
    throw new Error('Set SMARTSELL_STAFF_SESSION_COOKIE to the staff session cookie name and value');
  }

  const settings = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(settings) || settings.length < 1 || settings.length > 50) throw new Error('Expected 1–50 workspace settings');
  const workspaceIds = new Set();
  for (const [index, entry] of settings.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.workspace_id !== 'string' || !workspaceIdPattern.test(entry.workspace_id) ||
      Object.keys(entry).some(field => !brandingFields.includes(field)) || workspaceIds.has(entry.workspace_id) ||
      typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 80 ||
      typeof entry.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry.accent)) {
      throw new Error(`Invalid or duplicate workspace setting at row ${index + 1}`);
    }
    workspaceIds.add(entry.workspace_id);
  }

  const request = (path, options = {}) => fetch(new URL(path, origin), {
    ...options, headers: { cookie, origin: origin.origin, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  const session = await request('/api/v1/session');
  if (!session.ok) throw new Error(`Staff session check failed (HTTP ${session.status})`);
  const { csrf_token: csrf } = (await session.json()).data;
  if (!csrf) throw new Error('Staff session did not return a CSRF token');

  const results = [];
  for (const { workspace_id, ...branding } of settings) {
    try {
      const response = await request(`/api/v1/workspaces/${workspace_id}/branding`, {
        method: 'PUT', body: JSON.stringify(branding), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      });
      const payload = await response.json();
      results.push({ workspace_id, status: response.status, ...(response.ok ? {} : { code: payload.code }) });
      if (!response.ok) process.exitCode = 1;
    } catch {
      results.push({ workspace_id, code: 'OUTCOME_UNKNOWN' });
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

run().catch(error => {
  console.error(error instanceof SyntaxError ? 'Invalid JSON input or response' : error.message);
  process.exitCode = 1;
});
