import { idempotencyPattern, jsonSchema, openObject, pageSize, versionHeaderPattern, workspaceApiPrefix, workspaceDto, workspaceOpenApiFile, type JsonSchema } from '@smartsell/contracts';
import type { Config } from './config.js';
import { parameterNames, type Registered } from './operations.js';
import type { sharedBusinessCommand } from './integration/shared-business.js';

type Alias = NonNullable<ReturnType<typeof sharedBusinessCommand>>;
const string = { type: 'string' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: JsonSchema) => ({ 'application/json': { schema } });
const parameter = (name: string, location: 'query' | 'path' | 'header', schema: JsonSchema, required = false, description?: string) => ({
  name, in: location, ...(location === 'path' || required ? { required: true } : {}), schema, ...(description && { description }),
});
const root = `${workspaceApiPrefix}/{ws}`;
const ws = parameter('ws', 'path', { type: 'string', format: 'uuid' }, true, 'Use the workspace for which this document was fetched.');
const pageLimit = { type: 'integer', minimum: 1, maximum: pageSize.maximum, default: pageSize.default };
const pagination = [
  parameter('cursor', 'query', string, false, 'Opaque continuation from next_cursor for the same workspace, user, credential, operation and filters. Used for array results only.'),
  parameter('limit', 'query', pageLimit, false, 'Used for array results only.'),
];
const cursor = { type: ['string', 'null'] };
const envelope = (data: JsonSchema, list = false) => ({
  type: 'object', required: ['data', ...(data.type === 'array' && list ? ['next_cursor'] : [])],
  properties: { data, ...(list && { next_cursor: cursor }) },
});
const pathTemplate = (path: string) => path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
export const workspaceOpenApiRoute = `${workspaceApiPrefix}/:ws/${workspaceOpenApiFile}`;

type Options = {
  config: Pick<Config, 'secureCookie'>;
  surface: 'commands' | 'operations';
  operations: readonly Registered[];
  aliases?: readonly { op: Registered; command: Alias }[];
  permitsBearer?: (operation: Registered) => boolean;
};

export function workspaceOpenApi({ config, surface, operations, aliases = [], permitsBearer }: Options) {
  type Security = Record<string, string[]>;
  const paths: Record<string, Record<string, unknown>> = {};
  function mount(path: string, method: string, operation: Record<string, unknown>) {
    (paths[`${root}${path}`] ??= {})[method.toLowerCase()] = operation;
  }
  const security = (write: boolean, bearer: boolean): Security[] => {
    const session: Security = write ? { sessionCookie: [], csrfToken: [] } : { sessionCookie: [] };
    return bearer ? [session, { accessToken: [] }] : [session];
  };
  const errorResponse = (description: string) => ({ description, content: {
    'application/problem+json': { schema: ref('Problem') },
    ...(surface === 'commands' && json(ref('CommandError'))),
  } });
  const errors = (versionRequired = false, write = false) => ({
    '401': errorResponse('Authentication required.'), '403': errorResponse('Access denied or CSRF validation failed.'),
    '404': errorResponse('Workspace or resource is missing or invisible.'),
    ...(write && { '409': errorResponse('The resource state or version conflicts with the request.') }),
    '422': errorResponse(write ? 'Invalid input or IDEMPOTENCY_MISMATCH when a key is reused for a different write.' : 'Invalid input.'),
    ...(versionRequired && { '428': errorResponse('If-Match is required.') }),
    default: errorResponse('Request rejected.'),
  });
  for (const op of [...operations].sort((a, b) => a.name.localeCompare(b.name))) {
    const dto = workspaceDto(op);
    const read = op.method === 'GET';
    const data = dto ? jsonSchema(dto.output, 'output') : op.contract?.output ?? {
      description: 'No strong projection is registered. The result is owned by the operation.',
    };
    const reportFile = op.name === 'report_export_download';
    const list = !reportFile && read && (data.type === 'array' || data.type === undefined);
    const pageParameters = list ? pagination : [];
    const query = (dto?.query ?? op.contract?.query ?? []).filter(name => !pageParameters.some(parameter => parameter.name === name));
    const body = dto?.input ? jsonSchema(dto.input, 'input') : op.contract?.body ?? openObject;
    const versionRequired = Boolean(op.versionKind) || dto?.version === 'required';
    const ifMatch = parameter('If-Match', 'header', { type: 'string', pattern: versionHeaderPattern }, versionRequired,
      'Positive resource version, either quoted or unquoted.');
    const key = (required: boolean) => parameter('Idempotency-Key', 'header', { type: 'string', pattern: idempotencyPattern }, required,
      'Reuse the same key for retries of the same write. Successful outcomes are stored for 24 hours.');
    const response = {
      description: 'Operation completed.',
      headers: { ETag: { description: 'Present when the result exposes a numeric version.', schema: string } },
      content: reportFile ? Object.fromEntries(['application/pdf', 'text/csv',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].map(mime => [mime, { schema: { type: 'string', format: 'binary' } }]))
        : json(envelope(data, list)),
    };
    mount(op.path === '/' ? '' : pathTemplate(op.path), op.method, {
      operationId: op.name, summary: op.summary, tags: [op.module], security: security(!read, permitsBearer?.(op) ?? false),
      'x-smartsell-query': dto?.query || op.contract?.query ? 'Known query parameters are listed. The transport accepts other scalar string parameters.' : 'Open string map. Operation-specific filters are not declared.',
      parameters: [ws, ...parameterNames(op).map(name => parameter(name, 'path', string)),
        ...query.map(name => parameter(name, 'query', string)), ...pageParameters,
        ...(!read ? [ifMatch, key(Boolean(op.external || op.idempotencyRequired))] : []),
      ],
      ...(!read && { requestBody: { required: dto?.bodyRequired ?? op.contract?.bodyRequired ?? false, content: json(body) } }),
      responses: {
        ...(op.accepted !== true && { 200: response }),
        ...(op.accepted && { 202: { ...response, description: 'Work accepted.' } }),
        ...errors(versionRequired, !read),
      },
    });
  }
  for (const { op, command } of aliases) {
    const hasId = parameterNames(op).includes('id');
    const read = op.method === 'GET';
    const canonical = paths[`${root}${op.path === '/' ? '' : pathTemplate(op.path)}`][op.method.toLowerCase()] as {
      responses: Record<string, { content: ReturnType<typeof json> }>;
    };
    const successStatus = op.accepted ? '202' : '200';
    const success = canonical.responses[successStatus];
    const responses = { ...canonical.responses, ...errors(command.requires_version, !read),
      ...(op.listForRest && { [successStatus]: { ...success, content: json(envelope(success.content['application/json'].schema)) } }),
    };
    const dto = workspaceDto(op);
    const typedInput = dto?.input && jsonSchema(dto.input, 'input');
    const properties = typedInput?.properties as Record<string, JsonSchema> | undefined;
    const required = (typedInput?.required as string[] | undefined)?.filter(name => command.fields.includes(name)) ?? [];
    mount(`/commands/${command.module}/${command.action}`, 'POST', {
      operationId: command.action, summary: `Compatibility command for ${op.name}`, tags: [op.module], security: security(!read, false),
      'x-smartsell-alias-of': op.name,
      parameters: [ws, ...(!read ? [parameter('Idempotency-Key', 'header', { type: 'string', pattern: idempotencyPattern }, true),
        parameter('If-Match', 'header', { type: 'string', pattern: versionHeaderPattern }, command.requires_version)] : [])],
      requestBody: { required: hasId || op.method === 'PATCH' || required.length > 0, content: json({ type: 'object', additionalProperties: false,
        required: [...(hasId ? ['id'] : []), ...(op.method === 'PATCH' || required.length ? ['fields'] : [])], properties: {
          ...(hasId && { id: { type: 'string', pattern: '^[a-zA-Z0-9-]{1,200}$' } }),
          fields: { type: 'object', additionalProperties: false, required, ...(op.method === 'PATCH' && { minProperties: 1 }),
            properties: Object.fromEntries(command.fields.map(name => [name, read ? { type: ['string', 'number', 'boolean'] } : properties?.[name] ?? {}])) },
        } }) },
      responses,
    });
  }
  {
    mount('/catalog', 'GET', {
      operationId: 'workspace_operation_catalog', summary: 'List callable workspace operations', parameters: [ws],
      security: security(false, Boolean(permitsBearer)), responses: { '200': { description: 'Workspace operation metadata.',
        content: json({ type: 'object', required: ['data'], properties: { data: { type: 'array', items: openObject } } }) }, ...errors() },
    });
  }
  mount(`/${workspaceOpenApiFile}`, 'GET', {
    operationId: 'workspace_openapi_document', summary: 'Get this workspace OpenAPI 3.1 document', parameters: [ws],
    security: security(false, Boolean(permitsBearer)), responses: { '200': { description: 'OpenAPI 3.1 document.', content: json(openObject) }, ...errors() },
  });
  return {
    openapi: '3.1.0',
    info: { title: 'SmartSell Workspace API', version: '1.0.0',
      description: 'Operations visible to the current workspace principal. Resource permissions, approval, prechecks and deployment policy are enforced on each call.' },
    servers: [{ url: '/' }], paths,
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: config.secureCookie ? '__Host-smartsell_session' : 'smartsell_session' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Required with the session cookie for mutations. Obtain it from GET /api/v1/session/csrf.' },
        ...(permitsBearer && { accessToken: { type: 'http', scheme: 'bearer', description: 'Workspace-bound SmartSell PAT or OAuth access token. Write access and any operation allowlist apply.' } }),
      },
      schemas: {
        Problem: { type: 'object', required: ['type', 'title', 'status', 'code', 'detail', 'request_id'], properties: {
          type: string, title: string, status: { type: 'integer' }, code: string, detail: string, request_id: string, details: openObject,
        } },
        ...(surface === 'commands' && { CommandError: { type: 'object', required: ['error'], properties: {
          error: { type: 'object', required: ['code', 'message'], properties: { code: string, message: string } },
        } } }),
      },
    },
  };
}
