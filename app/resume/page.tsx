import Link from "next/link";
import { redirect } from "next/navigation";
import { requireActorPage } from "@/lib/require-actor";
import { getJobContext, getTailoredResume } from "@/app/actions/resume";
import TailorPanel from "@/components/resume/TailorPanel";
import type { CareerRecord } from "@/lib/resume-render/render";
import career from "@/lib/resume-render/content/resume.json";

export const dynamic = "force-dynamic";

export default async function ResumePage({
  searchParams,
}: {
  searchParams: { jobId?: string };
}) {
  const actor = await requireActorPage();
  if (!actor.isAdmin) redirect("/discover");

  const jobId = searchParams.jobId;
  if (!jobId) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-xl font-semibold">Résumé</h1>
        <p className="mt-2 text-sm text-ink/70">
          Tailor a résumé from a tracked role — open{" "}
          <Link href="/roles" className="underline underline-offset-2">
            Roles
          </Link>{" "}
          and click "Tailor resume" on the one you want.
        </p>
      </div>
    );
  }

  const [context, existing] = await Promise.all([getJobContext(jobId), getTailoredResume(jobId)]);

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
      {existing.error !== undefined && (
        <p className="mt-1 text-sm text-[#92400E] print:hidden">{existing.error}</p>
      )}
      <div className="mt-6 print:mt-0">
        <TailorPanel
          career={career as CareerRecord}
          jobId={jobId}
          initialSelection={existing.selection}
        />
      </div>
    </div>
  );
}
