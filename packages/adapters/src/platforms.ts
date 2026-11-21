import type { CapabilityDecl, OperationKey, Phase, PlatformDefinition, PlatformProvider } from './types.ts';

const api = (operation: OperationKey, phase: Phase, scopes: string[], approval: string, implemented = true): CapabilityDecl =>
  ({ operation, executor: 'api', phase, scopes, approval, implemented });
const manual: CapabilityDecl = { operation: 'publish', executor: 'manual', phase: 'P0a', implemented: true };
const importer = (phase: Phase = 'P0a'): CapabilityDecl => ({ operation: 'file_import', executor: 'import', phase, implemented: true });
const connector = (channel: 'browser' | 'mobile', operation: OperationKey = 'publish'): CapabilityDecl =>
  ({ operation, executor: 'connector', phase: 'P0b', channel, implemented: false });
const igScopes = ['instagram_business_basic', 'instagram_business_content_publish'];
const googleScopes = ['https://www.googleapis.com/auth/youtube.upload'];

export const platforms: Readonly<Record<PlatformProvider, PlatformDefinition>> = {
  meta_instagram: { provider: 'meta_instagram', authStrategy: 'oauth2', apiVersion: 'v24.0', capabilities: [
    api('prepare_publish', 'P0a', igScopes, 'instagram_content_publishing'), api('publish', 'P0a', igScopes, 'instagram_content_publishing'),
    api('observe', 'P0a', ['instagram_business_basic'], 'instagram_content_publishing'), connector('mobile'), manual,
  ], sources: {
    P01: 'https://developers.facebook.com/docs/instagram-platform/overview',
    P02: 'https://developers.facebook.com/docs/instagram-platform/content-publishing',
    P03: 'https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-container',
  } },
  meta_facebook: { provider: 'meta_facebook', authStrategy: 'oauth2', apiVersion: 'v24.0', capabilities: [
    api('publish', 'P0a', ['pages_manage_posts'], 'facebook_page_publishing'),
    api('observe', 'P0a', ['pages_read_engagement'], 'facebook_page_publishing'), connector('mobile'), manual,
  ], sources: { P07: 'https://developers.facebook.com/documentation/pages-api/posts' } },
  tiktok: { provider: 'tiktok', authStrategy: 'oauth2', apiVersion: 'v2', capabilities: [
    api('upload_draft', 'P0a', ['video.upload'], 'tiktok_inbox'), api('publish', 'P0b', ['video.publish'], 'tiktok_direct_post'),
    api('observe', 'P0a', ['video.upload'], 'tiktok_inbox'), api('observe', 'P0b', ['video.publish'], 'tiktok_direct_post'), connector('mobile', 'upload_draft'), manual,
  ], sources: {
    P08: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
    P09: 'https://developers.tiktok.com/doc/content-sharing-guidelines',
    P10: 'https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status',
    P11: 'https://developers.tiktok.com/doc/content-posting-api-reference-upload-video',
  } },
  youtube: { provider: 'youtube', authStrategy: 'oauth2', apiVersion: 'v3', capabilities: [
    api('publish', 'P0a', googleScopes, 'youtube_upload'),
    api('observe', 'P0a', ['https://www.googleapis.com/auth/youtube.readonly'], 'youtube_upload'), manual,
  ], sources: {
    P18: 'https://developers.google.com/youtube/v3/docs/videos/insert',
    P22: 'https://developers.google.com/youtube/v3/docs/videos',
  } },
  douyin: { provider: 'douyin', authStrategy: 'oauth2', capabilities: [
    api('publish', 'P1', ['video.create.bind'], 'douyin_publish', false), connector('browser'), connector('mobile'), manual,
  ], sources: {
    P23: 'https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create',
    P24: 'https://developer.open-douyin.com/capacity-center-page/capacity-detail/7224121299067469881',
  } },
  xiaohongshu: { provider: 'xiaohongshu', authStrategy: 'connector_session', capabilities: [connector('browser'), connector('mobile'), manual],
    sources: { P29: 'https://openaccount.xiaohongshu.com/docs/scope' } },
  shopify: { provider: 'shopify', authStrategy: 'oauth2', apiVersion: '2026-10', capabilities: [
    importer(), api('catalog', 'P0b', ['read_products', 'read_inventory'], 'shopify_custom_app'),
  ], sources: {
    P33: 'https://shopify.dev/docs/api/usage/versioning', P36: 'https://shopify.dev/docs/api/usage/response-codes',
    P37: 'https://shopify.dev/docs/api/admin-graphql/latest', P39: 'https://shopify.dev/docs/apps/launch/distribution/select-distribution-method',
    P46: 'https://shopify.dev/docs/api/usage/access-scopes',
  } },
  tiktok_shop: { provider: 'tiktok_shop', authStrategy: 'oauth2', apiVersion: '202309', capabilities: [
    importer(), api('catalog', 'P0b', ['seller.product.info'], 'tiktok_shop_product_read'),
  ], sources: { P15: 'https://seller-jp.tiktok.com/university/essay?knowledge_id=8417059081570049&lang=en', P17: 'https://partner.tiktokshop.com/docv2/page/seller-api-overview' } },
  amazon_sp: { provider: 'amazon_sp', authStrategy: 'oauth2', apiVersion: '2021-08-01', capabilities: [
    importer(), api('catalog', 'P1', ['Product Listing'], 'amazon_product_listing'),
  ], sources: {
    P145: 'https://developer-docs.amazon/sp-api/docs/catalog-items-api-v2022-04-01-reference',
    P147: 'https://developer-docs.amazon/sp-api/docs/listings-items-api-v2021-08-01-reference',
  } },
  shopee: { provider: 'shopee', authStrategy: 'oauth2', apiVersion: 'v2', capabilities: [
    importer(), api('catalog', 'P1', ['product'], 'shopee_erp_product_read'),
  ], sources: {
    P73: 'https://open.shopee.com/developer-guide/16', P76: 'https://open.shopee.com/developer-guide/221',
    P77: 'https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1',
    P78: 'https://open.shopee.com/documents/v2/v2.product.get_item_list?module=89&type=1',
  } },
  lazada: { provider: 'lazada', authStrategy: 'none', capabilities: [
    { ...importer('P2'), implemented: false }, api('catalog', 'P2', [], 'lazada_product_read', false),
  ], sources: { P107: 'https://open.lazada.com/apps/doc/api?path=%2Fproducts%2Fget' } },
  file_import: { provider: 'file_import', authStrategy: 'none', capabilities: [importer()], sources: {} },
};
