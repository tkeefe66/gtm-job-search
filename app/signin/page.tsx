import { signIn, auth } from "@/auth";
import { redirect } from "next/navigation";
import { accessFor } from "@/lib/auth-policy";

export const dynamic = "force-dynamic";

/**
 * Sign-in and waitlist are ONE page on purpose.
 *
 * A pending user genuinely holds a session — they are created and then denied at
 * session read, because refusing them earlier (in the signIn callback) aborts
 * before the adapter writes a row, leaving the admin nothing to approve. So
 * "signed in but not allowed in" is a real state and needs somewhere to land.
 */
export default async function SignIn() {
  const session = await auth();
  const status = (session as unknown as { status?: string } | null)?.status;

  if (session && status && accessFor(status).allow) redirect("/discover");

  const waiting = Boolean(session) && status === "pending";
  const refused = Boolean(session) && (status === "suspended" || status === "denied");

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <h1 className="font-display text-2xl text-ink">Job Search</h1>

      {waiting ? (
        <p className="mt-4 text-sm text-ink/70">
          You&apos;re on the waitlist. Your account needs to be approved before you
          can sign in — you&apos;ll be able to get in once that happens.
        </p>
      ) : refused ? (
        <p className="mt-4 text-sm text-ink/70">
          This account doesn&apos;t have access.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink/60">Sign in to continue.</p>
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
