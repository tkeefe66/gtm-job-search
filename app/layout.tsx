import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import Nav from "@/components/Nav";
import { auth } from "@/auth";
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
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-screen bg-canvas text-ink antialiased">
        <Nav isAdmin={isAdmin} />
        <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6">
          {children}
        </main>
      </body>
    </html>
  );
}
