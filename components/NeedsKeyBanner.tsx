import Link from "next/link";

/**
 * Shown on every page until the tenant stores a key.
 *
 * A keyless user would otherwise see a normal-looking app whose every button
 * fails — the actions refuse correctly, but only AFTER a click, one at a time,
 * with no explanation of why the app exists in this state. This is the whole of
 * a new user's first experience, so it explains the product, the requirement and
 * the next step rather than only reporting a block.
 *
 * Rendered from the layout (a server component) so it cannot be missed by a page
 * that forgets it.
 */
export default function NeedsKeyBanner() {
  return (
    <div className="mx-auto mb-6 max-w-6xl px-4 sm:px-6">
      <div className="rounded-xl border border-[#FCD34D] bg-[#FFFBEB] p-4">
        <h2 className="font-heading font-semibold text-[#92400E]">
          Add your API key to start
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-[#92400E]/90">
          This app searches the web for roles and scores each one 1–5 against
          your background using an AI model. It runs on <strong>your</strong>{" "}
          model API key, so the usage is billed to your account and nothing is
          charged to anyone else — which also means no one else can see what you
          search for.
        </p>
        <p className="mt-2 max-w-2xl text-sm text-[#92400E]/90">
          You&apos;ll need a key from{" "}
          <a
            className="underline"
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer noopener"
          >
            console.anthropic.com
          </a>
          . A typical search costs a little over a dollar; the app shows you what
          each run spends.
        </p>
        <Link
          href="/settings"
          className="mt-3 inline-block rounded-lg bg-[#92400E] px-3 py-2 text-sm font-medium text-white"
        >
          Add your key in Settings
        </Link>
      </div>
    </div>
  );
}
