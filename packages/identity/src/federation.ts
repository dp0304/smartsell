import { SAML, ValidateInResponseTo, type CacheProvider } from '@node-saml/node-saml';
import { DOMParser } from '@xmldom/xmldom';
import * as oidc from 'openid-client';
import { digest, IdentityError, IdentitySecrets, type IdentityState, opaque } from './state.ts';

export type ConnectionScope = { tenantId: string; connectionId: string };
type ConnectionBase = ConnectionScope & { revision: string; scimTokenHash?: string };
export type OidcConnection = ConnectionBase & {
  protocol: 'oidc'; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string;
  clientId: string; clientSecret?: string; signingAlgorithm: 'RS256' | 'PS256' | 'ES256';
};
export type SamlConnection = ConnectionBase & {
  protocol: 'saml'; issuer: string; entryPoint: string; entityId: string; idpCert: string | string[];
  nameIdFormat: string; requestSigningKey?: string;
};
export type EnterpriseConnection = OidcConnection | SamlConnection;
export type ConnectionLookup = (scope: ConnectionScope) => Promise<EnterpriseConnection | null>;
export type FederationProof = ConnectionScope & { revision: string; subject: string; method: 'oidc' | 'saml' };
export type OidcTransport = (scope: ConnectionScope, url: string, options: Parameters<oidc.CustomFetch>[1]) => Promise<Response>;

type Flow = { revision: string; protocol: 'oidc'; verifier: string; nonce: string } |
  { revision: string; protocol: 'saml'; requestId: string; initiatedAt: string };

const flowLifetime = 300_000;
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const bearer = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

export function httpsUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Expected an HTTPS URL');
  return url;
}

export async function scopedConnection(lookup: ConnectionLookup, scope: ConnectionScope) {
  if (!identifier.test(scope.tenantId) || !identifier.test(scope.connectionId)) throw new IdentityError(404, 'Connection unavailable');
  const connection = await lookup(scope);
  if (!connection || connection.tenantId !== scope.tenantId || connection.connectionId !== scope.connectionId) {
    throw new IdentityError(404, 'Connection unavailable');
  }
  return connection;
}

function samlCache(requestId: string, initial: string | null): CacheProvider {
  let value = initial;
  const consume = async (key: string | null) => {
    if (key !== requestId) return null;
    const prior = value;
    value = null;
    return prior;
  };
  return {
    async saveAsync(key, saved) {
      if (key !== requestId) return null;
      value = saved;
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) { return key === requestId ? value : null; },
    removeAsync: consume,
    consumeAsync: consume,
  };
}

function saml(connection: SamlConnection, callbackUrl: string, requestId: string, initiatedAt: string | null) {
  return new SAML({
    issuer: connection.entityId, idpIssuer: connection.issuer, audience: connection.entityId,
    entryPoint: httpsUrl(connection.entryPoint).href, callbackUrl, idpCert: connection.idpCert,
    identifierFormat: connection.nameIdFormat, privateKey: connection.requestSigningKey,
    signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256',
    wantAuthnResponseSigned: true, wantAssertionsSigned: true,
    validateInResponseTo: ValidateInResponseTo.always, requestIdExpirationPeriodMs: flowLifetime,
    maxAssertionAgeMs: flowLifetime, acceptedClockSkewMs: 5_000,
    generateUniqueId: () => requestId, cacheProvider: samlCache(requestId, initiatedAt),
  });
}

// This structure comes from node-saml's verified assertion accessor.
function samlSubject(assertion: unknown, connection: SamlConnection, callback: string, requestId: string) {
  const data = assertion as { Assertion?: {
    Issuer?: { _: string }[];
    AuthnStatement?: unknown[];
    Conditions?: { $: { NotOnOrAfter?: string } }[];
    Subject?: { NameID?: { _: string; $?: { Format?: string } }[];
      SubjectConfirmation?: { $: { Method: string }; SubjectConfirmationData?: {
        $: { Recipient?: string; InResponseTo?: string; NotOnOrAfter?: string; NotBefore?: string };
      }[] }[] }[];
  } };
  const claim = data.Assertion;
  const subjects = claim?.Subject;
  const names = subjects?.[0]?.NameID;
  const name = names?.[0];
  if (claim?.Issuer?.length !== 1 || claim.Issuer[0]._ !== connection.issuer || !claim.AuthnStatement?.length ||
    claim.Conditions?.length !== 1 || !claim.Conditions[0].$?.NotOnOrAfter ||
    subjects?.length !== 1 || names?.length !== 1 || name?.$?.Format !== connection.nameIdFormat) throw new IdentityError();
  const now = Date.now();
  const confirmed = subjects[0].SubjectConfirmation?.some(confirmation => {
    const fields = confirmation.SubjectConfirmationData?.[0]?.$;
    return confirmation.$?.Method === bearer && confirmation.SubjectConfirmationData?.length === 1 &&
      fields?.Recipient === callback && fields.InResponseTo === requestId &&
      now < Date.parse(fields.NotOnOrAfter ?? '') + 5_000 &&
      (!fields.NotBefore || now + 5_000 >= Date.parse(fields.NotBefore));
  });
  if (!confirmed) throw new IdentityError();
  return name?._;
}

export class FederationIdentity {
  constructor(private readonly state: IdentityState, private readonly secrets: IdentitySecrets,
    private readonly lookup: ConnectionLookup, private readonly transport: OidcTransport, private readonly origin: string) {
    if (httpsUrl(origin).origin !== origin) throw new Error('Expected a canonical SaaS HTTPS origin');
  }

  private path(scope: ConnectionScope, protocol: Flow['protocol']) {
    return `/api/v1/auth/sso/${scope.tenantId}/${scope.connectionId}/${protocol}`;
  }

  private flowKey(scope: ConnectionScope, state: string) {
    return `sso:${scope.tenantId}:${scope.connectionId}:${digest(state)}`;
  }

  private oidc(connection: OidcConnection) {
    const issuer = httpsUrl(connection.issuer);
    if (issuer.search || !['RS256', 'PS256', 'ES256'].includes(connection.signingAlgorithm)) throw new IdentityError();
    const authorization = httpsUrl(connection.authorizationEndpoint).href;
    const token = httpsUrl(connection.tokenEndpoint).href;
    const keys = httpsUrl(connection.jwksUri).href;
    const config = new oidc.Configuration({ issuer: connection.issuer, authorization_endpoint: authorization,
      token_endpoint: token, jwks_uri: keys }, connection.clientId,
    { id_token_signed_response_alg: connection.signingAlgorithm },
    connection.clientSecret ? oidc.ClientSecretBasic(connection.clientSecret) : oidc.None());
    config.timeout = 5;
    config[oidc.customFetch] = async (url, options) => {
      if (!((url === token && options.method === 'POST') || (url === keys && options.method === 'GET'))) throw new IdentityError();
      const response = await this.transport({ tenantId: connection.tenantId, connectionId: connection.connectionId }, url, options);
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new IdentityError();
      return response;
    };
    oidc.enableNonRepudiationChecks(config);
    return config;
  }

  async begin(scope: ConnectionScope, protocol: Flow['protocol']) {
    const connection = await scopedConnection(this.lookup, scope);
    if (connection.protocol !== protocol) throw new IdentityError(404, 'Connection unavailable');
    const state = oidc.randomState();
    const browser = opaque();
    const callback = `${this.origin}${this.path(scope, protocol)}/callback`;
    const key = this.flowKey(scope, state);
    let flow: Flow;
    let redirect: string;
    try {
      if (connection.protocol === 'oidc') {
        const verifier = oidc.randomPKCECodeVerifier();
        const nonce = oidc.randomNonce();
        flow = { revision: connection.revision, protocol: 'oidc', verifier, nonce };
        redirect = oidc.buildAuthorizationUrl(this.oidc(connection), {
          redirect_uri: callback, scope: 'openid', response_type: 'code', state, nonce,
          code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        }).href;
      } else {
        const requestId = `_${opaque()}`;
        const initiatedAt = new Date().toISOString();
        flow = { revision: connection.revision, protocol: 'saml', requestId, initiatedAt };
        redirect = await saml(connection, callback, requestId, null).getAuthorizeUrlAsync(state, {});
      }
    } catch { throw new IdentityError(503, 'Identity provider unavailable'); }
    await this.state.putFlow(key, digest(browser), Date.now() + flowLifetime, this.secrets.seal(JSON.stringify(flow), key));
    return { state, browser, redirect };
  }

  async finish(scope: ConnectionScope, protocol: Flow['protocol'], state: string, browser: string,
    response: URLSearchParams | string): Promise<FederationProof> {
    if (!opaquePattern.test(state) || !opaquePattern.test(browser)) throw new IdentityError();
    const key = this.flowKey(scope, state);
    const sealed = await this.state.takeFlow<string>(key, digest(browser));
    if (!sealed) throw new IdentityError();
    const flow = JSON.parse(this.secrets.open(sealed, key)) as Flow;
    const connection = await scopedConnection(this.lookup, scope);
    if (flow.protocol !== protocol || connection.protocol !== protocol || connection.revision !== flow.revision) throw new IdentityError();
    const callback = `${this.origin}${this.path(scope, protocol)}/callback`;
    let subject: unknown;
    try {
      if (connection.protocol === 'oidc' && flow.protocol === 'oidc' && response instanceof URLSearchParams) {
        const callbackUrl = new URL(callback);
        callbackUrl.search = response.toString();
        const tokens = await oidc.authorizationCodeGrant(this.oidc(connection), callbackUrl, {
          expectedState: state, expectedNonce: flow.nonce, pkceCodeVerifier: flow.verifier, idTokenExpected: true,
        });
        subject = tokens.claims()?.sub;
      } else if (connection.protocol === 'saml' && flow.protocol === 'saml' && typeof response === 'string') {
        if (response.length > 256 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(response)) throw new IdentityError();
        // Require exact routing fields before passing the same bytes to the mandatory signature checks.
        const document = new DOMParser().parseFromString(Buffer.from(response, 'base64').toString('utf8'), 'application/xml');
        const root = document.documentElement;
        const protocolNamespace = 'urn:oasis:names:tc:SAML:2.0:protocol';
        if (document.doctype || root?.namespaceURI !== protocolNamespace || root.localName !== 'Response' ||
          root.getAttribute('Destination') !== callback || root.getAttribute('InResponseTo') !== flow.requestId) throw new IdentityError();
        const statuses = root.getElementsByTagNameNS(protocolNamespace, 'Status');
        const codes = statuses.item(0)?.getElementsByTagNameNS(protocolNamespace, 'StatusCode');
        if (statuses.length !== 1 || statuses.item(0)?.parentNode !== root || codes?.length !== 1 ||
          codes.item(0)?.getAttribute('Value') !== 'urn:oasis:names:tc:SAML:2.0:status:Success') throw new IdentityError();
        const result = await saml(connection, callback, flow.requestId, flow.initiatedAt)
          .validatePostResponseAsync({ SAMLResponse: response });
        if (!result.loggedOut && result.profile) {
          subject = samlSubject(result.profile.getAssertion?.(), connection, callback, flow.requestId);
        }
      }
    } catch { throw new IdentityError(); }
    if (typeof subject !== 'string' || subject.length === 0 || subject.length > 255 || /[\u0000-\u001f\u007f]/.test(subject)) throw new IdentityError();
    return { ...scope, revision: flow.revision, subject, method: protocol };
  }
}
