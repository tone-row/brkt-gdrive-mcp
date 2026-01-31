import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
// @ts-ignore - word-extractor has no type declarations
import WordExtractor from "word-extractor";

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
