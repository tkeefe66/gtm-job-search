import { inflateRawSync } from "node:zlib";

// Extract text only. Uploaded files are never stored or rendered as HTML.
export async function extractResumeText(name: string, data: Buffer): Promise<{ text: string }> {
  if (data.length > 1024 * 1024) throw new Error("Choose a résumé smaller than 1 MB, or paste its text.");
  const extension = name.split(".").pop()?.toLowerCase();
  let text: string;
  if (extension === "txt") {
    text = data.toString("utf8");
  } else if (extension === "pdf") {
    if (!data.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("This file is not a readable PDF. Export it again or paste its text.");
    const { getDocumentProxy, extractText } = await import("unpdf");
    const document = await getDocumentProxy(new Uint8Array(data), { isEvalSupported: false });
    try {
      if (document.numPages > 10) throw new Error("Choose a résumé with 10 pages or fewer, or paste the relevant text.");
      text = (await extractText(document, { mergePages: true })).text;
    } finally { await document.destroy(); }
  } else if (extension === "docx") {
    validateDocxArchive(data);
    const mammoth = await import("mammoth");
    text = (await mammoth.extractRawText({ buffer: data })).value;
  } else {
    throw new Error("Choose a PDF, DOCX, or TXT résumé, or paste its text.");
  }
  text = text.replace(/\u0000/g, "").trim();
  if (!text || !/[a-zA-Z0-9]/.test(text)) throw new Error("No readable text was found. For scanned files, copy the text with OCR and paste it here.");
  if (text.length > 40000) throw new Error("This résumé contains too much text. Paste the relevant sections instead (up to 40,000 characters).");
  return { text };
}


/** Validate the directory Mammoth will read and bound ACTUAL expansion, not
 * attacker-supplied uncompressed sizes. Reject ZIP64 and multi-disk archives. */
function validateDocxArchive(data: Buffer): void {
  const invalid = () => new Error("This file is not a readable DOCX. Export it again or paste its text.");
  const tooLarge = () => new Error("This Word document is too large to unpack. Export a simpler PDF or paste its text.");
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  }
  if (end < 0 || data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0) throw invalid();
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const directoryEnd = offset + data.readUInt32LE(end + 12);
  if (!count || count > 1000 || count !== data.readUInt16LE(end + 8) || directoryEnd !== end) throw invalid();
  let remaining = 10 * 1024 * 1024;
  for (let entry = 0; entry < count; entry++) {
    if (offset + 46 > directoryEnd || data.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const declared = data.readUInt32LE(offset + 24);
    const local = data.readUInt32LE(offset + 42);
    if (data.readUInt16LE(offset + 8) & 1 || ![0, 8].includes(method) || local + 30 > offset || data.readUInt32LE(local) !== 0x04034b50) throw invalid();
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    if (start + compressed > offset || declared === 0xffffffff) throw invalid();
    if (declared > remaining) throw tooLarge();
    const bytes = data.subarray(start, start + compressed);
    let actual: number;
    try {
      actual = method === 0 ? bytes.length : inflateRawSync(bytes, { maxOutputLength: Math.max(1, remaining) }).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw tooLarge();
      throw invalid();
    }
    if (actual > remaining) throw tooLarge();
    if (actual !== declared) throw invalid();
    remaining -= actual;
    offset += 46 + data.readUInt16LE(offset + 28) + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
  }
  if (offset !== directoryEnd) throw invalid();
}
