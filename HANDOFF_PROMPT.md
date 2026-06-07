# Handoff prompt — paste this to a fresh agent

You are taking over the **Pool Takeoff Harness** project at
`X:\home\josh-zuino\projects\pool-takeoff-harness` (Windows, Node.js/CommonJS).

## What it is
An AI harness for JJZ steel pools: it reads pool construction PDF plans, uses a LOCAL vision model to
extract steel-takeoff values (dimensions, bar spacings, special features), fills a steel-bar calculator,
and totals 6m steel bars. There's a web UI (Express + a single-page front end) and a batch validation
script. It is WORKING end-to-end (24/24 sample plans extract successfully).

## First, orient yourself (read these, in order)
1. `HANDOFF.md` — full current state, file map, bugs fixed, open issues, domain rules.
2. `METHODOLOGY.md` — how/why it works, the prompt rationale, accuracy findings.
3. `README.md` — quick start + workflow.
Then skim `lib/extract.js` (page selection + render + model call + the system prompt + rescue) and
`lib/calc.js` (the steel math, ported verbatim from `public/index.html`).

## Non-negotiable gotchas (do NOT regress these)
- The local model is a **reasoning model**. Every chat request MUST include
  `chat_template_kwargs: { enable_thinking: false }` or it returns EMPTY content. `/no_think` does NOT work.
- **sharp cannot render PDFs** on this machine — `pdf-to-img` rasterizes, sharp only resizes/encodes.
- `pdfjs-dist` is used directly (page-text scan) and is an explicit dependency — keep it that way.
- The model API must be running at `.env` `API_BASE_URL` (default `http://192.168.1.127:8080`, llama.cpp).
  No API key needed (client defaults `apiKey:'not-needed'`).

## How to run / verify
- Web app: `start.bat` (or `node server.js`) → http://localhost:3000  (only ONE instance on :3000).
- Batch validation: `node scripts/batch.js [--only NAME] [--limit N] [--dir "C:\path"]` → writes `results/`.
- Tests: `npm test` (locks calculator math — run before claiming any change is done).
- Accuracy: `node scripts/accuracy.js` (reads `results/feedback/` saved from the UI's "Save as Correct").
- Sanity check: `node scripts/batch.js --only "Von Arx"` ⇒ ~L10×W3.8, ~266 bars, no errors.
- Plans live in `C:\Users\gibil\Downloads\Documents\Engineering plans` (≈24 PDFs).
- To view a PDF page yourself: the Read tool's PDF renderer is unavailable here; render with pdf-to-img to
  a PNG (see the snippet pattern in chat history / `lib/extract.js`) then read the PNG.

## Domain rules already encoded (verified on `24-0306-P01-REV0 signed.pdf`)
- Generic "library" details (TYPICAL…, SPA DETAIL, "OUT OF GROUND STRUCTURE UP TO 1200", "for information
  only") are NOT this pool — ignore unless the condition actually applies; site-specific detail wins.
- Kicker bars only when genuinely required (out-of-ground walls / explicit callout); in-ground ⇒ 0.
- Swimout/wading ledge = a bench: footprint (L×W) → `benches_m2`, AND its own reo (e.g. S12-150) computed
  as extra bars = longest side ÷ spacing (3.5m @150 ≈ 23).
- Steel spacings come from a SIZE- or DEPTH-keyed schedule table; match the row to the pool's ACTUAL
  value, never the table's max row. Map longitudinal→lengthways, transverse→crossways, vertical→lacing.
- Single Tile Beam was removed from the UI; always treated "yes" (hidden `#walls_200`).

## Open decision (ask the user before changing)
Per the user's instruction a swimout currently counts BOTH as bench area AND as ~23 extra S12-150 bars
(additive). Confirm with the user before making it count only once.

## Backlog (ranked, none blocking)
1. In-browser multi-file drag-drop batch.
2. Cache extraction by file hash (skip re-extract of same PDF).
3. Export takeoff (CSV / print view).
4. Model retry-on-bad-JSON (one reminder retry).
(OCR was considered and deprioritized: the vision model already reads the rendered image; OCR would only
help page selection, and the manual page-override feature already covers the misses.)

## Working conventions
- Keep `lib/calc.js` math identical to `public/index.html` `calculateSteel()` — they must agree; tests guard it.
- After meaningful changes, update `HANDOFF.md` (state) and run `npm test`.
- Don't blind-kill all node processes (some are MCP servers). Kill only the server on port 3000.
- The user runs a terse "caveman" reply style; technical accuracy unchanged. Code/docs written normally.
