import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { readXlsx } from '../../server/src/modules/ingest/xlsx.ts';

export const catalogExtensions = ['csv', 'tsv', 'xlsx'];
export const catalogFileLimit = 384 * 1024;

const identifyingColumns = new Set(`external_product_id handle sku url_handle product_id item_id seller_sku variant_sku sku_reference_no
  sku_reference_number asin1 asin variation_sku seller_sku_id`.split(/\s+/));
const productColumns = new Set([...identifyingColumns, ...`external_variant_id title barcode product_type vendor status variant_status
  option_1_name option_1_value option_2_name option_2_value option_3_name option_3_value price_amount_minor compare_at_amount_minor
  currency inventory_quantity available_for_sale market_id channel purchase_url source_updated_at product_name item_name listing_title
  variant_barcode gtin ean upc variant_id variation_id model_id sku_id price retail_price variant_price selling_price current_price
  variant_compare_at_price compare_major original_price price_international market_price_major price_major type variant_inventory_qty quantity available
  available_not_editable on_hand_current stock stock_quantity in_stock product_status listing_status currency_code last_updated_date
  last_update_date updated_at listing_id item_product_name variation_sku_id current_stock product_name_en sku_stock available_stock`.split(/\s+/)]);
const sensitiveColumn = /(?:^|_)(?:order|buyer|customer|password|credential|token|secret|email|phone|refund|payment|shipping_address|billing_address|api_key)(?:_|$)|订单|买家|客户|密码|凭据|令牌|邮箱|电话|退款|支付|收货/;
const invalidExport = () => new Error('请选择含商品 ID、商品标识或 SKU 的商品导出表。');

function textRows(text: string, separator: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', mode: 'start' | 'text' | 'quoted' | 'end' = 'start';
  const field = () => { row.push(cell); cell = ''; mode = 'start'; };
  const finish = () => {
    field();
    if (row.some(value => value.trim())) rows.push(row);
    if (row.length > 300 || rows.length > 5001) throw invalidExport();
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (mode === 'quoted') {
      if (character !== '"') cell += character;
      else if (text[index + 1] === '"') { cell += '"'; index++; }
      else mode = 'end';
    } else if (character === separator) field();
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index++;
      finish();
    } else if (character === '"' && mode === 'start') mode = 'quoted';
    else {
      if (character === '"' || mode === 'end') throw invalidExport();
      cell += character;
      mode = 'text';
    }
  }
  if (mode === 'quoted') throw invalidExport();
  if (row.length || cell || mode === 'end') finish();
  return rows;
}

async function productCsv(bytes: Buffer, extension: string) {
  let rows: string[][];
  try {
    if (extension === 'xlsx') rows = (await readXlsx(bytes.toString('base64'), 5001)).map(row => row.cells);
    else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      rows = textRows(text, extension === 'tsv' || /^[^\r\n]*\t/.test(text) ? '\t' : ',');
    }
  } catch { throw new Error('无法读取导出表。请选用 UTF-8 CSV、TSV 或有效的 XLSX 商品表。'); }
  const [headers, ...data] = rows;
  if (!headers?.length || !data.length || data.length > 5000) throw invalidExport();
  if (headers.some(value => sensitiveColumn.test(value.toLowerCase().replace(/[\s-]+/g, '_')))) {
    throw new Error('商品导出不能包含订单、客户资料或账号凭据列。');
  }
  const names = headers.map(value => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').replace(/^option([123])_/, 'option_$1_'));
  if (!names.some(name => identifyingColumns.has(name)) || data.some(row => row.length > names.length)) throw invalidExport();
  const columns = names.flatMap((name, index) => productColumns.has(name) ? [index] : []);
  if (new Set(columns.map(index => names[index])).size !== columns.length) throw invalidExport();
  const encode = (value: string) => /[",\r\n\t]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [names, ...data].map(row => columns.map(index => encode(row[index] ?? '')).join(',')).join('\n');
}

export async function readCatalogFile(path: string, signal: AbortSignal) {
  const extension = extname(path).slice(1).toLowerCase();
  if (!catalogExtensions.includes(extension)) throw invalidExport();
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > catalogFileLimit) throw new Error('请选择不超过 384 KiB 的商品导出表，较大的导出请分批处理。');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('商品导出表在读取时已变化，请重新选择。');
    const csv = await productCsv(bytes.subarray(0, offset), extension);
    if (Buffer.byteLength(csv) > catalogFileLimit) throw new Error('提取后的商品数据超过 384 KiB，请分批导出。');
    signal.throwIfAborted();
    return { name: basename(path), size: before.size, csv };
  } finally { await file.close(); }
}
