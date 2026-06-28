"use client";

import { useEffect, useState } from "react";
import { findRoles } from "@/app/actions/roles";
import { addJob } from "@/app/actions/jobs";
import type { Role, Startup } from "@/lib/types";
import { SeniorityBadge, Spinner } from "./ui";

export default function Roles({
  startup,
  onAdded,
}: {
  startup: Startup | null;
  onAdded: () => void;
}) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!startup) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setMessage(null);
      setRoles([]);
      setAdded({});
      const res = await findRoles(startup.company, startup.careers_url);
      if (cancelled) return;
      if (res.error) setError(res.error);
      setRoles(res.roles);
      setMessage(res.message ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [startup]);

  async function handleAdd(role: Role, idx: number) {
    if (!startup) return;
    const res = await addJob({
      company: startup.company,
      role_title: role.role_title,
      status: "Tracking",
      seniority: role.seniority,
      location: role.location,
      job_url: role.job_url || null,
      careers_url: startup.careers_url || null,
      category: startup.category || null,
      raised: startup.raised || null,
      stage: startup.stage || null,
      traction: startup.traction || null,
      fit_summary: role.fit_signal || null,
    });
    if (res.error) {
      setError(res.error);
      return;
    }
    setAdded((a) => ({ ...a, [idx]: true }));
    onAdded();
  }

  if (!startup) {
    return (
      <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
        Pick a company on the Discover tab and click &quot;Find product
        roles&quot; to see open positions here.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-heading font-semibold">
          Product roles at {startup.company}
        </h2>
        <p className="text-sm text-ink/60">{startup.tagline}</p>
      </div>

      {loading && (
        <div className="py-12">
          <Spinner label={`Searching for roles at ${startup.company}…`} />
        </div>
      )}

      {error && !loading && (
        <div className="rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">
          {error}
        </div>
      )}

      {!loading && message && roles.length === 0 && (
        <div className="rounded-md border border-slate bg-white p-4 text-sm text-ink/60">
          {message}
        </div>
      )}

      {!loading && !error && !message && roles.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No open product roles found right now.
        </div>
      )}

      <div className="flex flex-col gap-4">
        {roles.map((r, i) => (
          <div
            key={`${r.role_title}-${i}`}
            className="rounded-lg border border-slate bg-white p-5"
          >
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <h3 className="text-lg font-heading font-semibold">
                {r.role_title}
              </h3>
              {r.seniority && <SeniorityBadge seniority={r.seniority} />}
              {r.location && (
                <span className="text-sm text-ink/50">{r.location}</span>
              )}
            </div>
            {r.description_summary && (
              <p className="mb-2 text-sm text-ink/70">{r.description_summary}</p>
            )}
            {r.fit_signal && (
              <p className="mb-4 text-sm text-ink/60">
                <span className="font-medium text-ink/80">Why you fit: </span>
                {r.fit_signal}
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() => handleAdd(r, i)}
                disabled={added[i]}
                className="rounded-md border border-ink bg-ink px-3 py-1.5 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
              >
                {added[i] ? "Added ✓" : "Add to tracker"}
              </button>
              {r.job_url && (
                <a
                  href={r.job_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-ink px-3 py-1.5 text-sm font-medium transition hover:bg-ink hover:text-white"
                >
                  Open listing →
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
