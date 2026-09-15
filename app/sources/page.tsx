import Link from "next/link";
import SourceQuality from "@/components/SourceQuality";
import { requireActorPage } from "@/lib/require-actor";
import { getSourceQuality } from "@/app/actions/job-dispositions";
import { describeWriteFailure } from "@/lib/write-failure";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  await requireActorPage();
  const report = await getSourceQuality();
  const failure = describeWriteFailure(report.error, "load source quality");
  if (failure !== undefined) return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
    <h1 className="font-heading text-3xl font-semibold">Source quality</h1>
    <p role="alert" className="mt-5 text-sm text-red-700">{failure}</p>
    <Link href="/sources" className="mt-4 inline-block underline">Try again</Link>
  </main>;
  return <SourceQuality startedAt={report.startedAt} records={report.records} />;
}
