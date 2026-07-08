# Verdict Schema

Every posting produces exactly one verdict object. Routines consume the object; humans read the prose rendered from it. Emit the object first (in a fenced ```json block), then the prose.

## Structured verdict object

```json
{
  "company": "Ecosystems",
  "role": "CPTO",
  "source": "recruiter PDF | pasted text | URL",
  "date_analyzed": "YYYY-MM-DD",
  "verdict": "APPLY | APPLY_PENDING_DILIGENCE | SOFT_SKIP | HARD_SKIP | ROCKET_SHIP_EXCEPTION",
  "fit_score": 0-100,
  "hard_gates": {
    "level":      {"pass": true,  "evidence": "CPTO reporting to CEO — top seat"},
    "comp":       {"pass": null,  "evidence": "not listed; open question"},
    "location":   {"pass": true,  "evidence": "Remote"},
    "discipline": {"pass": true,  "evidence": "app-layer B2B platform product"}
  },
  "thesis": {
    "archetype": "a | b | none",
    "ai_core_or_bolted_on": "core",
    "upside": "high | medium | low",
    "upside_evidence": "profitable, PE-backed next-phase growth, category-defining"
  },
  "caveats": [
    {"type": "scope_stretch_up | vertical_gap | discipline_wall | title_question | crowded_category | comp_grazing | other",
     "detail": "owns Engineering as well as Product"}
  ],
  "red_flags": [],
  "rocket_ship": {"listed": false, "possible_by_definition": false, "override_applied": false},
  "open_questions": ["Comp not listed — confirm >= $350K"],
  "skip_severity": "n/a | soft | hard",
  "escape_hatch": "one line — only for skips",
  "resume_diff": "included for APPLY / APPLY_PENDING_DILIGENCE, else null",
  "why_me": "included for APPLY / APPLY_PENDING_DILIGENCE, else null"
}
```

Field rules:
- `fit_score`: holistic 0–100. Anchors from calibration: Ecosystems ≈ 92, Amplify ≈ 78, Ivo ≈ 80 (pending diligence), Brex ≈ 45, Robinhood ≈ 25, YouTube ≈ 12, CoreWeave ≈ 30, Anthropic dev-prod ≈ 35 (55 with rocket-ship override noted).
- A gate with unknown evidence gets `"pass": null` and a matching entry in `open_questions`.
- `APPLY_PENDING_DILIGENCE` requires at least one open question that gates the verdict.
- Rocket-ship: if `override_applied` is true, `verdict` = `ROCKET_SHIP_EXCEPTION` and prose MUST show the honest scorecard first, exception block second.

## Prose rendering rules

Order: **Verdict line → gates & thesis in 2–4 tight sentences → caveats/red flags → (skips) escape hatch | (applies) resume diff + why-me → open questions.**

- Verdict line is blunt: "**Apply.** …" / "**Skip (hard).** …" / "**Skip (soft).** …" / "**Apply, pending one question.** …"
- Name what's genuinely great even in a skip, and name the seduction ("the logo/keywords are doing the work here") when relevant.
- Escape hatch always renders as: *"The one thing that could change my mind: …"* — a real condition for soft skips, an honest "essentially nothing — pass without a call" for hard skips.
- No hedging, no filler, no bullet walls. Match skip severity to tone.

## Resume diff format (APPLY / APPLY_PENDING_DILIGENCE only)

```
EDIT 1 — Summary
CURRENT: "Product executive with 15+ years defining GTM platforms..."
REPLACE: "<role-tailored summary>"
WHY: <one line tied to the posting>

EDIT 2 — Reorder (Demandbase)
MOVE: "Designed and shipped agentic AI prototyping framework..." to first bullet
WHY: posting is coach-player / builds-with-AI; lead with the builder proof

EDIT 3 — Skills line
CURRENT: ...
REPLACE: ...
WHY: mirror the posting's exact vocabulary where truthfully applicable
```

3–7 edits typical. Selection, reordering, summary rewrite, and truthful vocabulary mirroring. Never fabricate; never claim infra depth.

## Why-me note format

3–6 sentences, first person, Chad's voice: short punchy sentences, no em dashes, no corporate filler. Strongest genuine hook in sentence one. Biggest honest gap addressed in one confident line. Close with a concrete proof point, not a platitude.

## Routine / bulk mode

- Emit one verdict object per posting; then a one-line ranked summary table across the batch (company, verdict, fit_score, top caveat).
- Resume diff + why-me are generated eagerly for every APPLY and APPLY_PENDING_DILIGENCE — never deferred, never flag-only.
- If resume master is unavailable AND no PDF is provided: emit the full verdict anyway with `"resume_diff": "PENDING — resume master not found; provide resume PDF"`, same for `why_me`. Never drop the analysis.
- Unresolvable facts go to `open_questions`; never guess reporting lines, comp, or work model.
