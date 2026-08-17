"use client";

export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-md border border-slate bg-white px-2 py-0.5 text-xs text-ink/70">
      {children}
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
