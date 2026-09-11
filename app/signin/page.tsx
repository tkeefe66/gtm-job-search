import SignupIntro from "@/components/SignupIntro";
import { signIn, auth } from "@/auth";
import { redirect } from "next/navigation";
import { signInView, signInError, signInBody } from "@/lib/auth-policy";

export const dynamic = "force-dynamic";

/**
 * Signup is the default anonymous view. Google handles both signup and login;
 * the session-first policy still owns redirects, pending access, and refusals.
 */
export default async function SignIn({
  searchParams,
}: {
  // Auth.js redirects EVERY refusal here with ?error=<code>, because both
  // pages.signIn and pages.error point at this route. Repeated keys arrive as an
  // array; only the first is read, and anything else is handled by signInError's
  // unknown-code branch rather than trusted into the page.
  searchParams?: Promise<{ error?: string | string[]; mode?: string }>;
}) {
  const session = await auth();
  const query = await searchParams;
  const rawError = Array.isArray(query?.error)
    ? query?.error[0]
    : query?.error;
  const notice = signInError(rawError ?? null);
  // A session with no status is not a session for these purposes: the view rule
  // takes null to mean "nobody is signed in", which is the only state the Google
  // button belongs to.
  const view = signInView(session ? (session as unknown as { status?: string }).status ?? null : null);

  // Every branch below is decided in lib/auth-policy.ts, where a test can reach
  // it. This file only renders what it is told to.
  const body = signInBody(view, notice);

  if (body.kind === "redirect") redirect("/discover");

  const returning = query?.mode === "login";
  const errorNotice = notice ? (
    <div role="alert" className="mt-4 rounded-lg border border-[#FCD34D] bg-[#FFFBEB] p-3 text-sm text-[#92400E]">
      {notice.message}
    </div>
  ) : null;

  if (body.kind === "waitlist" || body.kind === "refused" || body.kind === "notice-only") {
    return <div className="mx-auto max-w-md py-16">
      <h1 className="font-heading text-2xl font-semibold">{body.kind === "waitlist" ? "Your account is awaiting access" : "Account access"}</h1>
      {errorNotice}
      {body.kind === "waitlist" && <p className="mt-4 text-sm text-ink/70">You’re signed in. Your account needs approval before you can continue.</p>}
      {body.kind === "refused" && <p className="mt-4 text-sm text-ink/70">This account doesn’t have access.</p>}
    </div>;
  }

  return <SignupIntro returning={returning}>
    {errorNotice}
    <form className="mt-6" action={async () => {
      "use server";
      await signIn("google", { redirectTo: "/discover" });
    }}>
      <button type="submit" className="w-full rounded-lg bg-ink px-4 py-3 text-sm font-semibold text-white transition hover:bg-ink/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink">
        {returning ? "Sign in with Google" : "Sign up with Google"}
      </button>
    </form>
  </SignupIntro>;
}
