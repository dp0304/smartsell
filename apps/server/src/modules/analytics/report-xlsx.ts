import { ZipFile } from 'yazl';

const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;

function cell(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return `<c><v>${value}</v></c>`;
  const text = String(value ?? '').toWellFormed()
    .replace(/_x[0-9a-f]{4}_/gi, match => `_x005F_${match.slice(1)}`)
    .replace(/[\x00-\x08\x0B\x0C\x0D-\x1F￾￿]/g, char => `_x${char.charCodeAt(0).toString(16).padStart(4, '0')}_`)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<c t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

export async function renderReportXlsx(rows: unknown[][]) {
  const zip = new ZipFile();
  const entries = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${packageRel}"><Relationship Id="rId1" Type="${officeRel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${sheetNs}" xmlns:r="${officeRel}"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${packageRel}"><Relationship Id="rId1" Type="${officeRel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${sheetNs}"><sheetData>${rows.map(row => `<row>${row.map(cell).join('')}</row>`).join('')}</sheetData></worksheet>`,
  };
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(xml(content)), name, { mtime: new Date(2026, 0, 1), forceDosTimestamp: true });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
