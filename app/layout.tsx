import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import Nav from "@/components/Nav";
import { auth } from "@/auth";
import NeedsKeyBanner from "@/components/NeedsKeyBanner";
import { rawQuery } from "@/lib/supabase";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "GTM Job Search",
  description: "AI-powered GTM / RevOps job search tool",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read once here so Nav can decide whether to show the Accounts tab. Purely
  // cosmetic — /admin and its actions check the role server-side regardless.
  const session = await auth();
  const isAdmin = (session as unknown as { role?: string } | null)?.role === "admin";

  // Whether this tenant can call anything at all. Read here rather than per page
  // so a page that forgets cannot hide the state — a keyless user would
  // otherwise meet the requirement one failed click at a time.
  //
  // The admin uses the platform key, so they are never keyless.
  const tenantId = (session as unknown as { userId?: string } | null)?.userId;
  let needsKey = false;
  if (tenantId && !isAdmin) {
    const { data, error } = await rawQuery<{ tenant_id: string }>(
      `select tenant_id from tenant_api_keys where tenant_id = $1 and status = 'ok'`,
      [tenantId],
      tenantId
    );
    // Presence, not truthiness: a failed read must not be reported as "you have
    // a key" — that would replace an explanation with a silent wall of refusals.
    needsKey = error !== null || data.length === 0;
  }
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-screen bg-canvas text-ink antialiased">
        <Nav isAdmin={isAdmin} />
        {needsKey && <NeedsKeyBanner />}
        <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6">
          {children}
        </main>
      </body>
    </html>
  );
}
