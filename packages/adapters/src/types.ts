export type PlatformProvider = 'meta_instagram' | 'meta_facebook' | 'tiktok' | 'tiktok_shop' | 'youtube' | 'douyin' | 'xiaohongshu' | 'shopify' | 'amazon_sp' | 'shopee' | 'lazada' | 'file_import';
export type OperationKey = 'publish' | 'upload_draft' | 'prepare_publish' | 'observe' | 'catalog' | 'file_import';
export type Phase = 'P0a' | 'P0b' | 'P1' | 'P2';
export interface CapabilityDecl {
  operation: OperationKey;
  executor: 'api' | 'connector' | 'manual' | 'import';
  phase: Phase;
  channel?: 'browser' | 'mobile';
  scopes?: readonly string[];
  approval?: string;
  implemented: boolean;
}
export interface PlatformDefinition {
  provider: PlatformProvider;
  authStrategy: 'oauth2' | 'connector_session' | 'none';
  apiVersion?: string;
  capabilities: readonly CapabilityDecl[];
  sources: Readonly<Record<string, string>>;
}
export interface Credential {
  accountId: string;
  state: 'active' | 'needs_authorization' | 'revoked' | 'expired';
  accessToken: string;
  scopes: readonly string[];
  approvals?: readonly string[];
  expiresAt?: number;
  configuration?: Readonly<Record<string, string>>;
}
export interface ConnectionCtx {
  accountId: string;
  credential?: Credential;
  phase?: Phase;
  device?: {
    id: string;
    accountId: string;
    channel: 'browser' | 'mobile';
    online: boolean;
    compatible: boolean;
    identityVerified: boolean;
    mobileOS?: 'android' | 'ios';
    hostOS?: 'windows' | 'macos';
  };
}
export interface CapabilityReport {
  provider: PlatformProvider;
  accountId: string;
  capabilities: readonly (CapabilityDecl & { available: boolean; reason?: string })[];
}
export interface ExecCtx extends ConnectionCtx {
  client_request_id: string;
  fencing_token: string | number;
  /** Resolved by the execution service from the approved, frozen revision. */
  approval?: { accountId: string; operation: OperationKey; clientRequestId: string };
  /** Set from the persisted attempt before choosing a route. */
  previousOutcome?: 'outcome_unknown' | 'accepted';
}
export type ErrorClass = 'transient' | 'rate_limited' | 'auth_expired' | 'permission_denied' | 'invalid_input' | 'platform_rejected' | 'outcome_unknown' | 'unsupported' | 'quota_exhausted';
export interface ClassifiedError { errorClass: ErrorClass; reason?: string; retryAfter?: string }
export interface TransportRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  /** The transport must reject redirects and must never automatically retry a write. */
  effect: 'read' | 'write';
}
export interface TransportResponse { status: number; headers?: Readonly<Record<string, string>>; body?: unknown }
export type AdapterTransport = (request: TransportRequest) => Promise<TransportResponse>;
export class TransportFailure extends Error {
  readonly delivery: 'not_sent' | 'possibly_sent';
  constructor(delivery: 'not_sent' | 'possibly_sent') {
    super(delivery);
    this.delivery = delivery;
  }
}
export interface ExternalRef {
  provider: PlatformProvider;
  accountId: string;
  kind: 'container' | 'media' | 'page_post' | 'tiktok_publish' | 'youtube_video';
  id: string;
}
export interface OutcomeObservation {
  status: 'running' | 'accepted' | 'published' | 'failed' | 'unknown' | 'cancelled';
  substatus?: string;
  ref?: ExternalRef;
  postIds?: readonly string[];
  url?: string;
  error?: ClassifiedError;
}
export type ExecutionReceipt = OutcomeObservation | { status: 'manual_required'; reason: string };
export interface CatalogItem {
  externalId: string;
  title?: string;
  handle?: string;
  sourceUpdatedAt?: string;
  variants: readonly CatalogVariant[];
  variantsComplete?: boolean;
}
export interface CatalogVariant {
  externalId: string;
  sku?: string;
  selectedOptions?: readonly { name: string; value: string }[];
  price?: string;
  currency?: string;
  available?: number;
  sourceUpdatedAt?: string;
}
export interface SyncPage { items: readonly CatalogItem[]; nextCursor: string | null }
export interface ValidationIssue { field: string; reason: string }
