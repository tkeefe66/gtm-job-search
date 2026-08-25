// Fixed inputs the checked-in resume-prompt.*.txt fixtures are rendered
// from. Every populated field is distinct and non-empty, the same
// discipline lib/__fixtures__/fit-prompt-inputs.ts uses, so a builder that
// renders one value where another belongs fails rather than coincidentally
// matching.
import type { ThemeVocabulary } from "@/lib/resume-render/render";
import type { JobSummaryFields } from "@/lib/resume-prompt";

export const FIXTURE_VOCABULARY: ThemeVocabulary = {
  themes: [
    {
      id: "ops",
      label: "Revenue / marketing operations",
      covers: "process design, campaign and lead operations",
      jdSignals: ["marketing operations", "RevOps", "process design"],
      evidence: "",
    },
    {
      id: "systems",
      label: "Building — A.I. and automation",
      covers: "agentic workflows and internal tools",
      jdSignals: ["AI", "agent", "automation", "build"],
      evidence: "",
    },
  ],
  derivation: { method: "fixture", examples: [] },
  knownGaps: { note: "fixture", absent: [] },
  evidenceNote: "fixture",
};

export const FIXTURE_JOB_FULL: JobSummaryFields = {
  roleTitle: "Director of Revenue Operations",
  company: "Northwind Robotics",
  keySkills: "Salesforce, Marketo, Workato",
  fitSummary: "Strong ops leader with hands-on automation experience.",
  seniority: "Director",
  department: "Revenue Operations",
  salaryRange: "$180K–$220K",
  companyDescription: "Series C industrial robotics company.",
};

export const FIXTURE_JOB_SPARSE: JobSummaryFields = {
  roleTitle: "Director of Revenue Operations",
  company: "Northwind Robotics",
  keySkills: null,
  fitSummary: null,
  seniority: null,
  department: null,
  salaryRange: null,
  companyDescription: null,
};
