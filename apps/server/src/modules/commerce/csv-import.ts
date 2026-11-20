import { readXlsx, XlsxError } from '../ingest/xlsx';
import { DomainError, type Fields } from '../types';
import { bad, channels, currency, id, instant, integer, one, purchaseUrl, str, timezone } from './model';

export const templateKeys = ['product_list', 'inventory_list', 'order_list', 'refund_list'] as const;
export type TemplateKey = typeof templateKeys[number];
export type Issue = { line: number; code: string; message: string; severity: 'error' | 'warning' };
export type ImportRow = { line: number; key: string; values: Fields };
export const financialStatuses = ['pending', 'authorized', 'paid', 'partially_paid', 'partially_refunded', 'refunded', 'voided', 'failed', 'cancelled'] as const;
export const refundStatuses = ['requested', 'pending', 'succeeded', 'failed'] as const;
const fulfillmentStatuses = ['unfulfilled', 'partially_fulfilled', 'fulfilled', 'cancelled', 'on_hold', 'pending'] as const;
const templates: Record<TemplateKey, string[]> = {
  product_list: ['external_product_id', 'external_variant_id', 'handle', 'title', 'sku', 'barcode', 'product_type', 'vendor', 'status', 'variant_status', 'option_1_name', 'option_1_value', 'option_2_name', 'option_2_value', 'option_3_name', 'option_3_value', 'price_amount_minor', 'compare_at_amount_minor', 'currency', 'inventory_quantity', 'available_for_sale', 'market_id', 'channel', 'purchase_url', 'source_updated_at'],
  inventory_list: ['handle', 'sku', 'option_1_value', 'option_2_value', 'option_3_value', 'location', 'inventory_quantity'],
  order_list: ['external_order_id', 'placed_at', 'currency', 'total_minor', 'financial_status', 'subtotal_minor', 'discount_minor', 'tax_minor', 'shipping_minor', 'fulfillment_status', 'cancelled_at', 'source_updated_at'],
  refund_list: ['external_order_id', 'external_refund_id', 'created_at', 'currency', 'amount_minor', 'status', 'source_updated_at'],
};
const commonAliases: Record<string, string[]> = {
  title: ['product_name', 'item_name', 'listing_title'], sku: ['seller_sku', 'variant_sku', 'sku_reference_no', 'sku_reference_number'],
  barcode: ['variant_barcode', 'gtin', 'ean', 'upc'], handle: ['url_handle'], external_product_id: ['product_id', 'item_id'], external_variant_id: ['variant_id', 'variation_id', 'model_id', 'sku_id'],
  price_major: ['price', 'retail_price', 'variant_price', 'selling_price', 'current_price'], compare_major: ['variant_compare_at_price', 'compare_at_price', 'original_price'], market_price_major: ['price_international'],
  product_type: ['type'], inventory_quantity: ['variant_inventory_qty', 'quantity', 'available', 'available_not_editable', 'on_hand_current', 'stock', 'stock_quantity'], available_for_sale: ['available_for_sale', 'in_stock'],
  external_order_id: ['order_id', 'order_sn', 'order_number', 'amazon_order_id'], external_refund_id: ['refund_id', 'return_id', 'refund_sn', 'return_sn', 'refund_number', 'transaction_id'],
  placed_at: ['order_date', 'order_creation_date', 'purchase_date', 'created_time', 'order_created_at', 'order_creation_time'], created_at: ['refund_date', 'refund_time', 'refund_created_at', 'posted_date', 'return_request_time', 'creation_time'],
  financial_status: ['order_status', 'payment_status', 'status'], fulfillment_status: ['fulfilment_status'], source_updated_at: ['last_updated_date', 'last_update_date', 'updated_at'],
  status: ['product_status', 'listing_status', 'refund_status', 'return_status'], currency: ['currency_code'], location: ['location_name', 'location_id'],
  total_major: ['order_total', 'total_amount', 'total_payment', 'total'], subtotal_major: ['subtotal', 'product_subtotal'], discount_major: ['discount', 'discount_amount'], tax_major: ['tax', 'tax_amount'], shipping_major: ['shipping', 'shipping_fee', 'shipping_amount'], amount_major: ['refund_amount', 'refund_total', 'amount'],
};
const providerAliases: Record<string, Record<string, string[]>> = {
  amazon_sp: { external_product_id: ['asin1', 'asin'], external_variant_id: ['listing_id'], placed_at: ['purchase_date'], created_at: ['refund_issued_date', 'payments_date'], subtotal_major: ['item_price'], discount_major: ['item_promotion_discount'], tax_major: ['item_tax'], shipping_major: ['shipping_price'] },
  shopee: { title: ['item_product_name'], external_variant_id: ['variation_sku_id'], sku: ['variation_sku'], inventory_quantity: ['current_stock'] },
  tiktok_shop: { title: ['product_name_en'], sku: ['seller_sku_id'], inventory_quantity: ['sku_stock', 'available_stock'] },
};
const extra: Partial<Record<TemplateKey, string[]>> = {
  product_list: ['price_major', 'compare_major', 'market_price_major'],
  order_list: ['total_major', 'subtotal_major', 'discount_major', 'tax_major', 'shipping_major'], refund_list: ['amount_major'],
};
const required: Record<TemplateKey, string[][]> = {
  product_list: [['external_product_id', 'handle', 'sku']], inventory_list: [['handle', 'sku'], ['location'], ['inventory_quantity']],
  order_list: [['external_order_id'], ['placed_at'], ['currency'], ['total_minor', 'total_major'], ['financial_status']],
  refund_list: [['external_order_id'], ['external_refund_id'], ['created_at'], ['currency'], ['amount_minor', 'amount_major'], ['status']],
};
export function allowedTemplate(provider: string, key: TemplateKey) {
  if (key === 'inventory_list' && provider !== 'shopify') throw new DomainError('template_unavailable', 'Inventory CSV is available for Shopify stores');
  if ((key === 'order_list' || key === 'refund_list') && !['amazon_sp', 'shopee'].includes(provider)) {
    throw new DomainError('template_unavailable', 'Order and refund reports are available for Amazon and Shopee stores');
  }
}
export function template(provider: string, key: TemplateKey) {
  allowedTemplate(provider, key);
  return { provider, template_key: key, phase: ['order_list', 'refund_list'].includes(key) ? 'P1' : 'P0a', columns: templates[key], csv: templates[key].join(',') + '\n' };
}
const headerName = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').replace(/^option([123])_/, 'option_$1_');

/** Parse quoted CSV/TSV, including multiline cells and the BOM in marketplace exports. */
function parse(csv: unknown) {
  if (typeof csv !== 'string' || !csv.trim()) return bad('csv');
  if (csv.length > 5_000_000) throw new DomainError('csv_too_large', 'CSV exceeds 5 million characters', 413);
  const input = csv.replace(/^﻿/, '');
  const separator = /^[^\r\n]*\t/.test(input) ? '\t' : ',';
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [], value = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let line = 1, start = 1;
  const field = () => { cells.push(value); value = ''; state = 'start'; };
  const record = () => {
    field();
    if (cells.length !== 1 || cells[0].trim()) rows.push({ line: start, cells });
    cells = [];
  };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const newline = char === '\r' || char === '\n';
    if (newline && char === '\r' && input[index + 1] === '\n') index++;
    if (state === 'quoted') {
      if (char === '"' && input[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') state = 'closed';
      else value += newline ? '\n' : char;
    } else if (newline) { record(); start = line + 1; }
    else if (char === separator) field();
    else if (char === '"' && state === 'start') state = 'quoted';
    else if (char === '"' || state === 'closed') throw new DomainError('invalid_csv', `Invalid quoting on line ${line}`);
    else { value += char; state = 'plain'; }
    if (newline) line++;
  }
  if (state === 'quoted') throw new DomainError('invalid_csv', `Unclosed quoted field on line ${start}`);
  if (value || cells.length || state === 'closed') record();
  return rows;
}
function positive(value: string, field: string, min = 0) {
  if (!(min < 0 ? /^-?\d+$/ : /^\d+$/).test(value)) return bad(field);
  return integer(Number(value), field, min);
}
function money(row: Fields, code: string, minor: string, major: string) {
  if (row[minor] !== undefined) return positive(row[minor], minor);
  const input = row[major];
  if (input === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(input) || input.length > 30) return bad(minor);
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  const [whole, fraction = ''] = input.split('.');
  if (fraction.slice(digits).replace(/0/g, '')) return bad(minor);
  const amount = Number(`${whole}${fraction.slice(0, digits).padEnd(digits, '0')}`);
  return integer(amount, minor);
}
const token = (value: string) => headerName(value);
const orderMapping: Record<string, string> = { shipped: 'paid', completed: 'paid', delivered: 'paid', unshipped: 'pending', pending_availability: 'pending', to_ship: 'paid', ready_to_ship: 'paid', unpaid: 'pending', to_pay: 'pending', canceled: 'cancelled', invoice_unconfirmed: 'pending', partially_shipped: 'paid' };
const refundMapping: Record<string, string> = { refund_completed: 'succeeded', completed: 'succeeded', refunded: 'succeeded', successful: 'succeeded', success: 'succeeded', processing: 'pending', in_progress: 'pending', approved: 'pending', new: 'requested', rejected: 'failed', cancelled: 'failed', canceled: 'failed' };
const catalogMapping: Record<string, string> = { enabled: 'active', live: 'active', normal: 'active', disabled: 'archived', inactive: 'archived', deleted: 'removed_at_source', closed: 'archived', unpublished: 'draft' };
const booleanCell = (value: string, key: string) => {
  if (/^(true|yes|1)$/i.test(value)) return true;
  if (/^(false|no|0)$/i.test(value)) return false;
  return bad(key);
};
function normalize(row: Fields, key: TemplateKey, provider: string, defaultCurrency: string, zone?: string): { key: string; values: Fields } {
  const values: Fields = {};
  const stringFields = (fields: string[], validator: (val: unknown, key: string) => unknown = str) => {
    for (const field of fields) if (row[field] !== undefined) values[field] = validator(row[field], field);
  };
  if (key === 'order_list' || key === 'refund_list') {
    values.external_order_id = id(row.external_order_id, 'external_order_id');
    values.currency = currency(row.currency);
    if (key === 'order_list') {
      values.placed_at = instant(row.placed_at, 'placed_at', zone);
      for (const k of ['total', 'subtotal', 'discount', 'tax', 'shipping']) {
        const amount = money(row, values.currency, `${k}_minor`, `${k}_major`);
        if (amount !== undefined) values[`${k}_minor`] = amount;
      }
      if (values.total_minor === undefined) bad('total_minor');
      const financial = token(str(row.financial_status, 'financial_status'));
      values.financial_status = one(orderMapping[financial] ?? financial, 'financial_status', financialStatuses);
      if (row.fulfillment_status) values.fulfillment_status = one(token(row.fulfillment_status), 'fulfillment_status', fulfillmentStatuses);
      if (row.cancelled_at) values.cancelled_at = instant(row.cancelled_at, 'cancelled_at', zone);
    } else {
      values.external_refund_id = id(row.external_refund_id, 'external_refund_id');
      values.created_at = instant(row.created_at, 'created_at', zone);
      values.amount_minor = money(row, values.currency, 'amount_minor', 'amount_major') ?? bad('amount_minor');
      const status = token(str(row.status, 'status'));
      values.status = one(refundMapping[status] ?? status, 'status', refundStatuses);
    }
    if (row.source_updated_at) values.source_updated_at = instant(row.source_updated_at, 'source_updated_at', zone);
    return { key: JSON.stringify([values.external_order_id, values.external_refund_id]), values };
  }
  if (key === 'inventory_list') {
    stringFields(['handle', 'sku', 'option_1_value', 'option_2_value', 'option_3_value']);
    if (row.location === undefined) bad('location');
    values.location = str(row.location, 'location');
    values.inventory_quantity = positive(row.inventory_quantity ?? '', 'inventory_quantity', -1_000_000_000);
    if (!values.handle && !values.sku) bad('handle or sku');
    return { key: JSON.stringify([values.handle || null, values.sku || null, values.option_1_value || null, values.option_2_value || null, values.option_3_value || null, values.location]), values };
  }
  stringFields(['external_product_id', 'external_variant_id', 'market_id'], id);
  stringFields(['handle', 'sku', 'barcode', 'product_type', 'vendor']);
  if (row.title) values.title = str(row.title, 'title', 1000);
  if (!values.external_product_id && !values.handle && !values.sku) bad('external_product_id, handle or sku');
  const pairs = [];
  for (const n of [1, 2, 3]) {
    const name = row[`option_${n}_name`], val = row[`option_${n}_value`];
    if (val) pairs.push([str(name ?? `Option ${n}`, 'option_name', 50), str(val, 'option_value', 150)]);
    else if (name) bad('option_value');
  }
  if (pairs.length) {
    values.options = Object.fromEntries(pairs);
    if (Object.keys(values.options).length !== pairs.length) bad('option_name');
    values.option_values = pairs.map(([, value]) => value);
  }
  for (const field of ['status', 'variant_status']) if (row[field]) {
    const status = token(row[field]);
    values[field] = one(catalogMapping[status] ?? status, field, field === 'status' ? ['active', 'draft', 'archived', 'removed_at_source'] : ['active', 'archived', 'removed_at_source']);
  }
  if (row.market_id && !row.channel) throw new DomainError('invalid_input', 'Channel required with market_id');
  if (row.channel) values.channel = one(token(row.channel), 'channel', channels);
  if (row.purchase_url) values.purchase_url = purchaseUrl(provider, row.purchase_url);
  if (row.source_updated_at) values.source_updated_at = instant(row.source_updated_at, 'source_updated_at', zone);
  if (row.inventory_quantity !== undefined) values.inventory_quantity = positive(row.inventory_quantity, 'inventory_quantity', -1_000_000_000);
  if (row.available_for_sale !== undefined) values.available_for_sale = booleanCell(row.available_for_sale, 'available_for_sale');
  const code = row.currency ? currency(row.currency) : defaultCurrency;
  const price = money(row, code, 'price_amount_minor', 'price_major');
  const compare = money(row, code, 'compare_at_amount_minor', 'compare_major');
  const international = money(row, code, 'international_minor', 'market_price_major');
  if (price !== undefined) values.price_amount_minor = price;
  if (compare !== undefined) values.compare_at_amount_minor = compare;
  if (international !== undefined) values.international_minor = international;
  if (row.currency || price !== undefined || compare !== undefined || international !== undefined) values.currency = code;
  const product = values.external_product_id || values.handle || values.sku;
  const variant = values.external_variant_id || values.sku || JSON.stringify(values.option_values || []);
  return { key: JSON.stringify([product, variant, values.market_id ?? '', values.channel ?? '']), values };
}
export function normalizeSettlementRow(input: Fields, key: 'order_list' | 'refund_list', provider: string, defaultCurrency: string, line: number): ImportRow {
  const allowed = Object.fromEntries(templates[key].flatMap(field => {
    if (!Object.hasOwn(input, field) || input[field] == null) return [];
    const value = field.endsWith('_minor') ? String(integer(input[field], field)) : str(input[field], field);
    return [[field, value]];
  }));
  return { line, ...normalize(allowed, key, provider, defaultCurrency) };
}

const maxRows = 5000;

export function readImport(csv: unknown, key: TemplateKey, provider: string, defaultCurrency: string, rawZone?: unknown) {
  return normalizeTable(parse(csv), key, provider, defaultCurrency, rawZone, 'CSV');
}

export async function readXlsxImport(input: unknown, key: TemplateKey, provider: string, defaultCurrency: string, rawZone?: unknown) {
  try {
    return normalizeTable(await readXlsx(input, maxRows), key, provider, defaultCurrency, rawZone, 'XLSX');
  } catch (error) {
    if (error instanceof XlsxError) throw new DomainError(error.code, error.message, error.status);
    throw error;
  }
}

function normalizeTable(table: { line: number; cells: string[] }[], key: TemplateKey, provider: string, defaultCurrency: string, rawZone: unknown, format: 'CSV' | 'XLSX') {
  const zone = rawZone === undefined ? undefined : timezone(rawZone);
  const [first, ...rows] = table;
  const header = first?.cells;
  if (!header?.length || header.length > 300 || header.some(name => !name.trim())) throw new DomainError('invalid_header', `${format} header must have 1–300 named columns`);
  const names = header.map(headerName);
  if (new Set(names).size !== names.length) throw new DomainError('invalid_header', `${format} column names must be unique`);
  if (rows.length > maxRows) throw new DomainError('invalid_row_count', `${format} may contain at most ${maxRows} data rows`);
  if (!rows.length && (key === 'product_list' || key === 'inventory_list')) throw new DomainError('invalid_row_count', `${format} must contain data rows`);
  const columns = [...templates[key], ...(extra[key] ?? [])];
  const projection = columns.map(column => {
    const aliases = [column, ...(providerAliases[provider]?.[column] ?? []), ...(commonAliases[column] ?? [])];
    return [column, [...new Set(aliases)].map(alias => names.indexOf(alias)).filter(index => index >= 0)] as const;
  });
  for (const alternatives of required[key]) {
    if (!projection.some(([column, indices]) => alternatives.includes(column) && indices.length)) {
      throw new DomainError('invalid_header', `Missing column: ${alternatives.join(' or ')}`);
    }
  }
  const clean: ImportRow[] = [], issues: Issue[] = [];
  for (const row of rows) {
    if (row.cells.length !== names.length) {
      issues.push({ line: row.line, code: 'column_count', message: 'Row width differs from header', severity: 'error' });
      continue;
    }
    // Project before validation or persistence. Errors contain only fixed field names and line numbers.
    const projected = Object.fromEntries(projection.flatMap(([column, indices]) => {
      const val = indices.map(index => row.cells[index].trim()).find(Boolean);
      return val === undefined ? [] : [[column, val]];
    }));
    try { clean.push({ line: row.line, ...normalize(projected, key, provider, defaultCurrency, zone) }); }
    catch (error) {
      if (!(error instanceof DomainError)) throw error;
      issues.push({ line: row.line, code: error.code, message: error.message, severity: 'error' });
    }
  }
  return { rows: clean, issues, row_count: rows.length };
}
