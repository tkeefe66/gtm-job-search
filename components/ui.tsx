"use client";

import type { JobStatus, Seniority } from "@/lib/types";

const STATUS_STYLES: Record<string, string> = {
  New: "bg-[#DBEAFE] text-[#1E40AF]",
  Reviewing: "bg-[#FEF3C7] text-[#92400E]",
  Applied: "bg-[#EDE9FE] text-[#5B21B6]",
  "Not Interested": "bg-[#F3F4F6] text-[#6B7280]",
  Rejected: "bg-[#FEE2E2] text-[#991B1B]",
  Offer: "bg-[#DCFCE7] text-[#14532D]",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
        STATUS_STYLES[status] ?? "bg-[#F3F4F6] text-[#6B7280]"
      }`}
    >
      {status}
    </span>
  );
}

export function SeniorityBadge({ seniority }: { seniority: string }) {
  const map: Record<string, string> = {
    "VP/Head": "bg-[#EDE9FE] text-[#5B21B6]",
    Director: "bg-[#DBEAFE] text-[#1E40AF]",
    "Senior Manager": "bg-[#FEF3C7] text-[#92400E]",
    "Manager/IC": "bg-[#F3F4F6] text-[#6B7280]",
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
