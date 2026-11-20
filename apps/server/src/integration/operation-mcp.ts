import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { idempotencyPattern, jsonSchema, openObject, Problem, workspaceDto, type Input } from '@smartsell/contracts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { bodyObject, invalid } from '../identity.js';
import { expectedVersion, idempotencyKey, parameterNames, stringMap, type Registered } from '../operations.js';

export function describeOperationTool(op: Registered): Tool {
  const params = parameterNames(op);
  const dto = workspaceDto(op);
  const required = ['workspace_id'];
  if (params.length) required.push('params');
  if (op.versionKind || dto?.version === 'required') required.push('expected_version');
  if (dto?.bodyRequired || op.contract?.bodyRequired) required.push('body');
  if (op.external && op.method !== 'GET') required.push('idempotency_key');
  return {
    name: op.name,
    description: op.summary,
    inputSchema: {
      type: 'object', required, additionalProperties: false,
      properties: {
        workspace_id: { type: 'string', format: 'uuid' },
        params: { type: 'object', properties: Object.fromEntries(params.map(name => [name, { type: 'string' }])), required: params, additionalProperties: false },
        query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        body: dto?.input ? jsonSchema(dto.input, 'input') : op.contract?.body ?? openObject,
        expected_version: { type: 'integer', minimum: 1 },
        idempotency_key: { type: 'string', pattern: idempotencyPattern },
      },
    },
    outputSchema: { type: 'object', properties: { data: dto ? jsonSchema(dto.output, 'output') : op.contract?.output ?? {}, next_cursor: { type: ['string', 'null'] }, etag: { type: 'string' } }, required: ['data'] },
    annotations: { readOnlyHint: op.method === 'GET', destructiveHint: op.method !== 'GET', idempotentHint: op.method === 'GET', openWorldHint: Boolean(op.external) },
  };
}

export function parseOperationTool(operation: Registered, payload: unknown) {
  const args = bodyObject(payload);
  const fields = ['workspace_id', 'params', 'query', 'body', 'expected_version', 'idempotency_key'];
  const extra = Object.keys(args).filter(key => !fields.includes(key));
  if (extra.length) throw invalid(`Unknown argument ${extra.join(', ')}; put payload fields in body and filters in query`);
  if (typeof args.workspace_id !== 'string') throw invalid('workspace_id is required');
  const params = stringMap(args.params);
  const names = parameterNames(operation);
  const absent = names.filter(name => !params[name]);
  const unknown = Object.keys(params).filter(name => !names.includes(name));
  if (absent.length || unknown.length) {
    throw invalid(`Invalid path parameters for ${operation.method} ${operation.path}${absent.length ? `; missing params.${absent.join(', params.')}` : ''}${unknown.length ? `; unknown ${unknown.join(', ')}` : ''}`);
  }
  const input: Input = { params, query: stringMap(args.query, true), body: bodyObject(args.body),
    expectedVersion: expectedVersion(args.expected_version), idempotencyKey: idempotencyKey(args.idempotency_key) };
  return { workspaceId: args.workspace_id, input };
}

const resources = [
  { name: 'Approved brand knowledge', uriTemplate: 'smartsell://workspaces/{workspace_id}/brands/{id}/knowledge', tool: 'knowledge_get_context', param: 'brandId' },
  { name: 'Approved product facts', uriTemplate: 'smartsell://workspaces/{workspace_id}/products/{id}/facts', tool: 'catalog_list_facts', param: 'id' },
];

export function operationResources(granted: (tool: string) => boolean) {
  return resources.filter(resource => granted(resource.tool));
}

export function resourceTemplates(available: typeof resources) {
  return available.map(({ name, uriTemplate }) => ({ name, uriTemplate, mimeType: 'application/json' }));
}

export async function readOperationResource(uri: string, available: typeof resources,
  invoke: (workspace: string, tool: string, input: Input) => Promise<{ body: unknown }>) {
  const match = /^smartsell:\/\/workspaces\/([a-f0-9-]{36})\/(brands|products)\/([a-f0-9-]{36})\/(knowledge|facts)$/.exec(uri);
  const resource = match && available.find(item => item.uriTemplate.endsWith(`/${match[2]}/{id}/${match[4]}`));
  if (!match || !resource) return;
  try {
    const { body } = await invoke(match[1]!, resource.tool, { params: { [resource.param]: match[3]! }, query: {}, body: {} });
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(body) }] };
  } catch (error) {
    if (error instanceof Problem && [403, 404].includes(error.status)) return;
    throw error;
  }
}

export async function serveMcpRequest(req: FastifyRequest, reply: FastifyReply,
  handle: (request: Request) => Promise<Response>, active: Set<AbortController>, body = req.body) {
  const stop = new AbortController();
  active.add(stop);
  const close = () => { stop.abort(); active.delete(stop); };
  reply.raw.once('close', close);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string' && name !== 'content-length') headers.set(name, value);
  }
  const response = await handle(new Request('http://localhost/mcp', { method: req.method, headers, signal: stop.signal,
    body: req.method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined }));
  for (const [name, value] of response.headers) reply.header(name, value);
  reply.code(response.status);
  return reply.send(response.headers.get('content-type') === 'text/event-stream' && response.body
    ? Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>) : await response.text());
}
