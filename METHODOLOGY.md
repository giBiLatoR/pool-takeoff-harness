# Pool Takeoff Harness — Methodology

AI harness that reads pool construction PDFs, extracts steel-takeoff dimensions, and
fills the JJZ steel calculator. This doc is the repeatable record of what works.

## Architecture

```
PDF ─> pdfjs text scan ─> score pages (plan/steel relevance) ─> pick top N
   │                                                               │
   └────────────> pdf-to-img renders ONLY chosen pages ─> sharp resize/jpeg ─> base64 images
                                                                   │
                                              system prompt + images
                                                                   ▼
                                   local VL model (llama.cpp /v1/chat/completions)
                                            enable_thinking:false
                                                                   │
                                          JSON: dims + spacings + extra_features
                                                                   ▼
                                            lib/calc.js  ──>  steel bar count
```

- `lib/extract.js` — page selection + render + model call + JSON parse + normalize. Single source of truth for the prompt.
- `lib/calc.js` — steel calculator, ported verbatim from the browser calculator.
- `server.js` — web app (`/api/extract`, `/api/calc`, static UI).
- `scripts/batch.js` — runs extraction + calc over every plan, writes `results/`.

### Page selection (why)
Full engineering sets are 14–21 pages; the dimensioned pool sheet is rarely page 1 and most pages
are certificates/boilerplate. Rendering the first 6 pages missed the pool plan (→ length/width = 0).
Fix: read every page's text with pdfjs, score each for pool-plan + steel-detail keywords + dimension
density, and render only the top `MAX_PAGES`. When the text layer is missing or garbled (no ToUnicode
map — some plotters produce junk text), fall back to sampling pages **evenly** across the document.

### Dimension-rescue pass
If the main pass still returns length/width 0, a second pass renders the most dimension-dense page(s)
at higher DPI (`RESCUE_SCALE=4`, `RESCUE_WIDTH=2600`) and asks the model for length×width only. This
recovers dims that sit on a page the main selection skipped. When it still returns 0, that is strong
evidence the PDF genuinely has no readable set-out (deferred to architect / garbled vector) — the UI
then warns and asks for manual entry rather than guessing.

### Domain rules (from the estimator, encoded in the prompt)
- **Site-specific vs generic details.** Sets mix this pool's details with generic "library" details
  ("TYPICAL…", "SPA POOL DETAIL", "POOL WALL SECTION FOR OUT OF GROUND STRUCTURE UP TO 1200", marked
  "for information only"). Only extract steel for conditions that actually apply to this pool; the
  site-specific detail wins over the generic one.
- **Kicker bars** only when the pool genuinely needs them (out-of-ground walls or an explicit kicker
  callout) — NOT from a generic out-of-ground detail. Fully in-ground pool with no callout → 0.
- **Swimout / wading ledge / sun shelf = a bench.** Its footprint (L×W) is added to `benches_m2`.
- **Swimout reinforcement → extra bars.** If the swimout detail shows its own spacing (e.g. S12-150),
  the extra bars are computed (longest side ÷ spacing), not a flat number — e.g. 3.5m @150 ≈ 23 bars.
  (Verified on 24-0306: benches 6.3 m², kickers 0, swimout 23 bars + 3 piers.)
- **Single tile beam** removed from the UI; always treated as "yes".
- **Floor Area Override (m²).** From the JJZ Quote Calculator (`Variables!E30` `FloorAreaOverrideFactor`
  = `FloorAreaOverride/((Length*Width)-Bench)`, applied to the Crossways `C22` and Longways `C23` floor
  steel only). A non-rectangular pool's real floor slab is smaller than its bounding box; the override
  is that real floor area and scales the floor steel down by that factor. We clamp the factor to ≤ 1
  (the real floor is always inside the bounding box) so a bad read can never inflate steel. Walls
  (lacing), perimeter pins (droppers), bench and kickers stay on the bounding box. It is opt-in and
  conservative in the prompt (0 for rectangles and small swimouts) so it never perturbs the L/W read.
  Worked example (user's plan): bounding box 7×5 (lineal 2(7+5)=24), bench 4 m², real floor 21 m² →
  factor 21/((35)−4)=0.677.
- **Survey/boundary set-out vs pool size.** A figure shown with a bearing (`10 260  0°00'00"`,
  `40 234  270°00'00"`) is a property boundary, not the pool. Read the plain dimension on the pool
  outline. (This corrected the Von Arx sanity: true pool 7000×3000, not the 10.26 boundary figure.)

### Multiple files (one pool)
The estimator can upload/drag several PDFs for the SAME pool. `extractTakeoff` accepts a files array,
picks the most relevant pages from EACH file (per-file budget = `ceil(MAX_TOTAL_PAGES/N)`, total capped
at `MAX_TOTAL_PAGES=8`), and sends them all in ONE model call so the plan view (file A) and the steel
schedule (file B) are reconciled together. The server uses `upload.array`; the UI lists the files and
shows which pages were read per file. Page-override re-extract stays single-file only.

### Accuracy feedback loop
The estimator clicks "💾 Save as Correct" after reviewing → `results/feedback/`. `scripts/accuracy.js`
reports per-field exact / within-5% / mean-error and mean total-bars error (AI vs corrected). This turns
prompt tuning from guesswork into measurement and is the long-term path to higher accuracy.
`npm test` locks the calculator math so none of this drifts the totals.

## The two bugs that blocked everything

1. **Sharp cannot render PDFs.** The Windows prebuilt `sharp` reports
   `pdf input: {file:false, buffer:false, stream:false}` — no poppler/pdfium compiled in.
   The old code also called `.withPage()` / `.first()`, which are **not** sharp methods.
   Every PDF threw, hit the catch, and sent raw PDF bytes mislabeled as a JPEG — the model
   saw garbage. **Fix:** render with `pdf-to-img` (pure JS + `@napi-rs/canvas`, no system deps),
   then use sharp only to resize/encode the resulting PNG.

2. **The model is a reasoning model.** `Qwen3.6-27B...MTP` spends its whole token budget in a
   hidden thinking channel and returns **empty** `content` (`finish_reason: length`).
   `/no_think` in the prompt did **not** work via llama.cpp. **Fix:** pass
   `chat_template_kwargs: { enable_thinking: false }` in the chat completion request.
   Result: clean JSON, `finish_reason: stop`, ~370 tokens, fast.

(The reported "OPENAI_API_KEY not set" was a stale node process running old code. The client
defaults `apiKey` to `'not-needed'` since the local API needs no key.)

## Working configuration

`.env`:
```
API_BASE_URL=http://192.168.1.127:8080
VL_MODEL=Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-Q6_K.gguf
PORT=3000
```

Tunable render knobs (env, with defaults): `MAX_PAGES=6` (pages rendered after selection),
`MAX_SCAN=40` (pages text-scanned for selection), `RENDER_SCALE=3`, `MAX_WIDTH=2000`, `JPEG_QUALITY=85`.

Key request params: `temperature: 0.1`, `chat_template_kwargs: { enable_thinking: false }`,
`max_tokens: 3000`, images sent with `detail: high`.

## How to run

- **Web app:** `start.bat` (installs deps if missing, launches server, opens browser).
- **Batch validation:** `run-batch.bat` (all plans) or `node scripts/batch.js --only NAME`
  / `--limit N` / `--dir "C:\path"`.

## Field reference (what the model returns → calculator)

| JSON field | Calculator input | Notes |
|---|---|---|
| length, width | Length/Width (m) | overall **bounding-box** internal dims (swimout/wing included) |
| floor_area_override | Floor Area Override (m²) | **0 = use L×W.** Real floor slab for a LARGE non-rectangle; scales floor steel by `min(1, override/((L×W)−bench))`. See below. |
| shallow_depth, deep_depth | depths (m) | default 1.2 / 1.8 |
| benches_m2, beam_m2 | areas (m²) | default 0 |
| lacing_spacing_mm | Lacing | **150/200/300 only** — hardest field |
| crossways_mm | Crossways | **150/200/300 only** — hardest field |
| lengthways_mm | Lengthways | **150/200/300 only** — hardest field |
| kicker_bars_m | Kickers /lm | default ~12 |
| intermediates_m | Intermediates /lm | default ~15 |
| single_tile_beam | (removed from UI) | always "yes" — standard STB build; no longer shown/editable |
| extra_features[] | (drives extra_bars_count) | auto-detected special features, each with estimated 6m bars + basis |
| extra_bars_count | Extra Bars (6m) | **sum of extra_features**, rounded; editable in UI |

### Extra bars auto-detection (replaces manual entry)
Complicated plans need bars the standard takeoff doesn't model; previously entered by hand in
"Extra Bars (6m)". The model now itemizes special features it sees and estimates 6m bars for each:
steps/stairs, attached spa, swimout/ledge/beach, bored/cast piers (per pier), raised/infinity/spillover
edge, acrylic/glass windows, sharp/re-entrant corners, extra skimmers, equipment pads. `lib/extract.js`
sums `estimated_6m_bars` into `extra_bars_count` deterministically; the UI shows an editable breakdown
(feature → bars → basis) so the estimator can verify and adjust each line.

## Accuracy findings

Validated against the plans by reading them directly (no labelled ground truth existed). Highlights:

- **Spacings — the model reads real values, it does not just default.** Confirmed against drawings:
  - `10021` wall section shows **S12-250 EW** → model returned 250/250/250. ✓ (250 is real; the old
    calculator only offered 150/200/300 — added 250 + auto-inject for any value.)
  - `Von Arx` size schedule "up to 9.0m → S12@300 EW"; ~7–10m pool → 300/300/300. ✓
  - `23-2128` (12.5m) → lengthways 200 / crossways 300 — matches the "9.1–12.5m" schedule row. ✓
  - `CE_258316` depth schedule, 1.5m pool → row 1301–1800 → **vert 180 / horiz 220**. ✓ (after fixing
    the model's tendency to grab the table's *maximum* row).
- **Spacings come from a SCHEDULE TABLE** keyed by length/area *or* depth/wall-height — match the row to
  the pool's actual value, never the max. Engineer terms map: longitudinal→lengthways,
  transverse→crossways, vertical wall→lacing, "EACH WAY/EW"→all three equal.
- **Dimensions:** recovered via page selection where the pool sheet sits deep in a multi-page set
  (e.g. Erica St, 58 Channel). A few full engineering sets still return length/width 0 — those defer
  set-out to architectural sheets not in the PDF, or have a garbled text layer. The harness returns 0
  honestly (UI warns and asks for manual L/W) rather than guessing; spacings/extra-bars still extract.

### Final batch result (24/24 succeeded)
- 16/24 returned full length×width; 8 returned 0. ~Half of those zeros are CORRECT (notes-only sheet,
  Form-15 certificate, a non-pool proposal doc, or set-out deferred to the architect — and in the
  deferred cases spacings still came through, e.g. 10021=250, CE_258316=180/220). The genuine misses
  (ING 25-055, Engineers Plans, 25-32812) have dims only on architectural sheets or a garbled text layer.
- Spacings were read (not defaulted) and validated against the drawings: 250, 200/300, 180/220, 300 EW.

### Known limitations / next steps
- Genuine dimension misses: raising `MAX_PAGES` or adding OCR could help; manual L/W entry (UI warns)
  is the current workaround.
- `temperature 0.1` gives small run-to-run variation on borderline reads; acceptable for review-then-confirm.
- pdf.js prints harmless `TT: undefined function` / font warnings on some PDFs — cosmetic.
