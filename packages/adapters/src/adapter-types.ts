export type ProviderKey = 'meta_instagram' | 'meta_facebook' | 'tiktok' | 'tiktok_shop' | 'youtube' | 'douyin' | 'xiaohongshu' | 'shopify' | 'shopee' | 'lazada' | 'amazon_sp' | 'file_import';
export type Phase = 'P0a' | 'P0b' | 'P1' | 'P2';
export type Executor = 'api' | 'connector' | 'manual' | 'import';
export type AuthStrategy = 'oauth2' | 'connector_session' | 'api_key' | 'none';
export type OperationKey = string;
export type SyncResource = string;
export type Cursor = string;
export type ErrorClass = 'transient' | 'rate_limited' | 'auth_expired' | 'permission_denied' | 'invalid_input' | 'platform_rejected' | 'outcome_unknown' | 'unsupported' | 'quota_exhausted';
export interface ClassifiedError { errorClass: ErrorClass; reason?: string; retryAfter?: string }
export interface TransportRequest { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; headers: Record<string, string>; body?: string | Uint8Array }
export interface TransportResponse { status: number; headers?: Record<string, string>; body?: unknown }
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;
export interface Credentials {
  clientId: string;
  clientSecret: string;
  webhookSecret?: string;
  webhookVerifyToken?: string;
  facebookConfigId?: string;
  amazonLwaClientId?: string;
  amazonRegion?: 'na' | 'eu' | 'fe';
  amazonMarketplaceId?: string;
  amazonSellerCentralOrigin?: string;
  tiktokShopAuthorizationUrl?: string;
  tiktokVerifiedMediaOrigins?: readonly string[];
  shopifyAuthMode?: 'custom_distribution' | 'client_credentials';
}
export interface AdapterOptions { transport?: Transport; credentials?: Credentials; now?: () => number; phase?: Phase }
export interface ConnectionCtx {
  accessToken?: string;
  externalAccountId?: string;
  shopDomain?: string;
  scopes?: readonly string[];
  shopCipher?: string;
  sellerId?: string;
  uploadsPlaylistId?: string;
  directPostAudited?: boolean;
  pageTasks?: readonly string[];
}
export interface ExecCtx extends ConnectionCtx {
  client_request_id: string;
  fencing_token: string | number;
  previousOutcome?: 'outcome_unknown' | 'accepted';
  credentialState?: 'active' | 'needs_authorization' | 'revoked' | 'expired';
  credentialExpiresAt?: number;
  approval?: { provider: ProviderKey; externalAccountId: string; operation: string; clientRequestId: string };
}
export interface SyncCtx extends ConnectionCtx { objectId?: string; includeInventory?: boolean; window?: { from: string; to: string } }
export interface CapabilityDecl {
  operation: OperationKey;
  content_format: string;
  phase: Phase;
  executor?: Executor;
  connector_channel?: 'browser' | 'mobile';
  readiness: 'implemented' | 'planned' | 'unverified' | 'unsupported';
  requires_scopes?: readonly string[];
  requires_review?: boolean;
  note?: string;
}
export interface Capability extends CapabilityDecl { status: 'available' | 'read_only' | 'needs_authorization' | 'manual_only' | 'unsupported' | 'unverified' }
export interface CapabilityReport {
  provider: ProviderKey;
  status: 'ready' | 'unconfigured' | 'blocked' | 'unsupported';
  capabilities: Capability[];
  externalAccountId?: string;
  accounts?: { externalAccountId: string; name?: string; shopCipher?: string; uploadsPlaylistId?: string; pageTasks?: string[] }[];
  reason?: string;
}
export interface AuthorizationInput { state: string; redirectUri: string; scopes: readonly string[]; codeChallenge?: string; shopDomain?: string }
export interface ExchangeInput { code: string; redirectUri: string; codeVerifier?: string; shopDomain?: string; sellerId?: string; callbackQuery?: Readonly<Record<string, string>> }
export interface RefreshInput { refreshToken: string; shopDomain?: string; sellerId?: string }
export interface TokenSet { accessToken: string; refreshToken?: string; expiresIn?: number; scopes?: string[]; externalAccountId?: string }
export interface OAuth {
  authorizationUrl(input: AuthorizationInput): string;
  exchangeCode(input: ExchangeInput): Promise<TokenSet>;
  refresh(input: RefreshInput): Promise<TokenSet>;
  clientCredentials?(input: { shopDomain: string }): Promise<TokenSet>;
}
export type ExternalRef = { kind: 'container' | 'post' | 'publish' | 'upload_session'; id: string; parentId?: string; visibility?: string; scheduled?: boolean; uploadBytes?: number };
export type ExecutionReceipt = { status: 'accepted' | 'running' | 'failed' | 'unknown'; externalRef?: ExternalRef; subStatus?: string; error?: ClassifiedError };
export type ReceiptOrQuery = ExternalRef | ExecutionReceipt;
export type OutcomeObservation = { status: 'running' | 'accepted' | 'published' | 'failed' | 'retryable' | 'cancelled' | 'unknown'; subStatus?: string; externalRef?: ExternalRef; postIds?: string[]; permalink?: string; error?: ClassifiedError };
export interface CancelReceipt { status: 'pending' | 'unknown' | 'unsupported'; externalRef?: ExternalRef; error?: ClassifiedError }
export interface SyncPage { items: Record<string, unknown>[]; nextCursor: Cursor | null; totalCount?: number }
export interface RawRequest { headers: Readonly<Record<string, string | undefined>>; rawBody: string | Uint8Array }
export interface ExternalEvent { provider: ProviderKey; type: string; externalId?: string; accountId?: string; action: 'resync' }
export interface ValidationIssue { code: string; field?: string }
export interface Adapter {
  provider: ProviderKey;
  api_version: string | null;
  authStrategy: AuthStrategy;
  oauth?: OAuth;
  staticMatrix(): CapabilityDecl[];
  probe(conn: ConnectionCtx): Promise<CapabilityReport>;
  validate(op: OperationKey, input: unknown, caps: CapabilityReport): ValidationIssue[];
  execute(op: OperationKey, input: unknown, ctx: ExecCtx): Promise<ExecutionReceipt>;
  observe(ref: ReceiptOrQuery, ctx: ExecCtx): Promise<OutcomeObservation>;
  observeMaintenance?(operation: 'edit_post' | 'delete_post', ref: ExternalRef, expectedCaption: string | undefined, ctx: ConnectionCtx): Promise<'verified' | 'inconclusive'>;
  cancel?(ref: ExternalRef, ctx: ExecCtx): Promise<CancelReceipt>;
  readPromotion?(id: string, ctx: ConnectionCtx): Promise<import('./shopify-promotion.ts').PromotionReadback | null>;
  sync(resource: SyncResource, cursor: Cursor | null, ctx: SyncCtx): AsyncIterable<SyncPage>;
  webhook?: { verify(req: RawRequest): boolean; parse(req: RawRequest): ExternalEvent[]; challenge?(query: Readonly<Record<string, string | undefined>>): string | null };
  classifyError(err: unknown): ClassifiedError;
}
export type PlatformAdapter = Adapter;
