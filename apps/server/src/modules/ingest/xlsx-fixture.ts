import { ZipFile } from 'yazl';

const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export async function workbookFixture(sheetData: string, {
  date1904 = false, extra = {}, workbookPrefix = '', sheetTarget = 'worksheets/report.xml',
}: { date1904?: boolean; extra?: Record<string, string>; workbookPrefix?: string; sheetTarget?: string } = {}) {
  const entries = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/report.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${workbookPrefix}<workbook xmlns="${main}" xmlns:r="${rel}"><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets><sheet name="Report" sheetId="6" r:id="rId7"/><sheet name="Other" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Type="${rel}/worksheet" Target="${sheetTarget}"/><Relationship Id="rId2" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<sst xmlns="${main}"><si><t>SKU code</t></si><si><r><t>Mo</t></r><r><t>re</t></r><rPh sb="0" eb="1"><t>Ignored pronunciation</t></rPh></si></sst>`,
    'xl/styles.xml': `<styleSheet xmlns="${main}"><numFmts count="1"><numFmt numFmtId="164" formatCode="00000"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    'xl/worksheets/report.xml': `<worksheet xmlns="${main}"><sheetData>${sheetData}</sheetData></worksheet>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${main}"><sheetData><row r="1"><c r="A1"><f>1+1</f></c></row></sheetData></worksheet>`,
    ...extra,
  };
  const zip = new ZipFile();
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name, { mtime: new Date('2026-01-01') });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('base64');
}

export function textCell(address: string, text: string) {
  return `<c r="${address}" t="inlineStr"><is><t>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</t></is></c>`;
}
