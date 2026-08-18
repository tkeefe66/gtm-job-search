import { signIn, auth } from "@/auth";
import { redirect } from "next/navigation";
import { signInView, signInError, signInBody } from "@/lib/auth-policy";

export const dynamic = "force-dynamic";

/**
 * Sign-in and waitlist are ONE page on purpose.
 *
 * A pending user genuinely holds a session — they are created and then denied by
 * the surfaces they ask for, because refusing them earlier (in the signIn
 * callback) aborts before the adapter writes a row, leaving the admin nothing to
 * approve. So "signed in but not allowed in" is a real state and needs somewhere
 * to land.
 *
 * That state has to remain READABLE here, which is why the adapter no longer
 * refuses by status (see auth.ts): a denial that returns a null session makes
 * this page indistinguishable from a signed-out one, and the button it then
 * shows loops the user back through Google forever.
 */
export default async function SignIn({
  searchParams,
}: {
  // Auth.js redirects EVERY refusal here with ?error=<code>, because both
  // pages.signIn and pages.error point at this route. Repeated keys arrive as an
  // array; only the first is read, and anything else is handled by signInError's
  // unknown-code branch rather than trusted into the page.
  searchParams?: { error?: string | string[] };
}) {
  const session = await auth();
  const rawError = Array.isArray(searchParams?.error)
    ? searchParams?.error[0]
    : searchParams?.error;
  const notice = signInError(rawError ?? null);
  // A session with no status is not a session for these purposes: the view rule
  // takes null to mean "nobody is signed in", which is the only state the Google
  // button belongs to.
  const view = signInView(session ? (session as unknown as { status?: string }).status ?? null : null);

  // Every branch below is decided in lib/auth-policy.ts, where a test can reach
  // it. This file only renders what it is told to.
  const body = signInBody(view, notice);

  if (body.kind === "redirect") redirect("/discover");

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <h1 className="font-display text-2xl text-ink">Job Search</h1>

      {notice && (
        <div className="mt-4 rounded-lg border border-[#FCD34D] bg-[#FFFBEB] p-3">
          <p className="text-sm text-[#92400E]">{notice.message}</p>
        </div>
      )}

      {body.kind === "waitlist" ? (
        <p className="mt-4 text-sm text-ink/70">
          You&apos;re on the waitlist. Your account needs to be approved before you
          can sign in — you&apos;ll be able to get in once that happens.
        </p>
      ) : body.kind === "refused" ? (
        <p className="mt-4 text-sm text-ink/70">
          This account doesn&apos;t have access.
        </p>
      ) : body.kind === "notice-only" ? null : (
        <>
          {body.prompt && <p className="mt-2 text-sm text-ink/60">Sign in to continue.</p>}
          <form
            className="mt-6"
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/discover" });
            }}
          >
            <button
              type="submit"
              className="w-full rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white"
            >
              Continue with Google
            </button>
          </form>
        </>
      )}
    </div>
  );
}
