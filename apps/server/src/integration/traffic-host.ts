import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Problem } from '@smartsell/contracts';
import type { Store as KernelStore } from '@smartsell/db';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createPublicTrafficHandler } from '../../../public/src/traffic.js';
import { makeContext } from '../context.js';
import type { Workspace } from '../identity.js';
import { resolveShortLink, submitLandingPage, trafficPublicBridge, viewLandingPage,
  type PublicTrafficRequest, type PublicTrafficResponse } from '../modules/traffic/index.js';
import type { Context as CommandContext } from '../modules/types.js';
import type { Store as CommandStore } from '../store.js';
import { operationRecords } from './operation-records.js';
import { analyticsChoice, trafficConsent } from './traffic-consent.js';

export type TrafficHostConfig = {
  domains: ReadonlyMap<string, { origin: string; workspaceId: string }>;
  piiKey: Uint8Array;
  trackingKey?: Uint8Array;
};

export function trafficHostConfig(env: NodeJS.ProcessEnv, excludedOrigins: string[]): TrafficHostConfig | undefined {
  if (!env.SMARTSELL_TRAFFIC_HOSTS) return undefined;
  const invalid = () => new Error('SMARTSELL_TRAFFIC_HOSTS must map isolated HTTP(S) origins to workspace UUIDs');
  let value: unknown;
  try { value = JSON.parse(env.SMARTSELL_TRAFFIC_HOSTS); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const domains = new Map<string, { origin: string; workspaceId: string }>();
  const excludedHosts = new Set(excludedOrigins.map(origin => new URL(origin).hostname));
  const hostnames = new Set<string>();
  for (const [origin, workspaceId] of Object.entries(value)) {
    let url: URL;
    try { url = new URL(origin); } catch { throw invalid(); }
    if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol) || url.hostname.endsWith('.') ||
      (env.NODE_ENV === 'production' && url.protocol !== 'https:') || excludedHosts.has(url.hostname) || hostnames.has(url.hostname) ||
      typeof workspaceId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(workspaceId)) throw invalid();
    hostnames.add(url.hostname);
    domains.set(url.host, { origin, workspaceId });
  }
  if (!domains.size) return undefined;
  const explicit = env.SMARTSELL_TRAFFIC_PII_KEY;
  const key = explicit ?? env.APP_SECRET;
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new Error('Public traffic requires a stable 32-byte hex SMARTSELL_TRAFFIC_PII_KEY or APP_SECRET');
  const piiKey = explicit ? Buffer.from(key, 'hex') : createHmac('sha256', Buffer.from(key, 'hex')).update('smartsell/traffic/pii/v1').digest();
  const trackingKey = createHmac('sha256', Buffer.from(key, 'hex')).update('smartsell/traffic/tracking/v1').digest();
  return { domains, piiKey, trackingKey };
}

type Dispatch = (workspaceId: string, input: PublicTrafficRequest) => Promise<PublicTrafficResponse>;
const notFound = () => new Problem(404, 'NOT_FOUND', 'Resource not found');
const serviceActor = '00000000-0000-0000-0000-000000000001';

export function kernelTraffic(config: TrafficHostConfig, store: KernelStore, enabled: boolean) {
  return trafficHost(config, (workspaceId, input) => store.transaction({ readOnly: input.type === 'page' || input.type === 'bio' }, async tx => {
    const ws = tx.identity.get<Workspace>(`workspace/${workspaceId}`);
    if (!ws || tx.identity.get<{ status: string }>(`tenant/${ws.tenantId}`)?.status !== 'active') throw notFound();
    const scope = { workspaceId: ws.id, tenantId: ws.tenantId, actorId: serviceActor };
    const context = makeContext(await tx.workspace(scope), scope, 'viewer');
    return trafficPublicBridge(context, input, config);
  }), enabled);
}

const opaque = /^[a-zA-Z0-9_-]{32}$/;

async function legacyPage(ctx: CommandContext, slug: string): Promise<Extract<PublicTrafficResponse, { type: 'page' }>> {
  const page = await viewLandingPage(ctx, slug);
  const choices = [
    ...(page.service_contact ? [{ key: `${page.service_contact.channel}:service`, label: page.service_contact.text }] : []),
    ...page.channel_options.map(option => ({ key: `${option.channel}:marketing`, label: option.text })),
  ];
  return {
    type: 'page', slug, versionId: page.version_id, locale: 'zh-Hant', title: page.title,
    blocks: [
      { type: 'text', title: '', text: page.description },
      { type: 'form', title: '', formId: slug, formVersionId: page.version_id, choices, fields: [
        { key: 'name', label: '姓名', required: false }, { key: 'email', label: '電子郵件', required: false },
        { key: 'phone', label: '電話', required: false }, { key: 'message', label: '留言', required: false },
      ] },
    ],
  };
}

export function commandTraffic(config: TrafficHostConfig, store: CommandStore, enabled: boolean) {
  if (enabled && !store.publicWork) throw new Error('The command store does not support public traffic');
  return trafficHost(config, async (workspaceId, input) => {
    const result = await store.publicWork!('traffic.workspace', workspaceId, async unit => {
      const { context } = unit;
      if (context.workspaceId !== workspaceId) throw notFound();
      const readOnly = input.type === 'page' || input.type === 'bio';
      const run = async (): Promise<PublicTrafficResponse> => {
        const { records, flush } = await operationRecords(context, readOnly);
        const scope = { workspaceId, tenantId: context.tenantId, actorId: context.actorId };
        const operation = makeContext(records, scope, 'viewer');
        if ((input.type === 'page' || input.type === 'submit') && opaque.test(input.slug) &&
          !operation.list('landing_page').some(row => row.slug === input.slug.toLowerCase()) &&
          await context.get('traffic', 'landing_page', input.slug)) {
          if (input.type === 'page') return legacyPage(context, input.slug);
          if (input.formId !== input.slug) throw notFound();
          const body = input.body as { fields: Record<string, string>; consents: string[]; form_version_id: string };
          const page = await viewLandingPage(context, input.slug);
          if (body.form_version_id !== page.version_id) throw new Problem(409, 'CONFLICT', 'Form version has changed');
          if (new Set(body.consents).size !== body.consents.length || body.consents.some(key =>
            key !== `${page.service_contact?.channel}:service` && !page.channel_options.some(option => key === `${option.channel}:marketing`))) {
            throw new Problem(422, 'INVALID_CONSENT', 'Invalid consent selection');
          }
          return { type: 'submit', ...await submitLandingPage(context, input.slug, { ...body.fields, version_id: input.versionId,
            service_contact: page.service_contact && body.consents.includes(`${page.service_contact.channel}:service`),
            marketing: Object.fromEntries(page.channel_options.map(option => [option.channel, body.consents.includes(`${option.channel}:marketing`)])),
          }) };
        }
        if (input.type === 'redirect' && opaque.test(input.code) &&
          !operation.list('link_domain').some(domain => domain.hostname === input.hostname &&
            operation.list('short_link').some(link => link.domain_id === domain.id && link.code === input.code.toLowerCase())) &&
          await context.get('traffic', 'short_link', input.code)) {
          return { type: 'redirect', ...await resolveShortLink(context, input.code, input) };
        }
        const output = trafficPublicBridge(operation, input, config);
        await flush();
        return output;
      };
      return readOnly ? run() : await unit.command({ module: 'traffic', action: `public_${input.type}`, key: `public/${randomUUID()}`, fingerprint: '' }, run) as PublicTrafficResponse;
    });
    if (!result) throw notFound();
    return result;
  }, enabled);
}

const cssUrl = new URL('../../../public/assets/traffic.css', import.meta.url);
const maxBody = 64 * 1024;

function trafficHost(config: TrafficHostConfig, dispatch: Dispatch, enabled: boolean) {
  const publicHostnames = new Set([...config.domains.values()].map(domain => new URL(domain.origin).hostname));
  const submissions = new Map<string, { count: number; expires: number }>();
  const limit = (key: string) => {
    const now = Date.now();
    if (submissions.size >= 2048) for (const [id, entry] of submissions) if (entry.expires <= now) submissions.delete(id);
    const current = submissions.get(key);
    if (current && current.expires > now) return ++current.count <= 12;
    if (submissions.size >= 2048) return false;
    submissions.set(key, { count: 1, expires: now + 60_000 });
    return true;
  };
  let css: Promise<Buffer> | undefined;
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // The ingress must preserve Host and reject unmatched authorities. Forwarded values are not used.
    const authority = request.headers.host?.toLowerCase() ?? '';
    const domain = config.domains.get(authority);
    if (!domain) {
      const hostname = /^(\[[\da-f:]+\]|[a-z0-9.-]+)(?::\d+)?$/.exec(authority)?.[1]?.replace(/\.$/, '');
      if (hostname && publicHostnames.has(hostname)) return reply.code(404).send();
      return;
    }
    if (!enabled) return reply.code(404).send();
    const raw = request.raw.url ?? '';
    const [path] = raw.split('?', 1);
    if (path === '/assets/traffic.css' && ['GET', 'HEAD'].includes(request.method)) {
      css ??= readFile(cssUrl);
      return reply.type('text/css; charset=utf-8').send(await css);
    }
    const route = /^(?:\/p\/[a-z0-9_-]+|\/b\/[a-z0-9_-]+|\/f\/[a-z0-9_-]+\/submit|\/(?:[a-z0-9][a-z0-9_-]{0,79}|[_-][a-z0-9_-]{31})|\/(?:r|landing)\/[a-z0-9_-]{32})\/?$/i;
    if (!route.test(path)) return reply.code(404).send();
    const publicPath = path.replace(/^\/r\//i, '/').replace(/^\/landing\//i, '/p/');
    const consent = config.trackingKey && trafficConsent(domain.origin, config.trackingKey);
    const choice = consent ? consent.read(request.headers.cookie) : undefined;
    const consentForm = Boolean(consent && /^\/p\//i.test(path) && request.method === 'POST');
    const form = consentForm || /^\/f\//i.test(publicPath);
    const expected = form ? 'POST' : 'GET';
    if (request.method !== expected) return reply.code(405).header('allow', expected).send();
    if (form) {
      if (request.headers.origin !== domain.origin || request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send();
      if (!limit(`${authority}/${request.ip}`)) return reply.code(429).header('retry-after', '60').send();
    }
    const headers = new Headers();
    for (const name of ['content-type', 'origin', 'user-agent', 'sec-purpose', 'purpose', 'sec-fetch-mode', 'sec-fetch-user']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (form && /^application\/x-www-form-urlencoded(?:;|$)/i.test(headers.get('content-type') ?? '')) {
      if (Number(request.headers['content-length']) > maxBody) return reply.code(413).send();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request.raw.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > maxBody) { request.raw.resume(); return reply.code(413).send(); }
        chunks.push(chunk);
      }
      body = new Uint8Array(Buffer.concat(chunks, size));
    }
    if (consentForm && consent) {
      if (!body) return reply.code(415).send();
      const values = new URLSearchParams(new TextDecoder().decode(body)).getAll('analytics');
      const [value] = values;
      if (values.length !== 1 || (value !== 'allow' && value !== 'deny')) return reply.code(422).send();
      return reply.header('cache-control', 'no-store').header('set-cookie', consent.write(analyticsChoice(value === 'allow', choice)))
        .code(303).header('location', publicPath).send();
    }
    const pageNavigation = headers.get('sec-fetch-mode') === 'navigate' && !headers.has('sec-purpose') && !headers.has('purpose');
    const visitor = choice?.consent ? { consent: true as const, sessionRef: choice.sessionRef,
      shortLinkId: choice.landingPath === publicPath ? choice.shortLinkId : undefined } : undefined;
    const handle = createPublicTrafficHandler(async (_, input) => {
      const result = await dispatch(domain.workspaceId, input.type === 'redirect' && visitor && input.navigation ? { ...input, visitor } : input);
      if (consent && visitor && result.type === 'redirect' && 'shortLinkId' in result) {
        const target = new URL(result.location);
        if (target.origin === domain.origin && /^\/p\/[a-z0-9_-]+\/?$/i.test(target.pathname)) {
          reply.header('set-cookie', consent.write({ ...visitor, shortLinkId: result.shortLinkId, landingPath: target.pathname }));
        }
      }
      if (consent && visitor && result.type === 'page' && pageNavigation) {
        await dispatch(domain.workspaceId, { type: 'touchpoint', slug: result.slug, versionId: result.versionId, eventId: randomUUID(), visitor });
        if (choice?.consent && choice.landingPath) reply.header('set-cookie', consent.write({ consent: true, sessionRef: visitor.sessionRef }));
      }
      return result;
    }, () => visitor, consent ? () => choice?.consent : undefined);
    const response = await handle(new Request(`${domain.origin}${publicPath}${raw.slice(path.length)}`, { method: expected, headers, body }));
    if (!response) return reply.code(404).send();
    for (const [name, value] of response.headers) reply.header(name, value);
    return reply.code(response.status).send(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  };
}
