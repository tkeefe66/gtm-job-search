import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/require-actor";
import ResumeDocument from "@/components/resume/ResumeDocument";
import { selectBullets } from "@/lib/resume-render/render";
import career from "@/lib/resume-render/content/resume.json";

export const dynamic = "force-dynamic";

// TEMPORARY verification route for the "TK Resume Design System" Claude
// Design port — proves ResumeDocument.tsx + render.js faithfully reproduce
// ui_kits/resume/index.html (the "blended" variant) before the real
// resume-builder feature (docs/superpowers/specs/2026-08-24-resume-builder-design.md)
// lands at the real /resume route. Delete this route once that feature
// ships there.
export default async function ResumePreviewPage() {
  const actor = await requireAdminPage();
  if (!actor.isAdmin) redirect("/discover");

  const blended = career.positioning.find((p) => p.id === "blended");
  const selection = selectBullets(career, {
    themes: blended?.themes ?? [],
    positioning: "blended",
  });

  return (
    <>
      <link rel="stylesheet" href="/resume-design/styles.css" />
      <ResumeDocument career={career} selection={selection} />
    </>
  );
}
