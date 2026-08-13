import { rawQuery } from "@/lib/supabase";
import { addJob, updateJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { checkJobUrl } from "@/lib/verify-url";
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
  const { company, roles, source, dryRun = false } = opts;
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

  const urlStatuses = await Promise.all(fresh.map((r) => checkJobUrl(r.job_url)));
  console.log(
    `ingestRoles(${company}): ${roles.length} found, ${fresh.length} new, ` +
      `${urlStatuses.filter((s) => s === "dead").length} dead URLs, source=${source}`
  );

  if (dryRun) {
    return { added: fresh, skipped, seenTitles };
  }

  const companyDescription = `${ctx.tagline ?? ""}. ${ctx.traction ?? ""}`.trim();

  await Promise.all(
    fresh.map(async (role, i) => {
      const isDead = urlStatuses[i] === "dead";

      const jobRes = await addJob({
        company,
        role_title: role.role_title,
        status: isDead ? "Posting Closed" : "New",
        seniority: role.seniority || null,
        location: role.location || null,
        job_url: role.job_url || null,
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

      if (jobRes.error) {
        console.error(`ingestRoles: addJob failed for ${company} / ${role.role_title} — ${jobRes.error}`);
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
