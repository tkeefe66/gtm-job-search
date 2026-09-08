import Link from "next/link";
import { redirect } from "next/navigation";
import { requireActorPage } from "@/lib/require-actor";
import { getJobContext, loadResumeContext } from "@/app/actions/resume";
import { listSavedResumes } from "@/app/actions/saved-resumes";
import TailorPanel from "@/components/resume/TailorPanel";
import SavedResumeList from "@/components/resume/SavedResumeList";
import SavedResumeScreen from "@/components/resume/SavedResumeScreen";

export const dynamic = "force-dynamic";

export default async function ResumePage({
  searchParams,
}: {
  searchParams: { jobId?: string; savedId?: string };
}) {
  const actor = await requireActorPage();
  if (!actor.isAdmin) redirect("/discover");

  // savedId wins when both are present: it names one specific document, which
  // is more specific than "the draft for this job".
  const savedId = searchParams.savedId;
  if (savedId) return <SavedResumeScreen id={savedId} />;

  const jobId = searchParams.jobId;

  // No jobId: the archive. The old pointer-at-Roles copy is kept verbatim as
  // the empty state, since it is still exactly what a user with nothing saved
  // needs to be told.
  if (!jobId) {
    const { resumes, error } = await listSavedResumes();
    return (
      <div className="mx-auto max-w-3xl p-8">
        <h1 className="text-xl font-semibold">Saved résumés</h1>
        {error !== undefined && <p className="mt-2 text-sm text-[#92400E]">{error}</p>}
        {resumes.length === 0 ? (
          <p className="mt-2 text-sm text-ink/70">
            Nothing saved yet. Tailor a résumé from a tracked role — open{" "}
            <Link href="/roles" className="underline underline-offset-2">
              Roles
            </Link>{" "}
            and click "Tailor resume" on the one you want.
          </p>
        ) : (
          <SavedResumeList resumes={resumes} />
        )}
      </div>
    );
  }

  const [context, resumeContext] = await Promise.all([getJobContext(jobId), loadResumeContext(jobId)]);

  // Three distinct states, not two: `getJobContext` returns `null` for a
  // genuine 404 (the job row is gone) and `{ ..., error }` for a DB read
  // that failed outright — those must not collapse onto the same "found"
  // branch. `context.error` is already a full sentence (loadJobForTenant
  // runs it through describeWriteFailure before returning), so it's shown
  // verbatim rather than re-described.
  let contextNode: React.ReactNode;
  if (context === null) {
    contextNode = (
      <p className="mt-1 text-sm text-[#92400E] print:hidden">
        That job couldn't be found — it may have been deleted.
      </p>
    );
  } else if (context.error !== undefined) {
    contextNode = <p className="mt-1 text-sm text-[#92400E] print:hidden">{context.error}</p>;
  } else {
    contextNode = (
      <p className="mt-1 text-sm text-ink/70 print:hidden">
        For {context.roleTitle} at {context.company}
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-8 print:max-w-none print:p-0">
      {/* Not pagination-shell script (that's ResumeDocument.tsx's next/script
          tags for doc-page.js/page-guides.js) — this is the actual styling
          for the .rsm markup those scripts paginate. The deleted temporary
          preview route carried the same tag; ResumeDocument.tsx itself never
          loads it, so this route must. */}
      <link rel="stylesheet" href="/resume-design/styles.css" />
      <h1 className="text-xl font-semibold print:hidden">Résumé</h1>
      {contextNode}
      <div className="mt-6 print:mt-0">
        {resumeContext.error !== undefined ? (
          <p className="mt-1 text-sm text-[#92400E] print:hidden">{resumeContext.error}</p>
        ) : resumeContext.career ? (
          // The narrowing above (rather than trusting `error === undefined`
          // alone) is deliberate: `career` is optional on the return type, and
          // casting it away here would hide the one case loadResumeContext's
          // own type admits but its implementation never produces.
          <TailorPanel
            career={resumeContext.career}
            jobId={jobId}
            initialSelection={resumeContext.selection}
            initialOverrides={resumeContext.overrides}
            initialCoverage={resumeContext.coverage}
            initialWarnings={resumeContext.warnings}
            roleTitle={context && context.error === undefined ? context.roleTitle : null}
            company={context && context.error === undefined ? context.company : null}
          />
        ) : (
          <p className="mt-1 text-sm text-[#92400E] print:hidden">
            Could not load the career record for this résumé.
          </p>
        )}
      </div>
    </div>
  );
}
