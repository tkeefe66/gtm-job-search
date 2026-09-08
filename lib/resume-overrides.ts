// lib/resume-overrides.ts
//
// What the résumé chat agent (Task 10, lib/resume-ops.ts) may retune about one
// tailored résumé, stored under tailored_resumes.content.overrides.
//
// This type lives in its own module rather than in app/actions/resume.ts.
// lib/resume-ops.ts needs it, and a lib module importing a type from a
// "use server" file is fragile: "use server" forbids non-async exports, so the
// import direction would become load-bearing for a type that is erased at
// compile time anyway. app/actions/resume.ts re-exports it
// (`export type { ResumeOverrides }`) for its existing consumers.
export interface ResumeOverrides {
  selection?: {
    lead?: string;
    positioning?: string;
    taper?: number[];
    compressAfter?: number;
    bullets?: Record<string, string[]>;
  };
  text?: Record<string, string>;
  design?: Record<string, string>;
  pageMargin?: string;
}
