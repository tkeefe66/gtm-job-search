import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import Nav from "@/components/Nav";
import { auth } from "@/auth";
import NeedsKeyBanner from "@/components/NeedsKeyBanner";
import { rawQuery } from "@/lib/supabase";
import { accessFor } from "@/lib/auth-policy";
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
  title: "Job Search",
  description: "AI-powered job search tool",
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
  //
  // Gated on the status too, not just on having a session: a pending user holds
  // a real session (auth.ts no longer nulls it, so the waitlist screen can read
  // it), and they are not a tenant yet — telling them to add an API key while
  // they wait for approval is an instruction they cannot act on.
  const s = session as unknown as { userId?: string; status?: string } | null;
  const tenantId = s && accessFor(s.status ?? "pending").allow ? s.userId : undefined;
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
        <div className="print:hidden">
          <Nav isAdmin={isAdmin} />
          {needsKey && <NeedsKeyBanner />}
        </div>
        <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 print:max-w-none print:p-0">
          {children}
        </main>
      </body>
    </html>
  );
}
