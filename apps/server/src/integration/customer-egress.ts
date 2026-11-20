import { Resolver } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Problem, type Context, type Data } from '@smartsell/contracts';
import { publicAddress } from '../modules/traffic/probe.js';
import { requestModel, availableModelPurposes, type AgentModelServices } from '../modules/agent/operations.js';
import { assertEmergencyNotStopped, type OpsServices } from '../modules/ops/index.js';

interface Destination {
  tenantId: string;
  workspaceId: string;
  kind: 'embedding' | 'webhook';
  secretId: string;
  url: string;
  secretEnv: string;
}

function endpoint(value: string, allowLoopback = false) {
  const url = new URL(value);
  const loopback = allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (!loopback && (url.protocol !== 'https:' ||
    !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(url.hostname) || (url.port && url.port !== '443')))) {
    throw new Error('Customer egress requires a public HTTPS endpoint');
  }
  return url;
}

async function post(url: URL, headers: Record<string, string>, body: string) {
  const loopback = url.protocol === 'http:';
  const addresses = loopback ? [] : await new Resolver({ timeout: 1000, tries: 1 }).resolve4(`${url.hostname}.`);
  if (!loopback && (!addresses.length || addresses.some(address => !publicAddress(address)))) throw new Error('Customer endpoint is unavailable');
  const send = loopback ? httpRequest : httpsRequest;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = send(url, { method: 'POST', headers, agent: false, signal: AbortSignal.timeout(5000),
      ...(loopback ? {} : { family: 4, lookup: (_host, _options, callback) => callback(null, addresses[0], 4) }) }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512 * 1024) res.destroy(new Error('Customer endpoint response exceeds limit'));
        else chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

export function customerEgress(env: NodeJS.ProcessEnv = process.env) {
  const allowLoopback = env.NODE_ENV !== 'production' && env.SMARTSELL_WEBHOOK_LOOPBACK === '1';
  const raw: unknown = env.SMARTSELL_CUSTOMER_EGRESS ? JSON.parse(env.SMARTSELL_CUSTOMER_EGRESS) : [];
  if (!Array.isArray(raw)) throw new Error('Invalid SMARTSELL_CUSTOMER_EGRESS');
  const destinations = new Map<string, Destination>();
  for (const value of raw as Destination[]) {
    if (!value || ![value.tenantId, value.workspaceId, value.secretId].every(item => typeof item === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item)) ||
      !['embedding', 'webhook'].includes(value.kind) || typeof value.url !== 'string' ||
      typeof value.secretEnv !== 'string' || !/^SMARTSELL_EGRESS_SECRET_[A-Z0-9_]+$/.test(value.secretEnv) || !env[value.secretEnv]) {
      throw new Error('Invalid customer egress destination');
    }
    const url = endpoint(value.url, allowLoopback && value.kind === 'webhook').href;
    const key = `${value.tenantId}/${value.workspaceId}/${value.kind}/${value.secretId}`;
    if (destinations.has(key)) throw new Error('Duplicate customer egress destination');
    destinations.set(key, { ...value, url });
  }
  const find = (ctx: Context, kind: Destination['kind'], secretId: string) => destinations.get(`${ctx.tenantId}/${ctx.workspaceId}/${kind}/${secretId}`);
  const model: AgentModelServices = {
    ownsSecret: (ctx, id) => !!find(ctx, 'embedding', id),
    // UTF-8 byte length is a conservative reservation, actual provider usage is persisted by requestModel.
    countInputTokens: (_ctx, _dest, input) => input.fields.reduce((total, field) => total + Buffer.byteLength(field.text), 0),
    async invoke(ctx, destination, input) {
      const approved = find(ctx, 'embedding', destination.secretId);
      const base = endpoint(destination.endpoint);
      base.pathname = `${base.pathname.replace(/\/$/, '')}/embeddings`;
      if (!approved || base.href !== approved.url || destination.protocol !== 'openai_chat' || input.purpose !== 'embed') {
        throw new Problem(403, 'EGRESS_DENIED', 'This model destination is not configured for embeddings');
      }
      assertEmergencyNotStopped(ctx);
      const result = await post(base, { 'content-type': 'application/json', authorization: `Bearer ${env[approved.secretEnv]}` },
        JSON.stringify({ model: input.model, input: input.fields.map(field => field.text).join('\n') }));
      if (result.status < 200 || result.status >= 300) throw new Error('Embedding request failed');
      const data = JSON.parse(result.body) as { data?: { embedding?: number[] }[]; usage?: { prompt_tokens?: number } };
      if (!Array.isArray(data.data?.[0]?.embedding) || !Number.isSafeInteger(data.usage?.prompt_tokens)) throw new Error('Invalid embedding response');
      return { output: data.data[0].embedding, inputTokens: data.usage!.prompt_tokens!, outputTokens: 0 };
    },
  };
  const ops: OpsServices = {
    allowLoopbackWebhook(ctx, url, id) {
      return allowLoopback && find(ctx, 'webhook', id)?.url === url;
    },
    webhookSigningKey(ctx, id) {
      const configured = find(ctx, 'webhook', id);
      return configured ? env[configured.secretEnv]! : '';
    },
    async sendWebhook(ctx, input) {
      assertEmergencyNotStopped(ctx);
      const url = endpoint(input.url, allowLoopback);
      if (url.protocol === 'http:' && ![...destinations.values()].some(destination => destination.kind === 'webhook' &&
        destination.tenantId === ctx.tenantId && destination.workspaceId === ctx.workspaceId && destination.url === url.href)) {
        throw new Problem(403, 'EGRESS_DENIED', 'This webhook destination is not configured');
      }
      return post(url, input.headers, input.body);
    },
  };
  return {
    model,
    ops,
    hasModel(ctx: Context) { return [...destinations.values()].some(row => row.kind === 'embedding' && row.tenantId === ctx.tenantId && row.workspaceId === ctx.workspaceId); },
    webhookAllowed(ctx: Context, row: Data) { return find(ctx, 'webhook', String(row.secret_id))?.url === row.url; },
  };
}
export type CustomerEgress = ReturnType<typeof customerEgress>;

export async function semanticSearch(ctx: Context, query: Record<string, string>) {
  const { search, searchCandidates } = await import('../modules/workspace/search.js');
  const lexical = search(ctx, { params: {}, query, body: {} });
  if (!availableModelPurposes(ctx).includes('embed')) return { ...lexical, mode: 'keyword' };
  const route = ctx.list('model_route').find(row => row.purpose === 'embed' && row.enabled === true);
  if (!route) return { ...lexical, mode: 'keyword' };
  const { evaluateEgress } = await import('../modules/ops/controls.js');
  const provider = ctx.list('model_provider').find(row => row.id === route.provider_id && row.status === 'active');
  if (!provider || !(provider.allowed_data_classes as string[])?.includes('internal') ||
    evaluateEgress(ctx, { kind: 'model_provider', id: provider.id }, ['internal']) !== 'allow') return { ...lexical, mode: 'keyword' };
  const candidates = searchCandidates(ctx, query).filter(item => !['customer', 'conversation', 'creator'].includes(item.resource_type))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);
  if (!candidates.length) return { ...lexical, mode: 'keyword' };
  const embedding = async (text: string) => (await requestModel(ctx, 'embed', [{ dataClass: 'internal', text }])).output as number[];
  const needle = await embedding(query.q);
  const ranked: { item: typeof candidates[number]; score: number }[] = [];
  for (const item of candidates) {
    const vector = await embedding(`${item.title} ${item.excerpt ?? ''}`.trim().slice(0, 600));
    if (vector.length !== needle.length) throw new Problem(502, 'AI_PROVIDER_ERROR', 'Embedding dimensions differ');
    const norm = Math.hypot(...vector) * Math.hypot(...needle);
    if (norm > 0) ranked.push({ item, score: vector.reduce((sum, value, index) => sum + value * needle[index], 0) / norm });
  }
  ranked.sort((a, b) => b.score - a.score);
  const items = [...ranked.map(row => row.item), ...lexical.items.filter(item => !ranked.some(row => row.item.resource_id === item.resource_id))];
  return { mode: 'semantic', items: items.slice(0, Math.min(Number(query.limit ?? 50) || 50, 100)), total: items.length };
}
