"use client";

import { useEffect, useState } from "react";
import { getApiKeyStatus, saveApiKey, removeApiKey, type ApiKeyStatus } from "@/app/actions/api-key";
import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/providers/anthropic-pricing";
import { Spinner } from "./ui";

/**
 * Bring-your-own Anthropic key.
 *
 * The field is write-only: the stored key is never rendered back, only its last
 * four characters, which are stored separately so displaying them never requires
 * decrypting anything.
 */
export default function ApiKeyPanel() {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    const res = await getApiKeyStatus();
    // Presence, not truthiness — an unreachable database reports an empty
    // message, and `if (res.error)` would render "no key stored" for it.
    setError(res.error !== undefined ? res.error : null);
    setStatus(res);
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    setBusy(true); setSaved(false);
    const res = await saveApiKey(draft, { model: modelDraft });
    setError(res.error !== undefined ? res.error : null);
    setBusy(false);
    if (res.error === undefined) { setDraft(""); setModelDraft(""); setSaved(true); await load(); }
  }

  async function remove() {
    setBusy(true);
    const res = await removeApiKey();
    setError(res.error !== undefined ? res.error : null);
    setBusy(false);
    await load();
  }

  if (!status) return <Spinner label="Loading API key" />;

  return (
    <section className="mt-10">
      <h2 className="font-display text-xl text-ink">Your Anthropic API key</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink/60">
        Optional. With your own key, searches bill your Anthropic account instead
        of the included free usage, and no monthly limit applies. Usage is still
        recorded here so you can see what you spend.
      </p>

      {/*
        Stated plainly rather than implied. The platform holds the encryption key
        and the database, so "we cannot read it" would be a promise the
        architecture cannot keep. What is true is that the app never shows it
        again — including to the admin.
      */}
      <p className="mt-2 max-w-2xl text-xs text-ink/40">
        Your key is encrypted before it is stored and is never displayed again —
        not to you, and not to an administrator. It is not, however, hidden from
        the people who operate this server.
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] px-3 py-2 text-sm text-[#991B1B]">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="mt-3 text-sm text-[#166534]">Key verified with Anthropic and saved.</p>
      )}

      {status.present ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="rounded border border-slate px-2 py-1 font-mono text-sm text-ink/70">
            sk-ant-…{status.lastFour}
          </span>
          <span className="text-xs text-ink/50">
            added {status.addedAt?.slice(0, 10)}
            {status.status !== "ok" && ` · ${status.status}`}
            {status.provider && ` · ${status.provider}`}
            {` · ${status.model ?? ANTHROPIC_DEFAULT_MODEL}`}
          </span>
          <button
            disabled={busy}
            onClick={() => void remove()}
            className="rounded border border-slate px-2 py-1 text-xs hover:border-ink disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      ) : (
        <div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="sk-ant-…"
              autoComplete="off"
              className="w-80 rounded-lg border border-slate px-3 py-2 font-mono text-sm"
            />
            <input
              type="text"
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              placeholder={ANTHROPIC_DEFAULT_MODEL}
              autoComplete="off"
              className="w-56 rounded-lg border border-slate px-3 py-2 font-mono text-sm"
            />
            <button
              disabled={busy || draft.trim().length === 0}
              onClick={() => void save()}
              className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "Verifying…" : "Save key"}
            </button>
          </div>
          <p className="mt-2 text-sm text-ink/60">
            Optional. Leave blank for the default, {ANTHROPIC_DEFAULT_MODEL}. Changing the model
            re-saves the key, so you will need to paste it again — the stored key is bound
            to the model it runs on and is never read back.
          </p>
        </div>
      )}
    </section>
  );
}
