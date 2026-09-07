import { getSavedResume } from "@/app/actions/saved-resumes";
import SavedResumePanel from "@/components/resume/SavedResumePanel";

/**
 * One frozen saved résumé.
 *
 * Three states that must not collapse onto each other, the same discipline the
 * draft screen applies to getJobContext: a failed READ is not a missing row,
 * and a missing row is not an error.
 */
export default async function SavedResumeScreen({ id }: { id: string }) {
  const { resume, error } = await getSavedResume(id);

  return (
    <div className="mx-auto max-w-3xl p-8 print:max-w-none print:p-0">
      {/* The styling for the .rsm markup, exactly as the draft screen loads it —
          ResumeDocument/SavedResumePanel load the pagination scripts but never
          this stylesheet, so each route must. */}
      <link rel="stylesheet" href="/resume-design/styles.css" />
      <h1 className="text-xl font-semibold print:hidden">Saved résumé</h1>
      {error !== undefined ? (
        <p className="mt-2 text-sm text-[#92400E] print:hidden">{error}</p>
      ) : resume === null ? (
        // The read filters LIVE_PREDICATE, so an expired-but-unpurged row lands
        // here too — naming expiry gives the user the likely reason rather than
        // a bare not-found.
        <p className="mt-2 text-sm text-ink/70 print:hidden">
          That saved résumé isn&apos;t here — it may have been deleted, or it may have passed
          the 60-day limit.
        </p>
      ) : (
        <div className="mt-6 print:mt-0">
          <SavedResumePanel resume={resume} />
        </div>
      )}
    </div>
  );
}
