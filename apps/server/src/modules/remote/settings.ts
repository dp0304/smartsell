// Remote control settings per machine (design E50). A person turns it on for one machine and lists the sites (browser)
// and apps (phone) the owner's Agent may operate there; an Agent can never change this (requireHuman), and the Worker
// enforces the same lists.
import { ADMIN, Problem, REMOTE_CONTROL_OFF, type Context, type Data, type Operation, type RemoteControlSettings, type Row } from '@smartsell/contracts';
import { requireHuman } from '../../agent-actor.js';
import { audit } from '../account/input.js';
import { workerEngine } from '../account/channel-settings.js';

const HOST = /^(\*\.)?(?=.{1,253}(:\d{1,5})?$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/;
const PACKAGE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/;
const invalid = (path: string, message: string) => new Problem(422, 'INVALID_ARGUMENTS', `欄位不正確：${path}`, { issues: [{ path, message }] });

/** The machine's settings, normalised; off when never set. */
export function remoteSettings(device: Row): RemoteControlSettings {
  const value = device.remote_control as Partial<RemoteControlSettings> | undefined;
  if (!value || typeof value !== 'object') return REMOTE_CONTROL_OFF;
  const list = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
  return {
    browser: { enabled: value.browser?.enabled === true, sites: list(value.browser?.sites) },
    phone: { enabled: value.phone?.enabled === true, apps: list(value.phone?.apps) },
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : null,
  };
}

/** `https://Seller.Shopee.tw/portal` → `seller.shopee.tw`; refuses anything that is not a host (optionally `*.` and a port). */
export function normaliseSite(input: unknown, index: number) {
  if (typeof input !== 'string') throw invalid(`browser.sites.${index}`, '需為網址或網域');
  const value = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!HOST.test(value) || value === '*' || /^\*\.[^.]+$/.test(value)) throw invalid(`browser.sites.${index}`, '需為網域，例如 seller.shopee.tw');
  return value;
}

function parse(body: Data): Omit<RemoteControlSettings, 'updated_at'> {
  const extra = Object.keys(body).filter(item => item !== 'browser' && item !== 'phone');
  if (extra.length) throw invalid(extra[0], '不認得的欄位');
  const object = (value: unknown, path: string, keys: string[]) => {
    if (value === undefined) return {} as Data;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(path, '需為物件');
    const unknown = Object.keys(value).find(item => !keys.includes(item));
    if (unknown) throw invalid(`${path}.${unknown}`, '不認得的欄位');
    return value as Data;
  };
  const browser = object(body.browser, 'browser', ['enabled', 'sites']);
  const phone = object(body.phone, 'phone', ['enabled', 'apps']);
  const bool = (value: unknown, path: string) => { if (value !== undefined && typeof value !== 'boolean') throw invalid(path, '需為 true 或 false'); return value === true; };
  const array = (value: unknown, path: string) => {
    if (value === undefined) return [] as unknown[];
    if (!Array.isArray(value) || value.length > 50) throw invalid(path, '需為最多 50 項的清單');
    return value as unknown[];
  };
  const sites = [...new Set(array(browser.sites, 'browser.sites').map(normaliseSite))];
  const apps = [...new Set(array(phone.apps, 'phone.apps').map((item, index) => {
    if (typeof item !== 'string' || !PACKAGE.test(item.trim()) || item.length > 200) throw invalid(`phone.apps.${index}`, '需為 Android 套件名稱，例如 com.xingin.xhs');
    return item.trim();
  }))];
  return { browser: { enabled: bool(browser.enabled, 'browser.enabled'), sites }, phone: { enabled: bool(phone.enabled, 'phone.enabled'), apps } };
}

function update(ctx: Context, id: string, body: Data) {
  requireHuman(ctx, 'hub_machines_remote_control');
  const next = parse(body);
  const device = ctx.get('connector_device', id);
  if (device.status === 'revoked') throw new Problem(409, 'DEVICE_INACTIVE', '這台機器已撤銷');
  if (next.browser.enabled && !next.browser.sites.length) throw invalid('browser.sites', '開啟瀏覽器遙控時，至少要列一個允許的網站');
  if (next.phone.enabled && !next.phone.apps.length) throw invalid('phone.apps', '開啟手機遙控時，至少要列一個允許的 App');
  const settings: RemoteControlSettings = { ...next, updated_at: ctx.now };
  ctx.update('connector_device', device.id, { remote_control: settings });
  workerEngine().bumpSyncGeneration(ctx, [device.id], 'remote_control');
  audit(ctx, 'account.device.remote_control', { device_id: device.id, browser: settings.browser, phone: settings.phone });
  ctx.emit('account.device.updated', { device_id: device.id, fields: ['remote_control'] });
  return { machine_id: device.id, remote_control: settings };
}

export const remoteOperations: Operation[] = [{
  method: 'PUT', path: '/hub/machines/:id/remote-control', name: 'hub_machines_remote_control', roles: ADMIN,
  summary: 'Turn remote control of this machine\'s Chrome or phone on or off and list the allowed sites and apps (person only)',
  contract: { bodyRequired: true, body: { type: 'object', additionalProperties: false, properties: {
    browser: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' }, sites: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 300 } } } },
    phone: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' }, apps: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 } } } },
  } } },
  run(ctx, input) { return update(ctx, input.params.id!, input.body); },
}];
