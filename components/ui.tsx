"use client";

import type { JobStatus, Seniority } from "@/lib/types";

const STATUS_STYLES: Record<JobStatus, string> = {
  Tracking: "bg-[#FEF3C7] text-[#92400E]",
  Applied: "bg-[#DBEAFE] text-[#1E40AF]",
  Interviewing: "bg-[#EDE9FE] text-[#5B21B6]",
  Offer: "bg-[#DCFCE7] text-[#14532D]",
  Passed: "bg-[#F3F4F6] text-[#6B7280]",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
        STATUS_STYLES[status] ?? STATUS_STYLES.Tracking
      }`}
    >
      {status}
    </span>
  );
}

export function SeniorityBadge({ seniority }: { seniority: string }) {
  const map: Record<string, string> = {
    "VP/CPO": "bg-[#EDE9FE] text-[#5B21B6]",
    Director: "bg-[#DBEAFE] text-[#1E40AF]",
    "Senior PM": "bg-[#FEF3C7] text-[#92400E]",
    PM: "bg-[#F3F4F6] text-[#6B7280]",
  };
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
        map[seniority] ?? "bg-[#F3F4F6] text-[#6B7280]"
      }`}
    >
      {seniority}
    </span>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-md border border-slate bg-white px-2 py-0.5 text-xs text-ink/70">
      {children}
    </span>
  );
}

export function Stars({
  score,
  onChange,
}: {
  score: number | null;
  onChange?: (n: number) => void;
}) {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          onClick={() => onChange?.(n)}
          className={`text-sm leading-none ${
            onChange ? "cursor-pointer" : "cursor-default"
          } ${score && n <= score ? "text-ink" : "text-slate"}`}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
        >
          ★
        </button>
      ))}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-ink/60">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate border-t-ink" />
      {label}
    </div>
  );
}

export type { Seniority };
