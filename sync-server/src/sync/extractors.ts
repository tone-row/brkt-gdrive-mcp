import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
// @ts-ignore - word-extractor has no type declarations
import WordExtractor from "word-extractor";
import * as XLSX from "xlsx";

const wordExtractor = new WordExtractor();

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

export async function extractTextFromDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export async function extractTextFromDoc(buffer: Buffer): Promise<string> {
  const doc = await wordExtractor.extract(buffer);
  return doc.getBody();
}

/** Excel-style column label: 0→A, 25→Z, 26→AA, 27→AB, etc. */
function columnLabel(index: number): string {
  let result = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    result = String.fromCharCode(65 + r) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

export function extractTextFromSpreadsheet(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sections: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (rows.length === 0) continue;

    const headers = rows[0].map((h: any, i: number) =>
      h != null && String(h).trim() !== "" ? String(h).trim() : columnLabel(i)
    );

    const dataRows = rows.slice(1);
    if (dataRows.length === 0) continue;

    const rowTexts: string[] = [];
    for (const row of dataRows) {
      const pairs: string[] = [];
      for (let i = 0; i < headers.length; i++) {
        const val = row[i];
        if (val != null && String(val).trim() !== "") {
          pairs.push(`${headers[i]}: ${String(val).trim()}`);
        }
      }
      if (pairs.length > 0) {
        rowTexts.push(pairs.join(" | "));
      }
    }

    if (rowTexts.length > 0) {
      sections.push(`--- Sheet: ${sheetName} ---\n\n${rowTexts.join("\n\n")}`);
    }
  }

  return sections.join("\n\n");
}
