import { posix } from 'node:path';
import { crc32 } from 'node:zlib';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl';

const maxFileBytes = 700_000; // Fits the normal 1 MiB JSON body limit after base64 encoding.
const maxXmlBytes = 16_000_000;
const maxText = 5_000_000;
const maxColumns = 300;
const spreadsheet = ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'];
const officeRel = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
const packageRel = ['http://schemas.openxmlformats.org/package/2006/relationships', 'http://purl.oclc.org/ooxml/package/relationships'];
const packageTypes = ['http://schemas.openxmlformats.org/package/2006/content-types', 'http://purl.oclc.org/ooxml/package/content-types'];
const workbookTypes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.sheet.main+xml'];
const dayMs = 86_400_000;

export class XlsxError extends Error {
  constructor(readonly code: 'invalid_xlsx' | 'xlsx_too_large' | 'invalid_row_count', message: string, readonly status = 422) { super(message); }
}
const invalid = (): never => { throw new XlsxError('invalid_xlsx', 'Invalid or unsupported XLSX workbook'); };
const tooLarge = (): never => { throw new XlsxError('xlsx_too_large', 'XLSX workbook exceeds import limits', 413); };

type Row = { line: number; cells: string[] };
const attr = (tag: SaxesTagNS, name: string) => Object.hasOwn(tag.attributes, name) ? tag.attributes[name].value : undefined;
const belongs = (tag: SaxesTagNS, namespaces: string[], local: string) => namespaces.includes(tag.uri) && tag.local === local;

function xml(input: Buffer, roots: string[], root: string, handlers: {
  open?: (tag: SaxesTagNS, parent: SaxesTagNS | undefined) => void;
  close?: (tag: SaxesTagNS, parent: SaxesTagNS | undefined) => void;
  text?: (value: string, tag: SaxesTagNS | undefined) => void;
}) {
  const parser = new SaxesParser({ xmlns: true });
  const stack: SaxesTagNS[] = [];
  let namespace: string;
  parser.on('error', invalid);
  parser.on('doctype', invalid);
  parser.on('opentag', tag => {
    if (stack.length >= 64) tooLarge();
    if (!stack.length) {
      if (!belongs(tag, roots, root)) invalid();
      namespace = tag.uri;
    }
    if (tag.uri === namespace && (!stack.length || stack.at(-1)?.uri === namespace)) handlers.open?.(tag, stack.at(-1));
    stack.push(tag);
  });
  parser.on('closetag', tag => {
    stack.pop();
    if (tag.uri === namespace && (!stack.length || stack.at(-1)?.uri === namespace)) handlers.close?.(tag, stack.at(-1));
  });
  const text = (value: string) => { if (stack.at(-1)?.uri === namespace) handlers.text?.(value, stack.at(-1)); };
  parser.on('text', text);
  parser.on('cdata', text);
  // Reject other encodings and malformed bytes. Excel's OOXML parts normally use UTF-8.
  parser.on('xmldecl', declaration => { if (declaration.encoding && !/^utf-8$/i.test(declaration.encoding)) invalid(); });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(input)).close();
}

async function indexArchive(zip: ZipFile) {
  if (zip.entryCount > 256) tooLarge();
  const entries = new Map<string, Entry>();
  let total = 0;
  for await (const entry of zip.eachEntry()) {
    const name = entry.fileName;
    if (entries.has(name) || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)
        || /[\u0000-\u001f\\]/.test(name) || name.split('/').some(part => part === '.' || part === '..')
        || /(?:^|\/)(?:vbaProject\.bin|externalLinks\/|activeX\/|embeddings\/)/i.test(name)) invalid();
    total += entry.uncompressedSize;
    if (entry.uncompressedSize > maxXmlBytes || total > 32_000_000) tooLarge();
    entries.set(name, entry);
  }
  return async (name: string) => {
    const entry = entries.get(name) ?? invalid();
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > entry.uncompressedSize || size > maxXmlBytes) tooLarge();
      chunks.push(chunk);
    }
    const result = Buffer.concat(chunks, size);
    if (size !== entry.uncompressedSize || crc32(result) !== entry.crc32) invalid();
    return result;
  };
}

function relations(input: Buffer) {
  const values = new Map<string, { kind: string; target: string }>();
  xml(input, packageRel, 'Relationships', { open(tag, parent) {
    if (tag.local !== 'Relationship' || parent?.local !== 'Relationships') return;
    const id = attr(tag, 'Id') ?? invalid();
    if (values.has(id)) invalid();
    const type = attr(tag, 'Type') ?? invalid();
    const prefix = officeRel.find(ns => type.startsWith(`${ns}/`));
    if (!prefix) return;
    const kind = type.slice(prefix.length + 1);
    if (!['officeDocument', 'worksheet', 'sharedStrings', 'styles'].includes(kind)) return;
    if ((attr(tag, 'TargetMode') ?? 'Internal') !== 'Internal') invalid();
    values.set(id, { kind, target: attr(tag, 'Target') ?? invalid() });
  } });
  return values;
}

function partName(parent: string, target: string) {
  const decoded = decodeURIComponent(target);
  if (!decoded || /[:?#\\\u0000-\u001f]/.test(decoded) || decoded.startsWith('//')) invalid();
  const path = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(parent), decoded));
  if (path === '.' || path.startsWith('../') || path === '..' || !path.endsWith('.xml')) invalid();
  return path;
}

function checkContentTypes(input: Buffer, workbookPath: string) {
  let found = false;
  xml(input, packageTypes, 'Types', { open(tag, parent) {
    if (parent?.local !== 'Types' || !['Override', 'Default'].includes(tag.local)) return;
    const type = attr(tag, 'ContentType') ?? invalid();
    if (/macroenabled|vbaproject|activex/i.test(type)) invalid();
    if (tag.local !== 'Override' || attr(tag, 'PartName') !== `/${workbookPath}`) return;
    if (found || !workbookTypes.includes(type)) invalid();
    found = true;
  } });
  if (!found) invalid();
}

function workbook(input: Buffer) {
  let firstSheet: string | undefined, date1904 = false;
  xml(input, spreadsheet, 'workbook', { open(tag, parent) {
    if (parent?.local === 'workbook' && tag.local === 'workbookPr') date1904 = ['true', '1'].includes(attr(tag, 'date1904') ?? '');
    if (parent?.local === 'workbook' && tag.local === 'externalReferences') invalid();
    if (parent?.local === 'sheets' && tag.local === 'sheet' && firstSheet === undefined) {
      firstSheet = Object.values(tag.attributes).find(a => a.local === 'id' && officeRel.includes(a.uri))?.value ?? invalid();
    }
  } });
  return { firstSheet: firstSheet ?? invalid(), date1904 };
}

function sharedStrings(input: Buffer) {
  const values: string[] = [];
  let value = '', capturing = false;
  xml(input, spreadsheet, 'sst', {
    open(tag, parent) {
      if (tag.local === 'si' && parent?.local === 'sst') value = '';
      if (tag.local === 't' && (parent?.local === 'si' || parent?.local === 'r')) capturing = true;
    },
    text(text, tag) { if (capturing && tag?.local === 't') value += text; },
    close(tag, parent) {
      if (tag.local === 't') capturing = false;
      if (tag.local === 'si' && parent?.local === 'sst') {
        if (values.length >= 250_000) tooLarge();
        values.push(value);
      }
    },
  });
  return values;
}

type NumberStyle = { date?: boolean; time?: boolean; pad?: number };
function styles(input: Buffer): NumberStyle[] {
  const custom = new Map<number, string>();
  const formats: number[] = [];
  xml(input, spreadsheet, 'styleSheet', { open(tag, parent) {
    if (tag.local === 'numFmt' && parent?.local === 'numFmts') custom.set(Number(attr(tag, 'numFmtId')), attr(tag, 'formatCode') ?? '');
    if (tag.local === 'xf' && parent?.local === 'cellXfs') formats.push(Number(attr(tag, 'numFmtId') ?? 0));
  } });
  return formats.map(id => {
    if ([14, 15, 16, 17, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58].includes(id)) return { date: true };
    if (id === 22) return { date: true, time: true };
    const code = custom.get(id)?.split(';', 1)[0].replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, '').toLowerCase() ?? '';
    if (/[yd]/.test(code) || (/m/.test(code) && !/[hs]/.test(code))) return { date: true, time: /[hs]/.test(code) };
    return /^0{2,30}$/.test(code) ? { pad: code.length } : {};
  });
}

function decimal(value: string) {
  const parsed = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value) ?? invalid();
  const [, sign, whole, fraction = '', exponent = '0'] = parsed;
  const offset = Number(exponent);
  if (Math.abs(offset) > 308 || value.length > 350 || !Number.isFinite(Number(value))) invalid();
  const digits = whole + fraction;
  const point = whole.length + offset;
  const split = Math.max(0, point);
  const integer = digits.slice(0, split).padEnd(split, '0').replace(/^0+(?=\d)/, '') || '0';
  const fractional = ('0'.repeat(Math.max(0, -point)) + digits.slice(split)).replace(/0+$/, '');
  return `${sign === '-' && (integer !== '0' || fractional) ? '-' : ''}${integer}${fractional ? `.${fractional}` : ''}`;
}

function excelDate(value: string, date1904: boolean, time: boolean) {
  const serial = Number(value);
  const days = Math.floor(serial);
  if (serial < 0 || serial >= 2_958_466 || (!date1904 && days === 60)) invalid();
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days < 60 ? 31 : 30);
  const date = new Date(epoch + Math.round(serial * dayMs)).toISOString();
  if (!/^\d{4}-/.test(date)) invalid();
  return time || serial !== days ? date.slice(0, -1).replace(/\.000$/, '') : date.slice(0, 10);
}

function cellValue(type: string, raw: string, inline: string, strings: string[], style: NumberStyle, date1904: boolean) {
  if (type === 'inlineStr') return inline;
  if (raw === '') return '';
  if (type === 's') return strings[/^\d+$/.test(raw) ? Number(raw) : -1] ?? invalid();
  if (type === 'b') return raw === '1' ? 'true' : raw === '0' ? 'false' : invalid();
  if (type === 'str' || type === 'd') return raw;
  if (type !== 'n') return invalid();
  const value = decimal(raw);
  if (style.date) return excelDate(value, date1904, !!style.time);
  return style.pad && /^\d+$/.test(value) ? value.padStart(style.pad, '0') : value;
}

function sheet(input: Buffer, strings: string[], formats: NumberStyle[], date1904: boolean, maxRows: number) {
  const rows: Row[] = [];
  let line = 0, lastColumn = -1, textSize = 0;
  let cells: string[] | undefined;
  let cell: { column: number; type: string; style: NumberStyle; raw: string; inline: string } | undefined;
  let reading: 'raw' | 'inline' | undefined;
  xml(input, spreadsheet, 'worksheet', {
    open(tag, parent) {
      if (tag.local === 'row' && parent?.local === 'sheetData') {
        const index = attr(tag, 'r');
        const next = index === undefined ? line + 1 : /^\d{1,7}$/.test(index) ? Number(index) : invalid();
        if (next <= line || next > 1_048_576 || cells) invalid();
        line = next;
        lastColumn = -1;
        cells = [];
      } else if (tag.local === 'c' && parent?.local === 'row' && cells) {
        const address = attr(tag, 'r');
        let column = lastColumn + 1;
        if (address !== undefined) {
          const [, letters, row] = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address) ?? invalid();
          if (Number(row) !== line) invalid();
          column = [...letters].reduce((index, char) => index * 26 + char.charCodeAt(0) - 64, 0) - 1;
        }
        if (column <= lastColumn || column >= 16_384 || cell) invalid();
        lastColumn = column;
        const style = attr(tag, 's');
        cell = { column, type: attr(tag, 't') ?? 'n', style: style === undefined || style === '0' ? formats[0] ?? {} : formats[/^\d+$/.test(style) ? Number(style) : -1] ?? invalid(), raw: '', inline: '' };
      } else if (cell && tag.local === 'f') {
        throw new XlsxError('invalid_xlsx', `Formulas are unsupported in XLSX imports (row ${line})`);
      } else if (cell && tag.local === 'v' && parent?.local === 'c') reading = 'raw';
      else if (cell && tag.local === 't' && (parent?.local === 'is' || parent?.local === 'r')) reading = 'inline';
    },
    text(value, tag) {
      if (cell && reading && (tag?.local === 'v' || tag?.local === 't')) cell[reading] += value;
    },
    close(tag, parent) {
      if (tag.local === 'v' || tag.local === 't') reading = undefined;
      if (tag.local === 'c' && parent?.local === 'row' && cells && cell) {
        const value = cellValue(cell.type, cell.raw, cell.inline, strings, cell.style, date1904);
        if (value !== '') {
          textSize += value.length;
          if (textSize > maxText || cell.column >= maxColumns) tooLarge();
          cells[cell.column] = value;
        }
        cell = undefined;
      }
      if (tag.local === 'row' && parent?.local === 'sheetData' && cells) {
        if (cells.length) {
          if (rows.length >= maxRows + 1) throw new XlsxError('invalid_row_count', `Provide at most ${maxRows} data rows`);
          rows.push({ line, cells: Array.from(cells, value => value ?? '') });
        }
        cells = undefined;
      }
    },
  });
  const width = rows[0]?.cells.length ?? 0;
  for (const { cells } of rows) while (cells.length < width) cells.push('');
  return rows;
}

/** Extract the first worksheet as a table. No formulas, embedded files, or remote parts are loaded. */
export async function readXlsx(input: unknown, maxRows: number) {
  if (typeof input !== 'string' || !input.length) return invalid();
  if (input.length > Math.ceil(maxFileBytes / 3) * 4) tooLarge();
  const bytes = Buffer.from(input, 'base64');
  if (bytes.length > maxFileBytes) tooLarge();
  if (bytes.toString('base64') !== input || bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) invalid();
  let zip: ZipFile | undefined;
  try {
    zip = await fromBufferPromise(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true });
    const read = await indexArchive(zip);
    const office = [...relations(await read('_rels/.rels')).values()].find(rel => rel.kind === 'officeDocument') ?? invalid();
    const bookPath = partName('', office.target);
    checkContentTypes(await read('[Content_Types].xml'), bookPath);
    const { firstSheet, date1904 } = workbook(await read(bookPath));
    const linked = relations(await read(posix.join(posix.dirname(bookPath), '_rels', `${posix.basename(bookPath)}.rels`)));
    const worksheet = linked.get(firstSheet);
    if (!worksheet || worksheet.kind !== 'worksheet') return invalid();
    const optional = async <T>(kind: string, parse: (buffer: Buffer) => T) => {
      const link = [...linked.values()].find(rel => rel.kind === kind);
      return link ? parse(await read(partName(bookPath, link.target))) : [];
    };
    const strings = await optional('sharedStrings', sharedStrings);
    const formats = await optional('styles', styles);
    return sheet(await read(partName(bookPath, worksheet.target)), strings, formats, date1904, maxRows);
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    return invalid();
  } finally {
    zip?.close();
  }
}
