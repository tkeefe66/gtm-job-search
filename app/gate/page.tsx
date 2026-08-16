/**
 * The unlock page for the stopgap gate. See middleware.ts for why this exists
 * and when to delete it.
 *
 * A plain server component posting a plain <form> to /api/gate — no client
 * JavaScript, no server action. A server action would be a POST to THIS route,
 * which the middleware matcher exempts, so routing the unlock through a route
 * handler keeps the exemption to a single narrow path instead of making the
 * whole page's action surface reachable.
 */

export const dynamic = "force-dynamic";

export default function GatePage({
  searchParams,
}: {
  searchParams: { e?: string };
}) {
  const configured = Boolean(process.env.GATE_TOKEN);
  const failed = searchParams.e === "1";

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <h1 className="font-display text-2xl text-ink">GTM Job Search</h1>

      {!configured ? (
        <p className="mt-4 text-sm text-ink/70">
          This app is locked and no access token is configured, so nothing can
          be unlocked. Set <code className="font-mono">GATE_TOKEN</code> on the{" "}
          <span className="font-mono">web</span> service and redeploy.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink/60">Enter the access password.</p>
          <form action="/api/gate" method="POST" className="mt-6 space-y-3">
            <input
              type="password"
              name="password"
              autoFocus
              autoComplete="current-password"
              aria-label="Access password"
              className="w-full rounded-lg border border-slate bg-white px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            />
            <button
              type="submit"
              className="w-full rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white"
            >
              Unlock
            </button>
          </form>
          {/*
            Deliberately generic, and identical for every failure mode. "Wrong
            password" versus "no password sent" versus a parse failure would
            each tell an attacker something about what the endpoint accepted.
          */}
          {failed && (
            <p className="mt-3 text-sm text-[#B42318]">
              That password did not work.
            </p>
          )}
        </>
      )}

      <p className="mt-8 text-xs text-ink/40">
        Temporary shared-password access. It will be replaced by Google sign-in.
      </p>
    </div>
  );
}
