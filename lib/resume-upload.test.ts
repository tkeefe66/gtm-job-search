import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { extractResumeText } from "./resume-upload";

// Mutation: accept every extension and decode binary files as résumé text.
test("rejects unsupported formats instead of showing binary text", async () => {
  await expect(extractResumeText("resume.exe", Buffer.from("MZ"))).rejects.toThrow(/PDF, DOCX, or TXT/);
});
// Mutation: skip size validation before parsing an upload.
test("rejects oversized uploads", async () => {
  await expect(extractResumeText("resume.txt", Buffer.alloc(1024 * 1024 + 1))).rejects.toThrow(/1 MB/);
});
// Mutation: return empty text as a successful import.
test("rejects blank files", async () => {
  await expect(extractResumeText("resume.txt", Buffer.from(" \n"))).rejects.toThrow(/readable text/);
});
// Mutation: truncate or change imported text before the user can review it.
test("imports plain text for review", async () => {
  expect(await extractResumeText("resume.TXT", Buffer.from("Alex Example\nMechanical engineer"))).toEqual({ text: "Alex Example\nMechanical engineer" });
});

// Mutation: bypass either binary parser and decode the file as UTF-8.
test.each(["pdf", "docx"])("extracts text from a real %s document", async (extension) => {
  const data = readFileSync(new URL(`./__fixtures__/onboarding-upload/resume.${extension}`, import.meta.url));
  expect((await extractResumeText(`resume.${extension}`, data)).text).toBe("Alex Example - Mechanical Engineer");
});

// Mutation: trust ZIP metadata instead of bounding actual decompression.
test("stops DOCX expansion even when its declared size is forged", async () => {
  const data = readFileSync(new URL("./__fixtures__/onboarding-upload/oversized.docx", import.meta.url));
  await expect(extractResumeText("resume.docx", data)).rejects.toThrow(/too large to unpack/);
});
