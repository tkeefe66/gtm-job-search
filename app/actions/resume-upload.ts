"use server";

import { requireActor } from "@/lib/require-actor";
import { extractResumeText } from "@/lib/resume-upload";

export async function readResumeUpload(form: FormData): Promise<{ text?: string; error?: string }> {
  await requireActor();
  const file = form.get("resume");
  if (!file || typeof file === "string" || file.size === 0) return { error: "Choose a résumé file first." };
  if (file.size > 1024 * 1024) return { error: "Choose a résumé smaller than 1 MB, or paste its text." };
  try {
    const result = await extractResumeText(file.name, Buffer.from(await file.arrayBuffer()));
    console.log("onboarding: résumé text extracted");
    return result;
  } catch {
    // Do not expose parser diagnostics: they may contain document contents.
    console.warn("onboarding: résumé extraction failed");
    return { error: "Could not read this résumé. Use a text-based PDF (up to 10 pages), DOCX, or TXT under 1 MB, or paste the text below. Scanned PDFs need OCR first." };
  }
}
