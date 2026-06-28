"use client";

import { useState } from "react";
import Discover from "@/components/Discover";
import Roles from "@/components/Roles";
import Tracker from "@/components/Tracker";
import Insights from "@/components/Insights";
import type { Startup } from "@/lib/types";

type Tab = "Discover" | "Roles" | "Tracker" | "Insights";

const TABS: Tab[] = ["Discover", "Roles", "Tracker", "Insights"];

export default function Home() {
  const [tab, setTab] = useState<Tab>("Discover");
  const [selected, setSelected] = useState<Startup | null>(null);
  const [trackerKey, setTrackerKey] = useState(0);
  const [pendingSearch, setPendingSearch] = useState<string | null>(null);

  function handleFindRoles(startup: Startup) {
    setSelected(startup);
    setTab("Roles");
  }

  function handleAdded() {
    setTrackerKey((k) => k + 1);
    setTab("Tracker");
  }

  function handleSearchFromInsights(term: string) {
    setPendingSearch(term);
    setTab("Discover");
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-heading font-bold tracking-tight">
          Job Search Reconciler
        </h1>
        <p className="text-sm text-ink/60">
          AI-powered product job search — discover, research, track, analyze.
        </p>
      </header>

      <nav className="mb-8 flex gap-1 border-b border-slate">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === t
                ? "border-ink text-ink"
                : "border-transparent text-ink/50 hover:text-ink"
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      <main>
        {tab === "Discover" && (
          <Discover
            onFindRoles={handleFindRoles}
            pendingSearch={pendingSearch}
            onConsumeSearch={() => setPendingSearch(null)}
          />
        )}
        {tab === "Roles" && (
          <Roles startup={selected} onAdded={handleAdded} />
        )}
        {tab === "Tracker" && <Tracker refreshKey={trackerKey} />}
        {tab === "Insights" && (
          <Insights onSearch={handleSearchFromInsights} />
        )}
      </main>
    </div>
  );
}
