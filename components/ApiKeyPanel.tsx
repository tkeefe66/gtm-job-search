"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getApiKeyStatus, saveApiKey, removeApiKey, type ApiKeyStatus } from "@/app/actions/api-key";
import { PROVIDER_CHOICES, providerChoice, providerLabel, isSupportedProvider } from "@/lib/providers/catalog";
import type { ProviderId } from "@/lib/providers/types";
import { describeWriteFailure } from "@/lib/write-failure";
import { Spinner } from "./ui";

/**
 * Bring-your-own provider key.
 *
 * The field is write-only: the stored key is never rendered back, only its last
 * four characters, which are stored separately so displaying them never requires
 * decrypting anything.
 */
export default function ApiKeyPanel({ onReady, onStatusChange, compact = false, isAdmin = false }: { onReady?: (ready: boolean) => void; onStatusChange?: (status: ApiKeyStatus | null) => void; compact?: boolean; isAdmin?: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderId>("anthropic");
  const choice = providerChoice(providerDraft)!;
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
      onStatusChange?.(res.error === undefined ? res : null);
      setProviderDraft(isSupportedProvider(res.provider ?? "") ? res.provider as ProviderId : "anthropic");
      setModelDraft(res.model ?? "");
      onReady?.(res.error === undefined && res.present && res.status === "ok");
    } catch {
      setError("Could not check your API key. Reload this page to try again.");
      setStatus({ present: false });
      onStatusChange?.(null);
      onReady?.(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    setBusy(true); setSaved(false); setError(null);
    try {
      const res = await saveApiKey(draft, { model: modelDraft, provider: providerDraft });
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
      <h2 className="font-display text-xl text-ink">Your AI API key</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink/60">
        Choose Anthropic, OpenAI, or Google Gemini. AI usage is billed by your selected provider.
        A paid chat subscription does not include API usage. This app records estimated usage costs; provider invoices and free allowances may differ.
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

      {providerDraft === "google" && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Gemini has limited support: By Role search is unavailable because Gemini cannot enforce its search limit. Choose Anthropic or OpenAI for the full job-search flow.{isAdmin && " Your administrator account also requires these limits for other searches."}</p>}
      {error !== null && (
        <p className="mt-3 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] px-3 py-2 text-sm text-[#991B1B]">
          {error}
        </p>
      )}
      {saved && error === null && (
        <p className="mt-3 text-sm text-[#166534]">Key verified with {providerLabel(status.provider)} and saved.</p>
      )}

      {status.present && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="rounded border border-slate px-2 py-1 font-mono text-sm text-ink/70">
            ••••{status.lastFour}
          </span>
          <span className="text-xs text-ink/50">
            added {status.addedAt?.slice(0, 10)}
            {status.status !== "ok" && ` · ${status.status}`}
            {status.provider && ` · ${status.provider}`}
            {` · ${status.model ?? providerChoice(status.provider)?.defaultModel ?? "default model"}`}
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
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium">AI provider
            <select aria-label="AI provider" disabled={busy} value={providerDraft} onChange={e => {
              setProviderDraft(e.target.value as ProviderId); setModelDraft(""); setDraft(""); setSaved(false); setError(null); onReady?.(false);
            }} className="mt-1 block w-full rounded-lg border border-slate bg-white px-3 py-2">
              {PROVIDER_CHOICES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="text-sm font-medium">Model
            <select aria-label="AI model" disabled={busy} value={modelDraft || choice.defaultModel} onChange={e => {setModelDraft(e.target.value); setSaved(false); onReady?.(false);}} className="mt-1 block w-full rounded-lg border border-slate bg-white px-3 py-2">
              {choice.models.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>
        </div>
        <p className="mt-3 text-sm text-ink/70">Create your key in <a href={choice.keyUrl} target="_blank" rel="noreferrer noopener" className="underline">{choice.keySite}</a> and enable API billing or an eligible API quota. Verification makes a small API request.</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            aria-label={`${choice.label} API key`}
            type="password"
            disabled={busy}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={choice.placeholder}
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
              Changing provider or model replaces the saved connection. Paste the matching key again to verify it.
            </>
          ) : (
            <>Only supported models with usage pricing are listed.</>
          )}
        </p>
      </div>
    </section>
  );
}
