import { createHash } from "node:crypto";
import { parseBoardLink } from "./job-link";
import type { Role } from "./types";
import type { ExtractedPage } from "./page-extract";

export const CRAWL_PARSER_VERSION = 1;
export interface ListingSnapshot { role: Role; hash: string; body?: string; lastAttemptedAt?:string; }
export interface CrawlSnapshot {
  sourceKey: string;
  criteriaHash: string;
  contentHash: string;
  listings: ListingSnapshot[];
  processed: Record<string, string>;
  capturedAt: string;
}

export function normalizedText(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function stable(value: unknown): unknown {
  if (typeof value === "string") return normalizedText(value);
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = stable((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}
export function criteriaFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export function listingKey(role: Pick<Role,"job_url"|"role_title">): string {
  const link = parseBoardLink(role.job_url);
  if (link?.slug) return `${link.vendor}:${link.slug.toLowerCase()}:${link.id}`;
  try { const url = new URL(role.job_url); url.hash = ""; return url.href; }
  catch { return `title:${normalizedText(role.role_title).toLowerCase()}`; }
}
export function contentFingerprint(role: Role, body?: string): string {
  return criteriaFingerprint({ title:role.role_title, location:role.location, salary:role.salary_range,
    seniority:role.seniority, department:role.department ?? "", body:body ?? role.description_summary,
    requirements:role.requirements ?? [], niceToHaves:role.nice_to_haves ?? [] });
}
export function pageFingerprint(page: ExtractedPage, url: string): string {
  const links = page.links.map(link => {
    let href = link.href;
    try { href = new URL(href, url).href; } catch { /* Retain malformed data as a change. */ }
    return `${href}\n${normalizedText(link.text)}`;
  }).sort();
  return criteriaFingerprint({ text: page.text, links });
}
export function candidatesToProcess(listings: ListingSnapshot[], processed: Record<string,string>): ListingSnapshot[] {
  return listings.filter(item => processed[listingKey(item.role)] !== item.hash);
}

/** Failed candidates remain pending but cannot monopolize the bounded queue. */
export function crawlProcessingQueue(listings:ListingSnapshot[],processed:Record<string,string>,limit:number):ListingSnapshot[] {
  return candidatesToProcess(listings,processed).slice().sort((a,b)=>(a.lastAttemptedAt??"").localeCompare(b.lastAttemptedAt??"")).slice(0,limit);
}
export function carryListingAttempts(listings:ListingSnapshot[],previous:ListingSnapshot[]):ListingSnapshot[] {
  const old=new Map(previous.map(item=>[listingKey(item.role),item]));
  return listings.map(item=>{
    const before=old.get(listingKey(item.role));
    return before?.hash===item.hash&&before.lastAttemptedAt?{...item,lastAttemptedAt:before.lastAttemptedAt}:item;
  });
}
