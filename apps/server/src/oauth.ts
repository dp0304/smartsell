import { randomUUID } from 'node:crypto';
import { Problem } from '@smartsell/contracts';
import type { Store } from '@smartsell/db';
import type { FastifyInstance } from 'fastify';
import { bodyObject, digest, invalid, membership, nowSeconds, opaque, originGuard, registerGrant, type Auth, type Grant } from './identity.js';
import type { Config } from './config.js';
import type { Registered } from './operations.js';

interface Client { client_id: string; client_name: string; redirect_uris: string[]; token_endpoint_auth_method: 'none' }
interface Authorization {
  clientId: string; redirectUri: string; challenge: string; state?: string; access: Grant['access']; workspaceId: string;
}
interface Code extends Authorization { userId: string; expires: number }
const accessScope = (access: Grant['access']) => `smartsell:${access}`;
const html = (value: string) => value.replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[match]!);

function redirectUri(raw: unknown, production: boolean) {
  if (typeof raw !== 'string' || raw.length > 2048) throw invalid('Invalid redirect_uri');
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid('Invalid redirect_uri'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.hash || raw.includes('#') || url.username || url.password || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw invalid('Use an exact HTTPS or loopback HTTP redirect URI');
  }
  if (production && url.protocol === 'http:' && url.hostname === 'localhost') throw invalid('Use an IP literal for loopback redirects');
  return raw;
}

export function tokenRoutes(app: FastifyInstance, store: Store, auth: Auth, operations: Registered[]) {
  app.post('/api/v1/workspaces/:ws/tokens', async (req, reply) => {
    const data = bodyObject(req.body);
    const { ws } = req.params as { ws: string };
    const access = data.access === undefined ? 'read' : data.access;
    if (access !== 'read' && access !== 'write') throw invalid('access must be read or write');
    const ttl = data.expires_in ?? 30 * 86400;
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 60 || ttl > 90 * 86400) throw invalid('Invalid token lifetime');
    const tools = data.tools;
    if (tools !== undefined && (!Array.isArray(tools) || tools.length > 200 || tools.some(name => typeof name !== 'string' || !operations.some(op => op.name === name)))) {
      throw invalid('tools must contain known operation names');
    }
    const result = await store.transaction({ identityWrite: true }, ({ identity }) => {
      const principal = auth.authenticate(identity, req, 'session');
      auth.csrf(req, principal);
      membership(identity, principal, ws);
      return registerGrant(identity, { kind: 'pat', userId: principal.user.id, workspaceId: ws, access, tools: tools as string[] | undefined, expires: nowSeconds() + ttl });
    });
    return reply.code(201).send({ data: { id: result.grant.id, token: result.token, expires_in: ttl } });
  });

  app.delete('/api/v1/workspaces/:ws/tokens/:tokenId', async (req, reply) => {
    const { ws, tokenId } = req.params as { ws: string; tokenId: string };
    await store.transaction({ identityWrite: true }, ({ identity }) => {
      const principal = auth.authenticate(identity, req, 'session');
      auth.csrf(req, principal);
      membership(identity, principal, ws);
      const index = `grant-index/${principal.user.id}/${tokenId}`;
      const key = identity.get<string>(index);
      const grant = key && identity.get<Grant>(`grant/${key}`);
      if (!key || !grant || grant.workspaceId !== ws || grant.kind !== 'pat') throw new Problem(404, 'NOT_FOUND', 'Token not found');
      identity.delete(`grant/${key}`);
      identity.delete(index);
    });
    return reply.code(204).send();
  });
}

export function oauthRoutes(app: FastifyInstance, store: Store, auth: Auth, config: Config, throttleLogin: (ip: string) => void) {
  const issuer = config.origin;
  const resource = `${issuer}/mcp`;
  const scopes = ['smartsell:read', 'smartsell:write'];
  const protectedMetadata = () => ({ resource, authorization_servers: [issuer], scopes_supported: scopes, bearer_methods_supported: ['header'] });
  app.get('/.well-known/oauth-protected-resource', protectedMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedMetadata);
  app.get('/.well-known/oauth-authorization-server', () => ({
    issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: scopes,
  }));
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    const fields = [...new URLSearchParams(String(body))];
    if (new Set(fields.map(([key]) => key)).size !== fields.length) return done(invalid('Duplicate form field'));
    done(null, Object.fromEntries(fields));
  });

  app.post('/oauth/register', async (req, reply) => {
    const data = bodyObject(req.body);
    if ((data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== 'none') ||
      !Array.isArray(data.redirect_uris) || !data.redirect_uris.length || data.redirect_uris.length > 10) {
      return reply.code(400).send({ error: 'invalid_client_metadata' });
    }
    const client: Client = {
      client_id: randomUUID(), client_name: typeof data.client_name === 'string' ? data.client_name.slice(0, 120) : 'MCP client',
      redirect_uris: data.redirect_uris.map(uri => redirectUri(uri, config.production)), token_endpoint_auth_method: 'none',
    };
    await store.transaction({ identityWrite: true }, ({ identity }) => identity.put(`oauth-client/${client.client_id}`, client));
    return reply.code(201).send({ ...client, grant_types: ['authorization_code'], response_types: ['code'] });
  });

  function authorization(data: Record<string, unknown>): Authorization {
    const { client_id, redirect_uri, code_challenge, state, workspace_id } = data;
    const scope = data.scope ?? scopes[0];
    if (typeof client_id !== 'string' || typeof redirect_uri !== 'string' || data.response_type !== 'code' || data.code_challenge_method !== 'S256' ||
      typeof code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code_challenge) ||
      (state !== undefined && (typeof state !== 'string' || state.length > 1024)) ||
      (scope !== scopes[0] && scope !== scopes[1]) || (data.resource !== undefined && data.resource !== resource)) {
      throw invalid('Invalid authorization request. S256 PKCE is required');
    }
    return { clientId: client_id, redirectUri: redirect_uri, challenge: code_challenge, state,
      access: scope === scopes[1] ? 'write' : 'read', workspaceId: typeof workspace_id === 'string' ? workspace_id : '' };
  }

  const fieldsFor = (flow: Authorization) => ({
    client_id: flow.clientId, redirect_uri: flow.redirectUri, response_type: 'code', code_challenge: flow.challenge,
    code_challenge_method: 'S256', scope: accessScope(flow.access), resource,
    ...(flow.state !== undefined && { state: flow.state }),
  });
  const formFields = (fields: Record<string, string>) => Object.entries(fields)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${html(value)}">`).join('');
  const page = (reply: import('fastify').FastifyReply, title: string, content: string) => reply
    .header('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    .header('referrer-policy', 'no-referrer').type('text/html; charset=utf-8').send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>${content}</html>`,
    );

  app.get('/oauth/authorize', async (req, reply) => {
    const data = bodyObject(req.query);
    const flow = authorization(data);
    const { client, session } = await store.transaction({ readOnly: true }, ({ identity }) => {
      const client = identity.get<Client>(`oauth-client/${flow.clientId}`);
      if (!client?.redirect_uris.includes(flow.redirectUri)) throw invalid('Unregistered redirect_uri');
      try {
        return { client, session: auth.sessionData(identity, auth.authenticate(identity, req, 'session')) };
      } catch (error) {
        if (!(error instanceof Problem) || error.status !== 401) throw error;
        return { client, session: undefined };
      }
    });
    const fields = formFields(fieldsFor(flow));
    if (!session) return page(reply, 'Sign in to SmartSell',
      `<h1>Sign in to SmartSell</h1><form action="/oauth/login" method="post">${fields}` +
      `<input type="hidden" name="workspace_id" value="${html(flow.workspaceId)}">` +
      '<label>Email <input type="email" name="email" autocomplete="username" required></label> ' +
      '<label>Password <input type="password" name="password" autocomplete="current-password" required></label> ' +
      '<button type="submit">Sign in</button></form>',
    );
    const choices = session.workspaces.map(ws => `<option value="${ws.id}"${flow.workspaceId === ws.id ? ' selected' : ''}>${html(ws.name)}</option>`).join('');
    return page(reply, 'Authorize SmartSell access',
      `<h1>Authorize ${html(client.client_name)}</h1><p>${html(new URL(flow.redirectUri).origin)} requests ${flow.access} access.</p>` +
      `<form action="/oauth/authorize" method="post">${fields}<input type="hidden" name="csrf_token" value="${session.csrf_token}">` +
      `<label>Workspace <select name="workspace_id" required>${choices}</select></label> <button type="submit">Authorize</button></form>`,
    );
  });

  app.post('/oauth/login', { bodyLimit: 8192 }, async (req, reply) => {
    originGuard(req, config);
    const data = bodyObject(req.body);
    const flow = authorization(data);
    await store.transaction({ readOnly: true }, ({ identity }) => {
      if (!identity.get<Client>(`oauth-client/${flow.clientId}`)?.redirect_uris.includes(flow.redirectUri)) throw invalid('Unregistered redirect_uri');
    });
    throttleLogin(req.ip);
    const result = await auth.login(req, data);
    if (!('cookie' in result)) return reply.code(409).send({ error: 'additional_authentication_required' });
    const params = new URLSearchParams({ ...fieldsFor(flow), ...(flow.workspaceId && { workspace_id: flow.workspaceId }) });
    return reply.header('set-cookie', result.cookie).redirect(`/oauth/authorize?${params}`, 303);
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const data = bodyObject(req.body);
    const flow = authorization(data);
    const code = opaque();
    await store.transaction({ identityWrite: true }, ({ identity }) => {
      const principal = auth.authenticate(identity, req, 'session');
      auth.csrf(req, principal, data.csrf_token);
      membership(identity, principal, flow.workspaceId);
      const client = identity.get<Client>(`oauth-client/${flow.clientId}`);
      if (!client?.redirect_uris.includes(flow.redirectUri)) throw invalid('Unregistered redirect_uri');
      identity.put(`oauth-code/${digest(code)}`, { ...flow, userId: principal.user.id, expires: nowSeconds() + 300 } satisfies Code);
    });
    const location = new URL(flow.redirectUri);
    location.searchParams.set('code', code);
    if (flow.state !== undefined) location.searchParams.set('state', flow.state);
    return reply.header('referrer-policy', 'no-referrer').redirect(location.href, 303);
  });

  app.post('/oauth/token', async (req, reply) => {
    originGuard(req, config);
    const data = bodyObject(req.body);
    const { code, code_verifier, client_id, redirect_uri } = data;
    if (data.grant_type !== 'authorization_code') return reply.code(400).send({ error: 'unsupported_grant_type' });
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code) || typeof code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier) ||
      (data.resource !== undefined && data.resource !== resource)) return reply.code(400).send({ error: 'invalid_grant' });
    const expiresIn = 3600;
    const grant = await store.transaction({ identityWrite: true }, ({ identity }) => {
      const key = `oauth-code/${digest(code)}`;
      const stored = identity.get<Code>(key);
      if (!stored || stored.expires <= nowSeconds() || stored.clientId !== client_id || stored.redirectUri !== redirect_uri ||
        stored.challenge !== digest(code_verifier) || !identity.get(`member/${stored.userId}/${stored.workspaceId}`)) return;
      identity.delete(key);
      return registerGrant(identity, {
        kind: 'oauth', clientId: stored.clientId, workspaceId: stored.workspaceId, userId: stored.userId, access: stored.access, expires: nowSeconds() + expiresIn,
      });
    });
    if (!grant) return reply.code(400).send({ error: 'invalid_grant' });
    return { access_token: grant.token, token_type: 'Bearer', expires_in: expiresIn, scope: accessScope(grant.grant.access) };
  });

  app.post('/oauth/revoke', async req => {
    const { token, client_id } = bodyObject(req.body);
    if (typeof token === 'string' && typeof client_id === 'string') {
      await store.transaction({ identityWrite: true }, ({ identity }) => {
        const key = `grant/${digest(token)}`;
        const grant = identity.get<Grant>(key);
        if (grant?.kind !== 'oauth' || grant.clientId !== client_id) return;
        identity.delete(key);
        identity.delete(`grant-index/${grant.userId}/${grant.id}`);
      });
    }
    return {};
  });
}
