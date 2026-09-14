import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireActorPage } from '@/lib/require-actor';
import { resumeBuilderEnabled } from '@/lib/require-resume-builder';
import { getBuilderLibrary } from '@/app/actions/resume-builder';
import ResumeBuilder from '@/components/resume-builder/ResumeBuilder';

export const dynamic = 'force-dynamic';

export default async function ResumeBuilderPage({ searchParams }: { searchParams: Promise<{ jobId?: string }> }) {
  const actor = await requireActorPage();
  if (!resumeBuilderEnabled(actor.isAdmin)) redirect('/discover');
  const [library, query] = await Promise.all([getBuilderLibrary(), searchParams]);
  return <>{actor.isAdmin && <div className="mx-auto max-w-6xl px-4 pt-5 sm:px-6"><Link href="/resume" className="text-sm underline underline-offset-2">Previously saved résumés</Link></div>}<ResumeBuilder initialLibrary={library} jobId={query.jobId} /></>;
}
