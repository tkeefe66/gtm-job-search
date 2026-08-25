"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Discover", href: "/discover" },
  { label: "Watchlist", href: "/watchlist" },
  { label: "Roles", href: "/roles" },
  { label: "Settings", href: "/settings" },
];

/**
 * `isAdmin` is passed in from the layout (a server component) rather than read
 * here. Nav is a client component and cannot see the session — and hiding the
 * link would not be a control anyway: /admin and every action behind it check
 * the role SERVER-SIDE. This only decides whether the tab is worth showing.
 */
export default function Nav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const tabs = isAdmin
    ? [...TABS, { label: "Résumé", href: "/resume" }, { label: "Accounts", href: "/admin" }]
    : TABS;

  return (
    <header className="mx-auto max-w-6xl px-4 pt-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-heading font-bold tracking-tight">
          Job Search
        </h1>
        <p className="text-sm text-ink/60">
          AI-powered job search — discover, research, track, analyze.
        </p>
      </div>
      <nav className="flex gap-1 border-b border-slate">
        {tabs.map((t) => (
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
