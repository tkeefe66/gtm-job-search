"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Discover", href: "/discover" },
  { label: "Watchlist", href: "/watchlist" },
  { label: "Roles", href: "/roles" },
  { label: "Insights", href: "/insights" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <header className="mx-auto max-w-6xl px-4 pt-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-heading font-bold tracking-tight">
          Job Search Reconciler
        </h1>
        <p className="text-sm text-ink/60">
          AI-powered product job search — discover, research, track, analyze.
        </p>
      </div>
      <nav className="flex gap-1 border-b border-slate">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              pathname === t.href || (pathname === "/" && t.href === "/discover")
                ? "border-ink text-ink"
                : "border-transparent text-ink/50 hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
