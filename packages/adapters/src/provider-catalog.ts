import type { AuthStrategy, CapabilityDecl, Phase, ProviderKey } from './adapter-types.ts';

const api = (operation: string, phase: Phase, content_format = '*', requires_scopes: string[] = [], requires_review = false): CapabilityDecl => ({ operation, content_format, phase, executor: 'api', readiness: 'implemented', requires_scopes, requires_review });
const planned = (operation: string, phase: Phase, content_format = '*', note?: string): CapabilityDecl => ({ operation, content_format, phase, executor: 'api', readiness: 'planned', note });
const unverified = (operation: string, phase: Phase, content_format: string, note: string): CapabilityDecl => ({ ...planned(operation, phase, content_format, note), readiness: 'unverified' });
const unsupported = (operation: string, content_format = '*'): CapabilityDecl => ({ operation, content_format, phase: 'P0a', readiness: 'unsupported' });
const manual = (operation: string): CapabilityDecl => ({ operation, content_format: '*', phase: 'P0a', executor: 'manual', readiness: 'planned' });
const connector = (channel: 'browser' | 'mobile', operation = 'publish', phase: Phase = 'P0b'): CapabilityDecl => ({ operation, content_format: '*', phase, executor: 'connector', connector_channel: channel, readiness: operation === 'publish' || operation === 'complete_draft' ? 'implemented' : 'planned', note: channel === 'mobile' ? 'Android P0b; iPhone P1 on macOS; account binding and risk controls required' : 'Windows or macOS; account binding and risk controls required' });
const file = (operation: string, phase: Phase): CapabilityDecl => ({ operation, content_format: '*', phase, executor: 'import', readiness: 'planned' });
const shop = (phase: Phase, products: CapabilityDecl, trade?: { orders: string[]; refunds: string[] }) => [
  file('product_read', phase === 'P2' ? 'P2' : 'P0a'), products,
  trade ? api('order_read', phase, '*', trade.orders) : planned('order_read', phase),
  trade ? api('refund_read', phase, '*', trade.refunds) : planned('refund_read', phase),
  file('order_read', phase), file('refund_read', phase),
];
const igBasic = ['instagram_business_basic'];
const igPublish = [...igBasic, 'instagram_business_content_publish'];
const yt = 'https://www.googleapis.com/auth/youtube';
const ytRead = [`${yt}.readonly|${yt}|${yt}.force-ssl`];
const ytWrite = [`${yt}.upload|${yt}|${yt}.force-ssl`];
const pageRead = ['pages_read_engagement'];
const pageWrite = [...pageRead, 'pages_manage_posts'];

type ProviderDecl = { authStrategy: AuthStrategy; api_version: string | null; authVariant?: string; capabilities: readonly CapabilityDecl[]; note?: string };
const catalog: Record<ProviderKey, ProviderDecl> = {
  meta_instagram: { authStrategy: 'oauth2', api_version: 'v24.0', authVariant: 'instagram_login', note: 'Unified Login requires access validation.', capabilities: [
    ...['image', 'reel', 'story', 'carousel'].map(format => api('publish', 'P0a', format, igPublish)),
    api('post_read', 'P0a', '*', igBasic), planned('insights_read', 'P0a'), api('comment_read', 'P0a', '*', [...igBasic, 'instagram_business_manage_comments']), planned('comment_reply', 'P0a'), planned('comment_hide', 'P1'), planned('dm_read', 'P1'), planned('dm_send', 'P1'),
    unsupported('publish_schedule'), manual('edit_post'), manual('delete_post'), connector('mobile'),
  ] },
  meta_facebook: { authStrategy: 'oauth2', api_version: 'v24.0', authVariant: 'facebook_login_for_business', capabilities: [
    api('publish', 'P0a', 'text', pageWrite), api('publish', 'P0a', 'image', pageWrite), api('publish_schedule', 'P0a', 'text', pageWrite), api('post_read', 'P0a', '*', pageRead),
    api('scheduled_post_read', 'P1', '*', pageWrite),
    planned('publish', 'P0a', 'video'), unverified('publish', 'P0a', 'reel', 'Reels endpoint requires access validation'), unverified('publish', 'P0a', 'carousel', 'Multi-photo endpoint requires access validation'),
    api('comment_read', 'P0a', '*', [...pageRead, 'pages_read_user_engagement']), planned('comment_reply', 'P0a'), planned('insights_read', 'P0a'), planned('edit_post', 'P1'), planned('delete_post', 'P1'), planned('comment_hide', 'P1'), planned('dm_read', 'P1'), connector('mobile'),
  ] },
  tiktok: { authStrategy: 'oauth2', api_version: 'v2', authVariant: 'login_kit', note: 'Accounts API requires a separate app and connection.', capabilities: [
    api('publish_upload', 'P0a', 'video', ['video.upload']), api('publish', 'P0b', 'video', ['video.publish'], true), planned('publish', 'P0b', 'image'), planned('publish', 'P0b', 'carousel'),
    planned('post_read', 'P0b'), planned('insights_read', 'P0b'), planned('comment_read', 'P0b'), planned('comment_reply', 'P0b'), planned('comment_hide', 'P1'), unsupported('publish_schedule'), manual('edit_post'), manual('delete_post'), connector('mobile', 'complete_draft'),
  ] },
  youtube: { authStrategy: 'oauth2', api_version: 'v3', capabilities: [
    api('post_read', 'P0a', '*', ytRead), api('insights_read', 'P0a', '*', ytRead),
    ...['video', 'short'].flatMap(format => [api('publish', 'P0a', format, ytWrite), api('publish_schedule', 'P0a', format, ytWrite)]),
    api('comment_read', 'P0b', '*', [`${yt}.force-ssl`]), planned('comment_reply', 'P0b'), planned('analytics_read', 'P0b'), planned('comment_hide', 'P1'), api('edit_post', 'P1', '*', [`${yt}|${yt}.force-ssl`]), api('delete_post', 'P1', '*', [`${yt}|${yt}.force-ssl`]), unsupported('publish', 'image'), unsupported('dm_read'), unsupported('dm_send'),
  ] },
  douyin: { authStrategy: 'oauth2', api_version: 'v2', note: 'D1 data minimization; official posting admission is unverified.', capabilities: [
    manual('publish'), connector('browser'), connector('mobile'), manual('post_read'), file('insights_read', 'P0a'), unverified('publish', 'P1', 'video', 'video.create.bind eligibility and per-post consent required'),
    planned('post_read', 'P1'), planned('insights_read', 'P1'), planned('comment_read', 'P1'), planned('comment_reply', 'P1'), planned('dm_read', 'P1'),
    { ...connector('mobile', 'comment_read', 'P1'), readiness: 'unverified' }, { ...connector('mobile', 'comment_reply', 'P1'), readiness: 'unverified' },
  ] },
  xiaohongshu: { authStrategy: 'connector_session', api_version: null, note: 'Only basic_info publicly documented; D1 data minimization applies.', capabilities: [
    unverified('profile_read', 'P0a', '*', 'Official basic_info authorization requires verification'), manual('publish'), unsupported('publish'), connector('browser'), connector('mobile'), manual('post_read'), file('insights_read', 'P0a'), connector('browser', 'post_read', 'P1'), unsupported('comment_read'), unsupported('comment_reply'), unsupported('dm_read'), unsupported('dm_send'),
    { ...connector('mobile', 'comment_read', 'P1'), readiness: 'unverified' }, { ...connector('mobile', 'comment_reply', 'P1'), readiness: 'unverified' },
  ] },
  tiktok_shop: { authStrategy: 'oauth2', api_version: '202309', capabilities: [...shop('P1', api('product_read', 'P0b', '*', ['seller.product.info']), { orders: [], refunds: [] }), planned('affiliate_read', 'P1'), { ...api('product_webhook', 'P0b'), note: 'Signed product status change triggers an authorized catalog read' }] },
  shopify: { authStrategy: 'oauth2', api_version: '2026-10', note: 'D16 custom app per customer; custom distribution requires fixed egress allowlisting.', capabilities: [
    ...shop('P1', { ...api('product_read', 'P0b', '*', ['read_products']), note: 'Paginated Admin GraphQL with base prices and optional aggregate inventory. Bulk, market pricing and location inventory are pending.' }, { orders: ['read_orders'], refunds: ['read_orders'] }),
    api('product_webhook', 'P0b'), planned('translation_write', 'P1'),
  ] },
  amazon_sp: { authStrategy: 'oauth2', api_version: '2021-08-01', note: 'D14 before Shopee; D19 non-restricted roles only. Notifications use EventBridge or SQS.', capabilities: [
    ...shop('P1', { ...api('product_read', 'P1'), note: 'Listings Items search for one marketplace, with merchant-fulfilled catalog stock. Reports, Catalog Items and FBA inventory are pending.' }, { orders: [], refunds: [] }),
    planned('native_notification', 'P1'),
  ] },
  shopee: { authStrategy: 'oauth2', api_version: 'v2', note: 'D18 ISV ERP System app after Shopify and TikTok Shop.', capabilities: [
    ...shop('P1', planned('product_read', 'P1', '*', 'Credential-backed catalog reads exist in the platform adapter. Official connection and identity verification are pending.')),
    planned('product_webhook', 'P1'),
  ] },
  lazada: { authStrategy: 'oauth2', api_version: null, note: 'D17 defers imports, synchronization and push to P2.', capabilities: [...shop('P2', planned('product_read', 'P2')), planned('product_webhook', 'P2')] },
  file_import: { authStrategy: 'none', api_version: null, capabilities: [file('product_read', 'P0a'), file('order_read', 'P1'), file('refund_read', 'P1')] },
};

for (const provider of Object.values(catalog)) {
  for (const capability of provider.capabilities) {
    if (capability.requires_scopes) Object.freeze(capability.requires_scopes);
    Object.freeze(capability);
  }
  Object.freeze(provider.capabilities);
  Object.freeze(provider);
}
export const providerCatalog = Object.freeze(catalog);
export const providers = Object.freeze(Object.keys(catalog) as ProviderKey[]);
