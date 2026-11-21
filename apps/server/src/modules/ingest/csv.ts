import { Problem } from '@smartsell/contracts';

export const maxImportRows = 25_000;

export function parseCsv(text: string) {
  if (text.length > 5_000_000) throw new Problem(413, 'IMPORT_TOO_LARGE', 'File exceeds 5 million characters');
  const input = text.replace(/^﻿/, '');
  const delimiter = /^[^\r\n]*\t/.test(input) && !/^[^\r\n]*,/.test(input) ? '\t' : ',';
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [], cell = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let line = 1, startLine = 1;
  const finishCell = () => { cells.push(cell); cell = ''; state = 'start'; };
  const finishRecord = () => {
    finishCell();
    if (cells.length > 1 || cells[0] !== '') records.push({ line: startLine, cells });
    cells = [];
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const newline = char === '\n' || char === '\r';
    if (newline && char === '\r' && input[i + 1] === '\n') i++;
    if (state === 'quoted') {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') state = 'closed';
      else cell += newline ? '\n' : char;
    } else if (newline) {
      finishRecord();
      startLine = line + 1;
    } else if (char === delimiter) finishCell();
    else if (char === '"' && state === 'start') state = 'quoted';
    else if (char === '"' || state === 'closed') throw new Problem(422, 'INVALID_CSV', `Invalid quoting on line ${line}`);
    else { cell += char; state = 'plain'; }
    if (newline) line++;
  }
  if (state === 'quoted') throw new Problem(422, 'INVALID_CSV', `Unclosed quoted field on line ${startLine}`);
  if (cell !== '' || cells.length || state === 'closed') finishRecord();
  return importTable(records);
}

export function importTable(rows: { line: number; cells: string[] }[]) {
  const [first, ...records] = rows;
  const header = first?.cells.map(value => value.trim());
  if (!header?.length || header.some(value => !value) || new Set(header.map(value => value.toLowerCase())).size !== header.length || header.length > 300) {
    throw new Problem(422, 'INVALID_HEADER', 'Header names must be nonempty and unique, with at most 300 columns');
  }
  if (!records.length || records.length > maxImportRows) throw new Problem(422, 'INVALID_ROW_COUNT', 'Provide 1 to 25,000 rows');
  return { header, records };
}

export function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
}
