import { rawQuery } from "@/lib/supabase";
import { addJob, updateJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import type { FitInputs } from "@/lib/fit-inputs";
import { checkJobUrl } from "@/lib/verify-url";
import { classifyJobLink } from "@/lib/job-link";
import { resolveEmployerLink } from "@/lib/resolve-job-link";
import { describeWriteFailure } from "@/lib/write-failure";
import {
  NORMALIZED_COMPANY_SQL,
  normalizeCompanyName,
  normalizeRoleKey,
  normalizeTitle,
} from "@/lib/role-key";
import type { Role } from "@/lib/types";

export interface IngestCompanyContext {
  tagline?: string | null;
  traction?: string | null;
  careers_url?: string | null;
  category?: string | null;
  raised?: string | null;
  stage?: string | null;
}

export interface IngestOptions {
  company: string;
  roles: Role[];
  companyContext?: IngestCompanyContext;
  source: string; // 'Discover' | 'Crawl' | 'Role Search'
  dryRun?: boolean;
  // Carried as FitInputs rather than the whole Criteria object on purpose:
  // ingestRoles uses nothing else from criteria, and the narrower type is what
  // kept the compensation floor from re-widening this interface — it arrived
  // as a field ON FitInputs, so no option and no call site here changed.
  // Required (not optional with a load-on-demand fallback) because every
  // caller here is a batch path — a per-row settings read inside the
  // Promise.all below would be one database round trip per scored role.
  fitInputs: FitInputs;
}

export interface IngestResult {
  added: Role[];
  skipped: Role[];
  seenTitles: string[];
}

/**
 * Dedupes roles against the jobs table, verifies their URLs, inserts the new
 * ones, and fit-scores the live ones.
 *
 * Dedupe deliberately ignores job status. A role the user already marked
 * Rejected or Not Interested must never come back as New on a later crawl.
 */
export async function ingestRoles(opts: IngestOptions): Promise<IngestResult> {
  const { company, roles, source, fitInputs, dryRun = false } = opts;
  const ctx = opts.companyContext ?? {};
  const seenTitles = roles.map((r) => normalizeTitle(r.role_title));

  // Normalized on both sides on purpose: normalizeRoleKey collapses casing
  // AND whitespace for the dedupe comparison below, but a lookup that only
  // matched on `lower(company) = lower($1)` would make that half-decorative —
  // SQL lower() does not collapse internal whitespace, so a row stored as
  // "Big  Co" (double space, or a scraped U+00A0) would be invisible to a
  // crawl passing "Big Co" and every role would look new and re-insert as a
  // duplicate "New" job.
  //
  // This WHERE decides which rows get LOADED, so it has to narrow in SQL —
  // the TypeScript-side match app/actions/watchlist.ts uses would mean
  // reading the whole (unbounded) jobs table. NORMALIZED_COMPANY_SQL is
  // therefore the SQL twin of normalizeCompanyName; both live in
  // lib/role-key.ts with the comment explaining why they must stay in sync,
  // and the parameter below is normalized by the TS one so the two sides are
  // always compared under definitions that agree.
  //
  // rawQuery is the escape hatch since the builder's filter surface
  // (.eq/.neq) can't express a normalizing expression. Its error is rethrown
  // below, deliberately unswallowed: a malformed expression must fail loudly
  // on the first crawl rather than quietly degrade to "everything is new".
  const { data: existing, error } = await rawQuery<{
    role_title: string;
    job_url: string | null;
  }>(
    `select role_title, job_url from jobs where ${NORMALIZED_COMPANY_SQL} = $1`,
    [normalizeCompanyName(company)]
  );

  if (error) {
    throw new Error(`ingestRoles: could not read existing jobs — ${error.message}`);
  }

  const knownKeys = new Set<string>();
  const knownUrls = new Set<string>();
  for (const row of (existing ?? []) as { role_title: string; job_url: string | null }[]) {
    knownKeys.add(normalizeRoleKey(company, row.role_title));
    if (row.job_url) knownUrls.add(row.job_url);
  }

  const added: Role[] = [];
  const skipped: Role[] = [];
  const fresh: Role[] = [];

  for (const role of roles) {
    const isKnown =
      knownKeys.has(normalizeRoleKey(company, role.role_title)) ||
      (!!role.job_url && knownUrls.has(role.job_url));
    if (isKnown) skipped.push(role);
    else fresh.push(role);
  }

  // Second-hand links are upgraded BEFORE they are checked, because the check
  // cannot see past them: a reseller answers 403 to anything that looks like a
  // bot, so an expired copy of a posting passes as live and the role lands as
  // "New". Asking the employer's own board instead answers both questions at
  // once — where the real posting is, and whether it still exists.
  const links = await Promise.all(fresh.map((r) => upgradeLink(company, r)));
  const urlStatuses = await Promise.all(links.map((l) => checkJobUrl(l.url)));
  const unlisted = links.filter((l) => l.unlisted).length;
  console.log(
    `ingestRoles(${company}): ${roles.length} found, ${fresh.length} new, ` +
      `${urlStatuses.filter((s) => s === "dead").length} dead URLs, ` +
      `${links.filter((l) => l.sourceUrl).length} relinked to the employer, ` +
      `${unlisted} not on the employer's board, source=${source}`
  );

  if (dryRun) {
    return { added: fresh, skipped, seenTitles };
  }

  const companyDescription = `${ctx.tagline ?? ""}. ${ctx.traction ?? ""}`.trim();

  await Promise.all(
    fresh.map(async (role, i) => {
      // Two independent ways to already be closed: the link 404s, or the
      // employer's own board does not list the role. The second is what
      // actually catches reseller links, which rarely 404.
      const isDead = urlStatuses[i] === "dead" || links[i].unlisted;

      const jobRes = await addJob({
        company,
        role_title: role.role_title,
        status: isDead ? "Posting Closed" : "New",
        seniority: role.seniority || null,
        location: role.location || null,
        job_url: links[i].url || null,
        source_url: links[i].sourceUrl,
        careers_url: ctx.careers_url || null,
        category: ctx.category || null,
        raised: ctx.raised || null,
        stage: ctx.stage || null,
        traction: ctx.traction || null,
        salary_range: role.salary_range || null,
        fit_summary: role.fit_signal || null,
        ic_flag: role.ic_flag ?? false,
        source,
      });

      // describeWriteFailure, not `if (jobRes.error)`. Presence, not
      // truthiness: an unreachable database rejects with an empty message
      // (see lib/write-failure.ts), which a truthiness check reads as a
      // successful insert — the role would then be pushed to `added` and
      // reported as stored, and the next crawl's dedupe would skip it.
      const failure = describeWriteFailure(
        jobRes.error,
        `store ${company} / ${role.role_title}`
      );
      if (failure !== undefined) {
        console.error(`ingestRoles: ${failure}`);
        return;
      }

      added.push(role);

      if (jobRes.job && !isDead) {
        const scored = await scoreFit({
          company,
          role_title: role.role_title,
          company_description: companyDescription,
          key_skills: role.description_summary,
          fit_summary: role.fit_signal,
          department: "",
          location: role.location,
          // The posting's own words, unparsed. Scoring reads compensation as
          // context, not as a filter — the extraction prompt never sees it,
          // and nothing here drops a role for being below the floor.
          salary_range: role.salary_range || "",
          fitInputs,
        });
        if (scored.score > 0) {
          await updateJob(jobRes.job.id, {
            fit_score: scored.score,
            fit_summary: scored.rationale || role.fit_signal || null,
          });
        }
      }
    })
  );

  return { added, skipped, seenTitles };
}

interface UpgradedLink {
  /** What the role should link to. */
  url: string;
  /** The reseller link we replaced, or null when nothing was replaced. */
  sourceUrl: string | null;
  /** The employer's board exists and does not list this role. */
  unlisted: boolean;
}

/**
 * Swaps a reseller link for the employer's own posting where one can be found.
 *
 * Only aggregator links are looked up — an ATS link or a company domain is
 * already the employer, and probing boards for those would spend requests to
 * confirm what we have. Costs no Claude tokens.
 *
 * `unlisted` is set only on `absent` (nothing on the board resembles the
 * title), never on `ambiguous`: closing a live role because two postings had
 * similar names would be a worse bug than the one this fixes.
 */
async function upgradeLink(company: string, role: Role): Promise<UpgradedLink> {
  const url = role.job_url || "";
  const plain: UpgradedLink = { url, sourceUrl: null, unlisted: false };
  if (classifyJobLink(url) !== "aggregator") return plain;

  const resolved = await resolveEmployerLink(company, role.role_title);
  if (!resolved) return plain;
  if (resolved.precision === "posting") {
    return { url: resolved.url, sourceUrl: url, unlisted: false };
  }
  // Board-level outcomes keep the original link: the board page is a fine
  // destination but it is not this role, and overwriting the only record of
  // where the role was found to point at a directory helps nobody.
  return { url, sourceUrl: null, unlisted: resolved.precision === "absent" };
}
