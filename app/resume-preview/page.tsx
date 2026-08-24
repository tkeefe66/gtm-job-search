import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/require-actor";
import ResumeDocument from "@/components/resume/ResumeDocument";
import { SAMPLE_RESUME } from "@/lib/__fixtures__/resume-preview-sample";

export const dynamic = "force-dynamic";

// TEMPORARY verification route for the "My Resume Design System" Claude
// Design port — proves ResumeDocument.tsx faithfully reproduces
// ui_kits/resume/index.html before the real resume-builder feature
// (docs/superpowers/specs/2026-08-24-resume-builder-design.md) lands at the
// real /resume route. Delete this route (and the fixture it imports) once
// that feature ships there.
export default async function ResumePreviewPage() {
  const actor = await requireAdminPage();
  if (!actor.isAdmin) redirect("/discover");
  return (
    <>
      <link rel="stylesheet" href="/resume-design/styles.css" />
      <ResumeDocument resume={SAMPLE_RESUME} />
    </>
  );
}
