import assert from 'node:assert/strict';
import test from 'node:test';
import { readXlsx } from './xlsx';
import { textCell, workbookFixture } from './xlsx-fixture';

const header = `<row r="2"><c r="A2" t="s"><v>0</v></c>${textCell('B2', 'Date')}${textCell('C2', 'Money')}${textCell('D2', 'Enabled')}${textCell('E2', 'Name')}</row>`;

test('XLSX reads the first related worksheet, preserving sparse rows and scalar types', async () => {
  const input = await workbookFixture(header + '<row r="3"/><row r="5"><c r="A5" s="3"><v>21</v></c><c r="B5" s="1"><v>61</v></c><c r="C5"><v>2.5900E+1</v></c><c r="D5" t="b"><v>1</v></c><c r="E5" t="s"><v>1</v></c></row>'
    + `<row r="8">${textCell('A8', '00002')}<c r="B8" s="2"><v>61.5</v></c><c r="C8"><v>1e-4</v></c><c r="E8" t="inlineStr"><is><r><t>Tea &amp; </t></r><r><t>Honey</t></r></is></c></row>`);
  assert.deepEqual(await readXlsx(input, 2), [
    { line: 2, cells: ['SKU code', 'Date', 'Money', 'Enabled', 'Name'] },
    { line: 5, cells: ['00021', '1900-03-01', '25.9', 'true', 'More'] },
    { line: 8, cells: ['00002', '1900-03-01T12:00:00', '0.0001', '', 'Tea & Honey'] },
  ]);
  await assert.rejects(readXlsx(input, 1), { code: 'invalid_row_count' });
  const mac = await workbookFixture(header + '<row r="3"><c r="A3" s="1"><v>0</v></c></row>', { date1904: true });
  assert.equal((await readXlsx(mac, 1))[1].cells[0], '1904-01-01');
});

test('XLSX rejects malformed or unsafe inputs and enforces resource limits', async () => {
  await assert.rejects(readXlsx('aGVsbG8=', 10), { code: 'invalid_xlsx' });
  await assert.rejects(readXlsx('A'.repeat(1_000_000), 10), { code: 'xlsx_too_large', status: 413 });
  const invalidFiles = await Promise.all([
    workbookFixture('<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>'),
    workbookFixture(header, { workbookPrefix: '<!DOCTYPE workbook>' }),
    workbookFixture(header, { sheetTarget: 'https://invalid.test/report.xml' }),
    workbookFixture(header, { extra: { 'xl/vbaProject.bin': 'macro' } }),
    workbookFixture(header, { extra: { 'xl/styles.xml': '<bad>' } }),
  ]);
  for (const input of invalidFiles) await assert.rejects(readXlsx(input, 10), { code: 'invalid_xlsx' });
  const oversizedPart = await workbookFixture(header, { extra: { 'xl/sharedStrings.xml': 'x'.repeat(16_000_001) } });
  await assert.rejects(readXlsx(oversizedPart, 10), { code: 'xlsx_too_large', status: 413 });
  const oversizedGrid = await workbookFixture(header + `<row r="3">${textCell('KO3', 'beyond column 300')}</row>`);
  await assert.rejects(readXlsx(oversizedGrid, 10), { code: 'xlsx_too_large', status: 413 });
});
