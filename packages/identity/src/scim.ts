import { scopedConnection, type ConnectionLookup, type ConnectionScope } from './federation.ts';
import { digest, equal, IdentityError } from './state.ts';

export const userSchema = 'urn:ietf:params:scim:schemas:core:2.0:User';
const patchSchema = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const listSchema = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const errorSchema = 'urn:ietf:params:scim:api:messages:2.0:Error';

export type ScimScope = ConnectionScope & { revision: string };
export type ScimInput = { externalId: string; userName: string; active: boolean; displayName?: string };
export type ScimUpdate = Partial<Omit<ScimInput, 'externalId'>>;
export type ScimMember = ScimInput & { id: string };
export type ScimQuery = { startIndex: number; count: number; filter?: { field: 'externalId' | 'userName' | 'id'; value: string } };

// All results and mutations are scoped by tenant AND connection. Writes must check the
// connection revision within the membership transaction. Disabling must revoke credentials there.
export interface ScimMembers {
  create(scope: ScimScope, input: ScimInput): Promise<ScimMember>;
  get(scope: ScimScope, id: string): Promise<ScimMember | null>;
  list(scope: ScimScope, query: ScimQuery): Promise<{ total: number; members: ScimMember[] }>;
  // expectedExternalId prevents PUT from remapping an existing subject. On mismatch return 400.
  update(scope: ScimScope, id: string, update: ScimUpdate, expectedExternalId?: string): Promise<ScimMember | null>;
  // Permanently retire the SCIM resource and leave the external subject binding reserved.
  remove(scope: ScimScope, id: string): Promise<boolean>;
}

class ScimError extends IdentityError {
  constructor(status: number, message: string, readonly scimType?: string) { super(status, message); }
}

const invalid = (message: string, scimType = 'invalidValue') => new ScimError(400, message, scimType);
const missing = () => new ScimError(404, 'Resource not found');

function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Expected an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(`Invalid ${field}`);
  return value;
}

function active(value: unknown) {
  if (typeof value !== 'boolean') throw invalid('Invalid active');
  return value;
}

function schema(value: unknown, expected: string) {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== expected) throw invalid('Unsupported schemas');
}

function input(value: unknown, replacing = false): ScimInput {
  const body = object(value);
  schema(body.schemas, userSchema);
  return {
    externalId: text(body.externalId, 'externalId'), userName: text(body.userName, 'userName'),
    active: body.active === undefined && !replacing ? true : active(body.active),
    ...(body.displayName !== undefined ? { displayName: text(body.displayName, 'displayName') } : {}),
  };
}

function apply(update: ScimUpdate, name: string, value: unknown) {
  switch (name.toLowerCase()) {
    case 'active': update.active = active(value); break;
    case 'username': update.userName = text(value, 'userName'); break;
    case 'displayname': update.displayName = text(value, 'displayName'); break;
    case 'externalid': throw invalid('externalId is immutable', 'mutability');
    default: throw invalid('Unsupported patch path', 'invalidPath');
  }
}

function patch(value: unknown): ScimUpdate {
  const body = object(value);
  schema(body.schemas, patchSchema);
  if (!Array.isArray(body.Operations) || !body.Operations.length || body.Operations.length > 20) throw invalid('Invalid Operations');
  const updates: ScimUpdate = {};
  for (const operation of body.Operations) {
    const op = object(operation);
    if (typeof op.op !== 'string' || !['add', 'replace'].includes(op.op.toLowerCase())) throw invalid('Unsupported patch operation');
    if (op.path === undefined) {
      const entries = Object.entries(object(op.value));
      if (!entries.length) throw invalid('Empty patch');
      for (const [name, field] of entries) apply(updates, name, field);
    } else apply(updates, text(op.path, 'path'), op.value);
  }
  return updates;
}

function query(params: URLSearchParams): ScimQuery {
  const integer = (name: string, fallback: number, minimum: number) => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    if (!/^\d{1,9}$/.test(raw) || params.getAll(name).length !== 1) throw invalid(`Invalid ${name}`);
    return Math.max(minimum, Number(raw));
  };
  const page: ScimQuery = { startIndex: integer('startIndex', 1, 1), count: Math.min(100, integer('count', 100, 0)) };
  const filter = params.get('filter');
  if (filter !== null) {
    try {
      const parsed = /^(userName|externalId|id)\s+eq\s+("(?:[^"\\]|\\.)*")$/i.exec(filter);
      if (!parsed || params.getAll('filter').length !== 1) throw new Error();
      const field = parsed[1].toLowerCase();
      page.filter = { field: field === 'username' ? 'userName' : field === 'externalid' ? 'externalId' : 'id',
        value: text(JSON.parse(parsed[2]), 'filter') };
    } catch { throw invalid('Unsupported filter', 'invalidFilter'); }
  }
  return page;
}

export const scimBase = (scope: ConnectionScope) => `/api/v1/scim/${scope.tenantId}/${scope.connectionId}/v2`;

export function scimError(error: unknown) {
  const status = error instanceof IdentityError ? error.statusCode : 500;
  const detail = error instanceof IdentityError ? error.message : 'Provisioning failed';
  return { status, body: { schemas: [errorSchema], status: String(status), detail,
    ...(error instanceof ScimError && error.scimType ? { scimType: error.scimType } : {}) } };
}

export class ScimIdentity {
  constructor(private readonly lookup: ConnectionLookup, private readonly members: ScimMembers,
    private readonly origin: string) {}

  async authorize(scope: ConnectionScope, authorization: string | undefined): Promise<ScimScope> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? '');
    if (!match) throw new IdentityError();
    const connection = await scopedConnection(this.lookup, scope).catch(error => {
      if (error instanceof IdentityError && error.statusCode === 404) throw new IdentityError();
      throw error;
    });
    if (!connection.scimTokenHash || !equal(digest(match[1]), connection.scimTokenHash)) throw new IdentityError();
    return { ...scope, revision: connection.revision };
  }

  private resource(scope: ScimScope, member: ScimMember) {
    const { id, externalId, userName, active, displayName } = member;
    const location = `${this.origin}${scimBase(scope)}/Users/${encodeURIComponent(id)}`;
    return { schemas: [userSchema], id, externalId, userName, active, displayName, meta: { resourceType: 'User', location } };
  }

  async list(scope: ScimScope, params: URLSearchParams) {
    const page = query(params);
    const result = await this.members.list(scope, page);
    const Resources = result.members.map(member => this.resource(scope, member));
    return { schemas: [listSchema], totalResults: result.total, startIndex: page.startIndex, itemsPerPage: Resources.length, Resources };
  }

  async get(scope: ScimScope, id: string) {
    const member = await this.members.get(scope, id);
    if (!member) throw missing();
    return this.resource(scope, member);
  }

  async create(scope: ScimScope, body: unknown) {
    return this.resource(scope, await this.members.create(scope, input(body)));
  }

  async update(scope: ScimScope, id: string, body: unknown, method: 'PATCH' | 'PUT') {
    let member: ScimMember | null;
    if (method === 'PATCH') member = await this.members.update(scope, id, patch(body));
    else {
      const { externalId, ...update } = input(body, true);
      member = await this.members.update(scope, id, update, externalId);
    }
    if (!member) throw missing();
    return this.resource(scope, member);
  }

  async remove(scope: ScimScope, id: string) {
    if (!await this.members.remove(scope, id)) throw missing();
  }
}
