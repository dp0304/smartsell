import { createHash, randomUUID } from 'node:crypto';
import { ADMIN, Problem, READ, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { requireHuman } from '../../agent-actor.js';
import { createImportBatch } from '../ingest/import-operations.js';
import { requirePlatformPhase } from './domain.js';

const bindingKind = 'worker_catalog_binding';
const jobKind = 'worker_catalog_job';
const queueMs = 24 * 60 * 60_000;
const leaseMs = 15 * 60_000;
const fileLimit = 384 * 1024;
export const workerCatalogUploadBodyLimit = 1024 * 1024;

const portalHosts: Record<string, readonly string[]> = {
  shopify: ['admin.shopify.com'],
  tiktok_shop: ['seller.tiktok.com', 'seller-us.tiktok.com', 'seller-uk.tiktok.com', 'seller-id.tiktok.com', 'seller-ph.tiktok.com', 'seller-my.tiktok.com', 'seller-sg.tiktok.com', 'seller-th.tiktok.com', 'seller-vn.tiktok.com'],
  amazon_sp: ['sellercentral.amazon.com', 'sellercentral.amazon.ca', 'sellercentral.amazon.co.uk', 'sellercentral.amazon.de', 'sellercentral.amazon.co.jp', 'sellercentral.amazon.com.au'],
  shopee: ['seller.shopee.tw', 'seller.shopee.sg', 'seller.shopee.com.my', 'seller.shopee.co.th', 'seller.shopee.vn', 'seller.shopee.ph', 'seller.shopee.co.id', 'seller.shopee.com.br'],
  lazada: ['sellercenter.lazada.sg', 'sellercenter.lazada.com.my', 'sellercenter.lazada.co.th', 'sellercenter.lazada.vn', 'sellercenter.lazada.com.ph', 'sellercenter.lazada.co.id'],
};

/** Expected device request errors can commit the authenticated nonce without committing a partial import. */
export class WorkerCatalogRequestError extends Problem {}

function reject(code: string, status = 422): never {
  throw new WorkerCatalogRequestError(status, code, code);
}

function onlyFields(body: Data, allowed: readonly string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) reject('INVALID_WORKER_CATALOG_INPUT');
}

function exactText(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    reject('INVALID_WORKER_CATALOG_INPUT');
  }
  return value;
}

function portalUrl(value: unknown, provider: string, externalId: string) {
  if (value === undefined) return undefined;
  const raw = exactText(value, 2048);
  const url = URL.parse(raw);
  const authority = /^https:\/\/([^/?#]+)/.exec(raw)?.[1];
  if (!authority || authority.includes('@') || /[\\\s]/u.test(raw) || !url || url.username || url.password || url.port) {
    reject('WORKER_CATALOG_PORTAL_INVALID');
  }
  const domain = externalId.toLowerCase();
  const shopDomain = provider === 'shopify' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : undefined;
  const storePath = /^\/store\/([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(url.pathname);
  if (url.hostname === shopDomain) return `${url.origin}/admin`;
  if (!Object.hasOwn(portalHosts, provider) || !portalHosts[provider].includes(url.hostname)) reject('WORKER_CATALOG_PORTAL_INVALID');
  if (provider === 'shopify' && storePath) {
    if (shopDomain && `${storePath[1]}.myshopify.com` !== shopDomain) reject('WORKER_CATALOG_STORE_MISMATCH', 409);
    return `${url.origin}/store/${storePath[1]}`;
  }
  return `${url.origin}/`;
}

function externalStoreId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/|+-]{0,159}$/.test(value)) reject('INVALID_WORKER_CATALOG_INPUT');
  return value;
}

const deadline = (ctx: Context, ms: number) => new Date(Date.parse(ctx.now) + ms).toISOString();
const pending = (job: Row) => job.status === 'queued' || job.status === 'claimed';
const oldest = (a: Row, b: Row) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
const bindingFor = (ctx: Context, storeId: string) => ctx.list(bindingKind).find(row => row.store_id === storeId);

function bindingValid(binding: Row | undefined, store: Row | undefined, device: Row | undefined) {
  return Boolean(binding && store && device?.status === 'active' && store.status !== 'disabled' &&
    binding.store_id === store.id && binding.device_id === device.id && binding.external_store_id === store.external_store_id && binding.provider === store.provider);
}

export function workerCatalogBindingCounts(ctx: Context, device: Row) {
  const stores = new Map(ctx.list('store').map(store => [store.id, store]));
  const counts = new Map<string, number>();
  for (const binding of ctx.list(bindingKind)) {
    if (binding.device_id !== device.id || !bindingValid(binding, stores.get(String(binding.store_id)), device)) continue;
    const provider = String(binding.provider);
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

function jobBound(job: Row, binding: Row | undefined, store: Row | undefined, device: Row | undefined) {
  return bindingValid(binding, store, device) && job.binding_id === binding?.id && job.binding_version === binding?.version &&
    job.store_id === store?.id && job.provider === store?.provider && job.external_store_id === store?.external_store_id && job.device_id === device?.id;
}

function jobView(job: Row, status = job.status, errorCode = job.error_code) {
  return {
    id: job.id, store_id: job.store_id, device_id: job.device_id, store_name: job.store_name,
    provider: job.provider, external_store_id: job.external_store_id, portal_url: job.portal_url,
    status, expires_at: job.expires_at, import_id: job.import_id, error_code: errorCode,
  };
}

function catalog(ctx: Context) {
  const storeById = new Map(ctx.list('store').map(row => [row.id, row]));
  const devices = new Map(ctx.list('connector_device').map(row => [row.id, row]));
  const bindings = new Map(ctx.list(bindingKind).map(row => [row.store_id, row]));
  const imports = new Map(ctx.list('import_batch').filter(row => row.template_key === 'product_list').map(row => [row.id, row]));
  return {
    bindings: [...bindings.values()].flatMap(row => {
      const device = devices.get(String(row.device_id));
      return device && bindingValid(row, storeById.get(String(row.store_id)), device) ? [bindingView(row, device)] : [];
    }),
    jobs: ctx.list(jobKind).sort((a, b) => oldest(b, a)).slice(0, 200).map(job => {
      if (pending(job)) {
        if (!jobBound(job, bindings.get(String(job.store_id)), storeById.get(String(job.store_id)), devices.get(String(job.device_id)))) {
          return jobView(job, 'cancelled', 'WORKER_CATALOG_BINDING_CHANGED');
        }
        if (String(job.expires_at) <= ctx.now) return jobView(job, 'expired', 'WORKER_CATALOG_EXPIRED');
      }
      if (typeof job.import_id === 'string') {
        const batch = imports.get(job.import_id);
        if (!batch || batch.store_id !== job.store_id) return jobView(job, 'failed', 'WORKER_CATALOG_IMPORT_UNAVAILABLE');
        if (batch.status === 'merged' || batch.status === 'partially_merged') {
          return Number(batch.merged_rows) + Number(batch.skipped_rows) > 0 ? jobView(job, 'imported')
            : jobView(job, 'failed', 'WORKER_CATALOG_NO_ROWS_MERGED');
        }
        if (batch.status === 'cancelled') return jobView(job, 'cancelled');
        if (batch.status === 'awaiting_confirmation' && String(batch.expires_at) <= ctx.now) return jobView(job, 'expired', 'IMPORT_EXPIRED');
        return { ...jobView(job), expires_at: batch.expires_at };
      }
      return jobView(job);
    }),
  };
}

function bindingView(row: Row, device: Row) {
  return { store_id: row.store_id, device_id: device.id, device_name: device.name, external_store_id: row.external_store_id, portal_url: row.portal_url };
}

function bind(ctx: Context, storeId: string, body: Data) {
  requireHuman(ctx, 'worker_catalog_bind');
  onlyFields(body, ['device_id', 'external_store_id', 'portal_url']);
  const store = ctx.get('store', storeId);
  requirePlatformPhase(ctx, store.provider);
  if (store.status === 'disabled') reject('WORKER_CATALOG_STORE_DISABLED', 409);
  const externalId = externalStoreId(body.external_store_id);
  const backfill = (store.external_store_id == null || store.external_store_id === '') && store.status === 'import_only' &&
    (store.connection_id == null || store.connection_id === '');
  if (!backfill && store.external_store_id !== externalId) reject('WORKER_CATALOG_STORE_MISMATCH', 409);
  if (backfill && ctx.list('store').some(other => other.id !== store.id && other.provider === store.provider && other.external_store_id === externalId)) {
    reject('duplicate_store', 409);
  }
  const device = ctx.get('connector_device', exactText(body.device_id, 160));
  if (device.status !== 'active') reject('WORKER_CATALOG_DEVICE_INACTIVE', 409);
  const portal = portalUrl(body.portal_url, String(store.provider), externalId);
  const current = bindingFor(ctx, store.id);
  if (backfill) ctx.update('store', store.id, { external_store_id: externalId });
  if (current?.device_id === device.id && current.external_store_id === externalId && current.provider === store.provider && current.portal_url === portal) {
    return bindingView(current, device);
  }
  const patch = { store_id: store.id, device_id: device.id, external_store_id: externalId, provider: store.provider, portal_url: portal, bound_by: ctx.actorId };
  const binding = current ? ctx.update(bindingKind, current.id, patch) : ctx.create(bindingKind, patch);
  if (current) for (const job of ctx.list(jobKind)) {
    if (job.store_id === store.id && pending(job)) ctx.update(jobKind, job.id, { status: 'cancelled', error_code: 'WORKER_CATALOG_BINDING_CHANGED' });
  }
  ctx.emit('commerce.worker_catalog.bound', { store_id: store.id, device_id: device.id });
  return bindingView(binding, device);
}

function enqueue(ctx: Context, storeId: string, body: Data) {
  onlyFields(body, []);
  const store = ctx.get('store', storeId);
  requirePlatformPhase(ctx, store.provider);
  const binding = bindingFor(ctx, store.id);
  if (!binding) reject('WORKER_CATALOG_BINDING_REQUIRED', 409);
  const device = ctx.get('connector_device', String(binding.device_id));
  if (!bindingValid(binding, store, device)) reject('WORKER_CATALOG_BINDING_CHANGED', 409);
  for (const job of ctx.list(jobKind)) {
    if (job.store_id !== store.id || !pending(job)) continue;
    if (!jobBound(job, binding, store, device)) {
      ctx.update(jobKind, job.id, { status: 'cancelled', error_code: 'WORKER_CATALOG_BINDING_CHANGED' });
    } else if (String(job.expires_at) <= ctx.now) {
      ctx.update(jobKind, job.id, { status: 'expired', error_code: 'WORKER_CATALOG_EXPIRED' });
    } else return jobView(job);
  }
  const job = ctx.create(jobKind, {
    store_id: store.id, store_name: store.name, provider: store.provider, external_store_id: store.external_store_id,
    device_id: binding.device_id, binding_id: binding.id, binding_version: binding.version, portal_url: binding.portal_url,
    status: 'queued', expires_at: deadline(ctx, queueMs), requested_by: ctx.actorId,
  });
  ctx.emit('commerce.worker_catalog.queued', { job_id: job.id, store_id: store.id, device_id: device.id });
  return jobView(job);
}

const objectContract = (properties: Data, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
export const workerCatalogOperations: Operation[] = [
  { path: '/worker-catalog', method: 'GET', name: 'worker_catalog_list', roles: READ, summary: 'List fixed Worker bindings and catalog import jobs', run: catalog },
  { path: '/stores/:id/worker', method: 'PUT', name: 'worker_catalog_bind', roles: ADMIN,
    summary: 'Bind a store to an explicitly selected, paired Worker',
    contract: { body: objectContract({ device_id: { type: 'string' }, external_store_id: { type: 'string' }, portal_url: { type: 'string' } }, ['device_id', 'external_store_id']), bodyRequired: true },
    run: (ctx, { params, body }) => bind(ctx, params.id, body) },
  { path: '/stores/:id/worker/imports', method: 'POST', name: 'worker_catalog_request_import',
    roles: ['owner', 'admin', 'manager', 'editor', 'agent'], accepted: true,
    summary: 'Queue a product export import on the store’s fixed Worker',
    contract: { body: objectContract({}) }, run: (ctx, { params, body }) => enqueue(ctx, params.id, body) },
];

export function claimWorkerCatalog(ctx: Context, device: Row, body: Data) {
  onlyFields(body, []);
  const stores = new Map(ctx.list('store').map(row => [row.id, row]));
  const bindings = new Map(ctx.list(bindingKind).map(row => [row.id, row]));
  const jobs = ctx.list(jobKind).filter(job => job.device_id === device.id && pending(job)).sort(oldest);
  // A poll is signed proof of presence. Keep the claimed job fixed until it finishes or expires.
  ctx.update('connector_device', device.id, { last_seen_at: ctx.now });
  const eligible = jobs.filter(job => {
    const bound = jobBound(job, bindings.get(String(job.binding_id)), stores.get(String(job.store_id)), device);
    if (bound && String(job.expires_at) > ctx.now) return true;
    ctx.update(jobKind, job.id, { status: bound ? 'expired' : 'cancelled', error_code: bound ? 'WORKER_CATALOG_EXPIRED' : 'WORKER_CATALOG_BINDING_CHANGED' });
    return false;
  });
  const claimed = eligible.find(job => job.status === 'claimed');
  const next = claimed ?? eligible[0];
  if (!next) return { job: null };
  const leaseDeadline = deadline(ctx, leaseMs);
  const job = claimed ?? ctx.update(jobKind, next.id, {
    status: 'claimed', claim_id: randomUUID(), expires_at: String(next.expires_at) < leaseDeadline ? next.expires_at : leaseDeadline,
  });
  return { job: {
    id: job.id, store_id: job.store_id, device_id: device.id, store_name: job.store_name,
    provider: job.provider, external_store_id: job.external_store_id, portal_url: job.portal_url, claim_id: job.claim_id, expires_at: job.expires_at,
  } };
}

function importFile(body: Data) {
  if ((body.csv === undefined) === (body.xlsx_base64 === undefined)) reject('WORKER_CATALOG_FILE_REQUIRED');
  if (body.csv !== undefined) {
    if (typeof body.csv !== 'string' || !body.csv.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(body.csv)) reject('INVALID_WORKER_CATALOG_FILE');
    if (Buffer.byteLength(body.csv) > fileLimit) reject('WORKER_CATALOG_FILE_TOO_LARGE', 413);
    return { csv: body.csv };
  }
  const value = body.xlsx_base64;
  if (typeof value !== 'string' || !value.length) reject('INVALID_WORKER_CATALOG_FILE');
  if (value.length > Math.ceil(fileLimit / 3) * 4) reject('WORKER_CATALOG_FILE_TOO_LARGE', 413);
  return { xlsx_base64: value };
}

export async function uploadWorkerCatalog(ctx: Context, device: Row, body: Data, isOnline: boolean) {
  onlyFields(body, ['job_id', 'claim_id', 'observed_store_id', 'confirmed', 'csv', 'xlsx_base64']);
  const jobId = exactText(body.job_id, 160);
  const claimId = exactText(body.claim_id, 160);
  const observedId = externalStoreId(body.observed_store_id);
  if (body.confirmed !== true) reject('WORKER_CATALOG_CONFIRMATION_REQUIRED');
  const job = ctx.list(jobKind).find(row => row.id === jobId && row.device_id === device.id);
  if (!job || job.claim_id !== claimId) reject('WORKER_CATALOG_CLAIM_INVALID', 403);
  if (!isOnline) reject('WORKER_CATALOG_DEVICE_OFFLINE', 409);
  const store = ctx.list('store').find(row => row.id === job.store_id);
  const binding = ctx.list(bindingKind).find(row => row.id === job.binding_id);
  if (!jobBound(job, binding, store, device)) reject('WORKER_CATALOG_BINDING_CHANGED', 409);
  if (String(job.expires_at) <= ctx.now) reject('WORKER_CATALOG_EXPIRED', 410);
  if (observedId !== job.external_store_id) reject('WORKER_CATALOG_STORE_MISMATCH', 409);
  const file = importFile(body);
  const fingerprint = createHash('sha256').update(JSON.stringify(file)).digest('hex');
  if (job.status === 'previewed') {
    if (job.upload_fingerprint !== fingerprint) reject('WORKER_CATALOG_ALREADY_UPLOADED', 409);
    return { import_id: job.import_id, status: 'previewed' };
  }
  if (job.status !== 'claimed') reject('WORKER_CATALOG_CLAIM_INVALID', 403);
  let wrote = false;
  const importer: Context = { ...ctx, actorId: String(job.requested_by), create(kind, values) {
    wrote = true;
    return ctx.create(kind, values);
  } };
  let batch: Row;
  try {
    batch = await createImportBatch(importer, { template_key: 'product_list', store_id: job.store_id, ...file }, undefined, { workerCatalog: true });
  } catch (error) {
    // Parse/validate failures can commit the nonce. Roll back the whole transaction if staging has begun.
    if (!wrote && error instanceof Problem && error.status < 500) reject(error.code, error.status);
    throw error;
  }
  ctx.update(jobKind, job.id, { status: 'previewed', import_id: batch.id, upload_fingerprint: fingerprint });
  ctx.emit('commerce.worker_catalog.previewed', { job_id: job.id, store_id: job.store_id, import_id: batch.id, device_id: device.id });
  return { import_id: batch.id, status: 'previewed' };
}
