import { parseBoardUrl, classifyJobLink } from "./job-link";
import type { BoardVendor } from "./ats-boards";

export interface EmployerBoardEvidence {
  vendor: BoardVendor;
  slug: string;
  evidenceUrl: string;
  boardUrl: string;
  kind: "employer_link";
}

/** Only actual published links/embeds count. Prose, scripts and guesses do not. */
export function employerBoardEvidence(pageUrl: string, html: string): EmployerBoardEvidence | null {
  const found=employerBoardCandidates(pageUrl,html);
  return found.length===1?found[0]:null;
}

export function employerBoardCandidates(pageUrl:string,html:string):EmployerBoardEvidence[] {
  // A reseller or vendor board linking itself cannot establish employer ownership.
  if (classifyJobLink(pageUrl) !== "other") return [];
  let page: URL;
  try { page = new URL(pageUrl); } catch { return []; }
  if (page.protocol !== "https:" || page.username || page.password) return [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1>/gi,(_all,kind,attributes)=>kind.toLowerCase()==="script"?`<script${attributes}>`:"");
  const tag = /<(a|iframe|script)\b[^>]*>/gi;
  const found = new Map<string, EmployerBoardEvidence>();
  let match: RegExpExecArray | null;
  while ((match = tag.exec(clean)) !== null) {
    const attribute = match[1].toLowerCase() === "a" ? /\bhref\s*=\s*["']([^"']+)["']/i : /\bsrc\s*=\s*["']([^"']+)["']/i;
    const value = match[0].match(attribute)?.[1];
    if (!value) continue;
    let boardUrl: string;
    try { boardUrl = new URL(value.replace(/&amp;/g, "&"), pageUrl).href; } catch { continue; }
    const board = parseBoardUrl(boardUrl);
    // Only the known Greenhouse embedding script is a board declaration.
    // Arbitrary JavaScript URLs and inline string content never count.
    if(match[1].toLowerCase()==="script" && !(board?.vendor==="greenhouse" && new URL(boardUrl).pathname.startsWith("/embed/job_board"))) continue;
    if (board) found.set(`${board.vendor}:${board.slug}`, { ...board, evidenceUrl:page.href, boardUrl, kind:"employer_link" });
  }
  return Array.from(found.values());
}
