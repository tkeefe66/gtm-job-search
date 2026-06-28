"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { analyzePipeline, getCachedInsights } from "@/app/actions/insights";
import type { Insights as InsightsData } from "@/lib/types";
import { Spinner, Tag } from "./ui";

export default function Insights() {
  const router = useRouter();
  const [data, setData] = useState<InsightsData | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingCached, setLoadingCached] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await getCachedInsights();
      if (res.insights) { setData(res.insights); setFetchedAt(res.fetchedAt ?? null); }
      setLoadingCached(false);
    })();
  }, []);

  async function run() {
    setLoading(true);
    setError(null);
    const res = await analyzePipeline();
    if (res.error) setError(res.error);
    if (res.insights) { setData(res.insights); setFetchedAt(new Date().toISOString()); }
    setLoading(false);
  }

  function formatFetchedAt(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  }

  const busy = loading || loadingCached;

  return (
    <div>
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-heading font-semibold">Market intelligence</h2>
          <p className="text-sm text-ink/60">
            Patterns across your pipeline vs. the current market.
            {fetchedAt && !busy && (
              <span className="ml-2 text-ink/40">· Last analyzed {formatFetchedAt(fetchedAt)}</span>
            )}
          </p>
        </div>
        <button
          onClick={run}
          disabled={busy}
          className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
        >
          {loading ? "Analyzing…" : "Analyze my pipeline"}
        </button>
      </div>

      {loadingCached && <div className="py-12"><Spinner label="Loading saved analysis…" /></div>}
      {loading && <div className="py-12"><Spinner label="Analyzing your pipeline and the market…" /></div>}

      {error && !busy && (
        <div className="rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">{error}</div>
      )}

      {!busy && !error && !data && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          Track a few roles, then click &quot;Analyze my pipeline&quot;.
        </div>
      )}

      {data && !busy && (
        <div className="flex flex-col gap-6">
          <Section title="What the market wants">
            <div className="flex flex-wrap gap-2">
              {data.top_skills_in_demand.map((s, i) => <Tag key={i}>{s}</Tag>)}
            </div>
          </Section>

          <Section title="Themes across your pipeline">
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink/80">
              {data.common_themes.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </Section>

          <Section title="Gap analysis">
            <p className="text-sm text-ink/80">{data.gap_analysis}</p>
          </Section>

          <Section title="How to position yourself">
            <p className="text-sm text-ink/80">{data.positioning_advice}</p>
          </Section>

          <Section title="Company archetypes">
            <div className="grid gap-4 sm:grid-cols-2">
              {data.company_archetypes.map((a, i) => (
                <div key={i} className="rounded-lg border border-slate bg-white p-4">
                  <h4 className="mb-1 font-heading font-semibold">{a.archetype}</h4>
                  <p className="mb-2 text-sm text-ink/70">{a.description}</p>
                  <div className="flex flex-wrap gap-2">
                    {a.example_companies?.map((c, j) => <Tag key={j}>{c}</Tag>)}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Recommended next searches">
            <div className="flex flex-wrap gap-2">
              {data.recommended_next_searches.map((s, i) => (
                <button
                  key={i}
                  onClick={() => router.push(`/discover?search=${encodeURIComponent(s)}`)}
                  className="rounded-full border border-ink px-3 py-1 text-sm transition hover:bg-ink hover:text-white"
                >
                  {s} →
                </button>
              ))}
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate bg-white p-5">
      <h3 className="mb-3 text-sm font-heading font-semibold uppercase tracking-wide text-ink/70">
        {title}
      </h3>
      {children}
    </div>
  );
}
