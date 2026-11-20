import type { Data } from '@smartsell/contracts';
import { currency, integer, invalid, moneyMinor, timestamp } from './ingest-input';

const catalog = ['external_product_id', 'external_variant_id', 'handle', 'title', 'sku', 'option1', 'option2', 'option3', 'currency', 'price', 'price_minor', 'available', 'market_id', 'channel'];
const accounts = ['social_account_id', 'report_date', 'observed_at', 'metric_key', 'value', 'availability'];
const orders = ['external_order_id', 'placed_at', 'external_updated_at', 'currency', 'total', 'total_minor', 'status'];
const refunds = ['external_order_id', 'external_refund_id', 'external_updated_at', 'currency', 'amount', 'amount_minor', 'status'];
export const templates = {
  product_list: { phase: 'P0a', columns: catalog, identity: ['external_product_id', 'external_variant_id'] },
  inventory_list: { phase: 'P0a', columns: ['external_variant_id', 'handle', 'sku', 'option1', 'option2', 'option3', 'location', 'available'], identity: ['location'] },
  social_post_report: { phase: 'P0a', columns: [...accounts, 'external_post_id'], identity: ['social_account_id', 'external_post_id', 'report_date', 'metric_key'] },
  social_account_report: { phase: 'P0a', columns: accounts, identity: ['social_account_id', 'report_date', 'metric_key'] },
  competitor_observation: { phase: 'P0a', columns: ['watch_target_id', 'external_id', 'subject_type', 'url', 'observed_at', 'published_at', 'likes', 'comments', 'shares', 'views'], identity: ['watch_target_id', 'observed_at'] },
  order_list: { phase: 'P1', columns: orders, identity: ['external_order_id'] },
  refund_list: { phase: 'P1', columns: refunds, identity: ['external_order_id', 'external_refund_id'] },
  logistics: { phase: 'P1', columns: ['external_order_id', 'external_shipment_id', 'status', 'observed_at'], identity: ['external_order_id', 'external_shipment_id'] },
  commission: { phase: 'P1', columns: ['external_order_id', 'external_commission_id', 'currency', 'amount', 'amount_minor', 'observed_at'], identity: ['external_order_id', 'external_commission_id'] },
  unit_cost: { phase: 'P1', columns: ['sku', 'currency', 'amount', 'amount_minor', 'observed_at'], identity: ['sku', 'observed_at'] },
  ad_report: { phase: 'P1', columns: ['external_ad_id', 'report_date', 'currency', 'amount', 'amount_minor'], identity: ['external_ad_id', 'report_date'] },
};
export type Template = keyof typeof templates;
export function templateKey(value: unknown): Template {
  if (typeof value !== 'string' || !Object.hasOwn(templates, value)) invalid('Unknown import template');
  return value as Template;
}

const common: Record<string, string> = {
  'product id': 'external_product_id', 'item id': 'external_product_id', 'variant id': 'external_variant_id', 'sku id': 'external_variant_id',
  'product name': 'title', 'item name': 'title', 'variant sku': 'sku', 'seller sku': 'sku', 'variant price': 'price',
  'variant inventory qty': 'available', 'available (new)': 'available', quantity: 'available',
  'option1 value': 'option1', 'option2 value': 'option2', 'option3 value': 'option3',
  'order id': 'external_order_id', 'order number': 'external_order_id', 'order creation date': 'placed_at',
  'refund id': 'external_refund_id', 'return id': 'external_refund_id', 'refund amount': 'amount',
  'order total': 'total', 'order status': 'status', 'refund status': 'status',
};
const amazon: Record<string, string> = {
  'seller-sku': 'sku', 'item-name': 'title', 'asin1': 'external_product_id', 'asin': 'external_product_id',
  'amazon-order-id': 'external_order_id', 'order-id': 'external_order_id', 'purchase-date': 'placed_at',
  'last-updated-date': 'external_updated_at', 'order-status': 'status', 'refund-id': 'external_refund_id',
};
export const forbiddenColumn = (value: string) => /buyer|recipient|shipping.address|delivery.address|billing.address|street|postal|post.?code|zip.?code|phone|e.?mail|contact|private.message|address|tracking.number|customer|full.?name|first.?name|last.?name|consignee|收件|買家|买家|郵編|邮编|地址|電話|电话|姓名/i.test(value);
export const privateValue = (value: string) => /[^\s@,]+@[^\s@,]+\.[a-z]{2,}/i.test(value);

export function builtinMapping(template: Template, provider: string, headers: string[]): Record<string, string> {
  const aliases = provider === 'amazon_sp' ? { ...common, ...amazon } : common;
  const selected = new Set<string>();
  const entries: [string, string][] = [];
  for (const header of headers) {
    const normalized = header.toLowerCase();
    const field = Object.hasOwn(aliases, normalized) ? aliases[normalized] : normalized;
    if (!forbiddenColumn(header) && templates[template].columns.includes(field) && !selected.has(field)) {
      entries.push([header, field]);
      selected.add(field);
    }
  }
  return Object.fromEntries(entries);
}

export function normalize(template: Template, raw: Data, mapping: Record<string, string>, options: Data): Data {
  const values: Data = {};
  for (const [header, field] of Object.entries(mapping)) {
    const value = typeof raw[header] === 'string' ? raw[header].trim() : '';
    if (value) values[field] = value;
  }
  if (template.startsWith('social_') && !values.social_account_id && typeof options.social_account_id === 'string') values.social_account_id = options.social_account_id;
  if (template === 'competitor_observation' && !values.watch_target_id && typeof options.watch_target_id === 'string') values.watch_target_id = options.watch_target_id;
  for (const key of ['placed_at', 'external_updated_at', 'observed_at', 'published_at', 'report_date']) {
    if (values[key] !== undefined) {
      if (typeof values[key] === 'string' && /^\d{4}-\d\d-\d\d$/.test(values[key])) {
        if (key === 'report_date') values.report_day = values[key];
        if (key === 'observed_at' && template === 'unit_cost') values.observed_day = values[key];
      }
      values[key] = timestamp(values[key], options.timezone as string | undefined);
      if (key === 'report_date' && template === 'ad_report' && !values.report_day && typeof options.timezone === 'string') {
        const local = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: options.timezone });
        values.report_day = local.format(new Date(values[key] as string));
      }
    }
  }
  if (values.currency !== undefined || options.currency !== undefined) values.currency = currency(values.currency ?? options.currency);
  for (const key of ['price', 'amount', 'total']) {
    if (values[key] === undefined) continue;
    if (!values.currency) invalid(`${key} requires an explicit currency`);
    const converted = moneyMinor(values[key] as string, values.currency as string);
    if (values[`${key}_minor`] !== undefined && integer(values[`${key}_minor`], `${key}_minor`) !== converted) invalid(`${key} and ${key}_minor disagree`);
    values[`${key}_minor`] = converted;
    delete values[key];
  }
  for (const key of ['price_minor', 'total_minor', 'amount_minor', 'available', 'likes', 'comments', 'shares', 'views']) {
    if (values[key] !== undefined) values[key] = integer(values[key], key);
  }
  if (['price_minor', 'total_minor', 'amount_minor'].some(key => values[key] !== undefined) && !values.currency) invalid('Currency is required for monetary values');
  const optionsList = ['option1', 'option2', 'option3'].map(key => values[key]).filter((value): value is string => typeof value === 'string');
  if (optionsList.length) values.options = optionsList;
  for (const key of ['option1', 'option2', 'option3']) delete values[key];
  return values;
}

export function identity(template: Template, row: Data): string {
  const fields = templates[template].identity;
  if (template === 'product_list') {
    const product = row.external_product_id ?? row.handle ?? row.sku;
    if (!product) invalid('Product requires an external ID, handle or SKU');
    return JSON.stringify([product, row.external_variant_id ?? row.options ?? row.sku ?? null, row.market_id ?? null, row.channel ?? null]);
  }
  if (template === 'inventory_list') {
    const variant = row.external_variant_id ?? row.sku ?? (row.handle ? [row.handle, row.options ?? []] : undefined);
    if (!variant || !row.location) invalid('Inventory requires a variant reference and location');
    return JSON.stringify([variant, row.location]);
  }
  if (fields.some(field => row[field] === undefined)) invalid(`Required fields: ${fields.join(', ')}`);
  if (template === 'ad_report') return JSON.stringify([row.external_ad_id, row.report_day ?? row.report_date]);
  if (template === 'unit_cost') return JSON.stringify([row.sku, row.observed_day ?? row.observed_at]);
  return JSON.stringify([...fields.map(field => row[field]), ...(template === 'competitor_observation' ? [row.external_id ?? row.url] : [])]);
}
