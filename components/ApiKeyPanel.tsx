"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getApiKeyStatus, saveApiKey, removeApiKey, type ApiKeyStatus } from "@/app/actions/api-key";
import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/providers/anthropic-pricing";
import { describeWriteFailure } from "@/lib/write-failure";
import { Spinner } from "./ui";

/**
 * Bring-your-own Anthropic key.
 *
 * The field is write-only: the stored key is never rendered back, only its last
 * four characters, which are stored separately so displaying them never requires
 * decrypting anything.
 */
export default function ApiKeyPanel({ onReady, compact = false }: { onReady?: (ready: boolean) => void; compact?: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    try {
      const res = await getApiKeyStatus();
      setError(describeWriteFailure(res.error, "check your API key") ?? null);
      setStatus(res);
      setModelDraft(res.model ?? "");
      onReady?.(res.error === undefined && res.present && res.status === "ok");
    } catch {
      setError("Could not check your API key. Reload this page to try again.");
      setStatus({ present: false });
      onReady?.(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    setBusy(true); setSaved(false); setError(null);
    try {
      const res = await saveApiKey(draft, { model: modelDraft });
      const failure = describeWriteFailure(res.error, "save your API key");
      if (failure !== undefined) { setError(failure); return; }
      setDraft(""); setSaved(true); await load();
      router.refresh();
    } catch {
      setError("Could not verify or save your API key. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setSaved(false);
    try {
      const res = await removeApiKey();
      const failure = describeWriteFailure(res.error, "remove your API key");
      if (failure !== undefined) { setError(failure); return; }
      onReady?.(false);
      await load();
      router.refresh();
    } catch {
      setError("Could not remove your API key. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  if (!status) return <Spinner label="Loading API key" />;

  return (
    <section className={compact ? "mt-4" : "mt-10"}>
      <h2 className="font-display text-xl text-ink">Your Anthropic API key</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink/60">
        Required for AI features. Profile generation and searches bill your Anthropic account.
        Usage is recorded here so you can see what you spend. A Claude chat subscription does not cover API usage.
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

      {error !== null && (
        <p className="mt-3 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] px-3 py-2 text-sm text-[#991B1B]">
          {error}
        </p>
      )}
      {saved && error === null && (
        <p className="mt-3 text-sm text-[#166534]">Key verified with Anthropic and saved.</p>
      )}

      {status.present && (
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
      )}

      {/*
        The form renders in BOTH states, model field included. It used to render
        only when no key was stored, which meant a tenant with a key could not
        change their model without removing the key first — and the sentence
        explaining that a model change costs you a re-paste appeared at the one
        moment there was nothing to re-paste, and was hidden at the moment it
        applied. Only the copy differs now.
      */}
      <div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            aria-label="Anthropic API key"
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            className="w-full max-w-sm rounded-lg border border-slate px-3 py-2 font-mono text-sm"
          />
          <input
            aria-label="Model (optional)"
            type="text"
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            placeholder={ANTHROPIC_DEFAULT_MODEL}
            autoComplete="off"
            className="w-full max-w-sm rounded-lg border border-slate px-3 py-2 font-mono text-sm"
          />
          <button
            disabled={busy || draft.trim().length === 0}
            onClick={() => void save()}
            className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Verifying…" : status.present ? "Replace key" : "Save key"}
          </button>
        </div>
        <p className="mt-2 text-sm text-ink/60">
          {status.present ? (
            <>
              To change your model, enter its name and paste your key again so we can verify access.
            </>
          ) : (
            <>Optional. Leave blank for the default, {ANTHROPIC_DEFAULT_MODEL}.</>
          )}
        </p>
      </div>
    </section>
  );
}
