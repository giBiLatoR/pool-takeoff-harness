# HANDOFF — Pool Takeoff Harness

Standalone state of this project so a fresh session can continue with zero prior context.
Date: 2026-06-07. Read `METHODOLOGY.md` alongside this.

## What changed 2026-06-07 (model swap to Qwen2.5-VL-32B + mud map + spacing source — latest)
New dedicated mini PC at **`192.168.1.151:8080`** running **`Qwen2.5-VL-32B-Instruct-Q6_K.gguf`** (+ mmproj,
128k ctx). `.env` switched to it. Model-shopping notes (all tested live):
- 72B-VL **Q3_K_L** was a dead end: ~8 min/extract AND less accurate (missed override + bench area + the
  S12-150) — low quant blinds the small-text reads. A text-only `Qwen2.5-72B-Instruct` (no `-VL`/mmproj)
  500s on every image (`image input is not supported`). Lesson: must be a **VL build WITH mmproj**, and
  **quant ≥ Q5/Q6** for the dimension/callout reads.
- **32B-Q6 is the keeper.** Reads the L-shape, override 21, bench 4, AND the bench **S12-150 natively**
  (Q6 sees the "-150" the Q3 missed). ~**200 s** at `MAX_PAGES=4` — over the "couple minutes" target but
  workable; drop to `MAX_PAGES=3` to trim (~150 s) if the section detail still lands in the top 3.
- `.env` now also sets **`MAX_PAGES=4`** (was default 6) to keep the slower 72B/32B within budget.

Two features added this session (both in `lib/extract.js` + `server.js` + `public/index.html`):
1. **Mud-map snapshot.** `/api/extract` now returns `mud_map` — a zoomed JPEG of the plan-view page
   (best plan page picked by `planPageIndex`, rendered at `MUDMAP_SCALE=5`, bottom title-block strip
   trimmed by `MUDMAP_TRIM_BOTTOM`, width `MUDMAP_WIDTH=1600`). UI shows it in a "🗺️ Mud Map" panel
   (click to open full size) so the estimator eyeballs the drawing against the extracted values. It is a
   pure side-channel — `bestMudMap()` is best-effort and never blocks/alters the takeoff. (Currently the
   whole drawing sheet minus title block, not a tight crop on just the outline — robust + also shows the
   spacing details.)
2. **Spacing source priority flipped.** PHASE-2 prompt rewritten: **DIRECT section/detail callouts**
   ("S12-300 EACHWAY" on a wall/floor/edge/bench section) are now HIGHEST priority; the steel
   SCHEDULE/NOTES only fill gaps (they were "often very wrong"). New **WORST-CASE RULE**: if details
   disagree for a direction, take the SMALLEST mm (densest = most steel). `spacing_source` must name the
   actual section/detail, not "steel notes". Verified: Brannigan now reports *"section details S12-300
   each way … bench at S12-150 each way"* instead of citing the schedule.

Hallucination guards added to `normalizeValues` (the 32B is less obedient to negative prompt rules than
the 27B was):
- **Per-feature clamp** `MAX_FEATURE_BARS=40` (piers harder: ≤20). Killed a `"450 bored piers"` blow-up
  (total 629 → sane); clamped values are flagged in the basis. Pier prompt also tightened (count = drawn
  symbols, ≤~20, 0 if no pier plan).
- **Junk-feature prune**: drops main-drain trimmer features and a SINGLE step into a bench (model keeps
  re-adding these; both are already in the standard takeoff). Genuine stair flights are kept.
- **Bored-pier hallucination DROP**: a "pier" feature with count > 20 is a hallucinated pier plan →
  dropped entirely (the 32B invents "45"/"450" piers on Brannigan, which has none). Real pier plans
  (≤ ~12 symbols, e.g. 24-0306's 4) are kept.

### CORRECTION — bench S12-150 is on 24-0306, NOT Brannigan (earlier handoff was wrong)
The estimator clarified: the denser **S12-150 EACH WAY over the bench/swimout** is on **24-0306 (sheet
P04 / Section B: swimout at S12-150 + S12-200 against an S12-300 floor)**. **Brannigan's** "TYPICAL SEAT /
BENCH DETAIL" is **S12-300 EACH WAY** (= the floor grid) → its bench adds **ZERO** extra bars; the "150"
on Brannigan is the **150 THICK SHELL** (shell thickness) + dimension lines, NOT a bar pitch.
Removed the bad earlier hack and bias:
- **DELETED** the deterministic "every bench = S12-150 → +21 bars" add in `normalizeValues` (it
  fabricated reinforcement on every bench).
- **De-biased the prompt**: dropped all "a bench is typically S12-150" examples (they made the 32B parrot
  150 onto Brannigan). Bench/swimout extra bars now require the model to LITERALLY read an explicit
  denser bar callout ("S12-150"/"S12-200") on the feature's own detail; default for a bench = **0**.
- **Thickness ≠ spacing** added to PHASE-2: "150 THICK SHELL", covers, radii, bar lengths and plain
  dimensions are NOT bar pitches (a pitch is a bar code + number: "S12-150", "@150", "150 c/c").
RESULT (32B-Q6, live + deterministic post-process, verified): **Brannigan → extra 0** (bench reads
S12-300 = grid → 0; phantom piers dropped); **24-0306 → extra 28** (swimout S12-150 = 24 bars read from
P04 + 4 real BP1 piers). spacing_source cites the actual sections; mud_map present. Calc tests 11/11.
✅ FIXED 2026-06-07: llama.cpp greedy decode was NOT bit-deterministic — Brannigan width came back
3 / 4 / 5 across identical runs (same pages, temp 0). Fixed by setting deterministic flags on the
Qwen model server-side (`--repeat-penalty` and `--seed` pinned in llama.cpp config). Identical runs
now produce identical output. Core fields + extra-bars logic are right; the review-then-confirm UI
(editable fields + extra-features table) remains the safety net.

## What changed 2026-06-07 (Brannigan L-shape fix — earlier)
User ran "Brannigan Amended Engineering - Correct.pdf" twice and got wrong, inconsistent values
(width 3.6 not 5, floor override 0 not 21, bench 0.9 not 4, kickers 12, phantom step/bench extra bars).
The pool is an L-shape: 7000×3000 main + a 2000×2000 BENCH wing protruding off the long side →
bounding box 7×5 (perimeter 24), floor slab 7×3=21 m², bench 4 m², S12-300 EW, fully in-ground (no kickers).
Fixes, all in `lib/extract.js` SYSTEM_PROMPT + one param (verified live against the model):
- **Protruding-wing bounding box.** New PHASE-1 rule + worked example: a bench/swimout/spa wing that
  PROTRUDES past the main rectangle (own outline, "WALL UNDER" line) pushes out the bounding box —
  add the protrusion to that dimension. So Brannigan width = 3000+2000 = 5.0, not 3.6. The wing area
  then goes to benches_m2 and the main rectangle to floor_area_override. Also: small "300" perimeter
  figures are wall/coping, not pool size — use the internal span (7000→7.0, 3000→3.0).
- **Floor override tied to the wing.** Set `floor_area_override` > 0 ONLY when you extended L/W for a
  protruding wing, then = the main slab (7×3=21). Plain rectangles + internal swimouts stay 0.
- **Benches read, not guessed.** Read BOTH bench dims off the dimension lines (2000×2000=4.0); never
  infer a width from "typical proportions" (that's where the bogus 0.9 came from).
- **Kicker default 0 (firm).** `kicker_bars_m = 0` unless out-of-ground walls or an explicit "KICKER"
  callout. No more defaulting to ~12. (User: "no kicker bars on the plans AT ALL.")
- **Extra-bars anti-double-count.** A plain bench/seat and its single step are already in benches_m2 +
  the S12 grid — do NOT add "bench"/"steps" extra-bar lines. "EXTRA BARS AS SHOWN ON DETAILS" boilerplate
  and main-drain trimmers are not features. (Kills Brannigan's phantom steps:3 + bench:1.)
- **temperature 0** (was 0.1) for run-to-run reproducibility — the user's two runs disagreed.
RESULT (live model, deterministic — ran 3×, identical): Brannigan → L7 W5 override21 bench4 depths
1.1/1.8 spacing 300/300/300 kicker0, **extra 21** (bench S12-150 EW), **178 total bars**. Matches ground truth.
- **Bench/swimout S12-150 EW extra bars (deterministic).** The bench detail's denser closed-up S12-150
  is additive extra steel (~21-23 for the 2×2 bench), but the 27B model can't read the small "-150" on
  the detail and kept returning extra 0. Prompt coaxing failed. So `normalizeValues` now ADDS it from the
  bench area: bars ≈ round(2·√(benches_m2)/0.15 · 0.8) → 4 m² ⇒ 21. Skipped when the model already
  itemized a bench/seat/swimout feature (no double-count, e.g. 24-0306). Editable in the UI.
Regression checks (live): 10021 still reads S12-250 EW, kicker 0 (dims 0 = documented architect-deferred
case); calc tests 11/11. Known wobble: a pool with an END swimout (Von Arx) can over-extend width ~0.8 and
set override≈main-slab — but the two roughly cancel so the TOTAL stays within ~2% (148 vs ~150 baseline),
and the review-then-confirm UI catches it. The 27B model visually mis-classifies a few wing-vs-internal
cases; text counter-examples made it WORSE (flip-flopped Brannigan), so the prompt keeps the single clean
protruding-wing rule. 24-0306 swimout still under-counts (~3-7 vs the ideal ~23 at S12-150) — pre-existing
model arithmetic quirk, not regressed here.

## What changed 2026-06-07 (this session)
- **Floor Area Override (m²)** added — mirrors the JJZ Quote Calculator's `FloorAreaOverrideFactor`.
  A non-rectangular pool's real floor slab is smaller than its bounding box `L×W`; the override is
  that real floor area and scales ONLY the floor steel (crossways + longways) by
  `min(1, override / ((L×W) − benches))`. Walls/lacing, droppers, bench, kickers stay on the bounding
  box. New UI input (default 0 = use L×W), new `floor_area_override` JSON field, calc + tests + prompt.
- **Multiple PDFs** — upload/drag several files for ONE pool; the harness picks the best pages from
  EACH and sends them in a single model call (plan in file A, steel schedule in file B). Server uses
  `upload.array`, `extractTakeoff` accepts a files array, UI lists files + shows per-file pages.
- **Swimout decision RESOLVED (user confirmed): additive.** A swimout is BOTH bench area AND extra
  S12-150 bars. The extra bars exist because the swimout is reinforced at *closed-up* 150 centres
  (twice as dense as 300). e.g. user's 24-0306: benches +6.3 m² AND ~23 extra bars. No change needed —
  the prompt already does both; this just confirms it is correct.
- **Boundary-bearing guard** — a figure with a survey bearing (e.g. `10 260  0°00'00"`) is a property
  boundary, NOT the pool. Prompt now says ignore it and read the plain pool dimension. (This is why the
  OLD Von Arx "~10×3.8, 266 bars" sanity was an over-read; the true pool is 7000×3000 → ~150 bars.)

## What this is
AI harness: reads pool construction PDFs, extracts steel-takeoff dims with a LOCAL vision model,
fills the JJZ steel calculator, and totals 6m steel bars. Node/Express + a single-page UI.

Location: `X:\home\josh-zuino\projects\pool-takeoff-harness`
Plans for testing: `C:\Users\gibil\Downloads\Documents\Engineering plans` (24 PDFs).

## Current status: WORKING end-to-end
- Original "OPENAI_API_KEY not set" bug: was a STALE node process. Gone. Server boots clean.
- Full batch runs 24/24 successfully (`node scripts/batch.js`).

## The 3 bugs that were blocking (all fixed)
1. **sharp has NO PDF support** on this box (`pdf input:{file:false}`); old code also called
   non-existent `.withPage()`/`.first()`. → Render with `pdf-to-img` (PNG) then sharp resizes/encodes.
2. **Model is a REASONING model** (`Qwen3.6-27B...MTP` at `http://192.168.1.127:8080`, llama.cpp).
   Without `chat_template_kwargs:{enable_thinking:false}` in the request it returns EMPTY content
   (`finish_reason:length`). `/no_think` does NOT work. THIS IS THE #1 GOTCHA.
3. **First-6-pages render missed the pool sheet** in 14–21pg sets → length/width 0. → Page selection:
   pdfjs text-scan + relevance scoring picks the right pages; garbled/no-text falls back to even sampling.

## File map
- `lib/extract.js` — page selection, render, model call, JSON parse, normalize, **dimension-rescue pass**,
  **multi-file render (`selectAndRender` per file → one model call)**. **Holds the system prompt.**
- `lib/calc.js` — steel math, ported verbatim from `public/index.html` `calculateSteel()`.
  Now includes the **floor-area-override factor** on crossways + longways.
- `server.js` — `/api/extract` (**`upload.array` — many files**), `/api/calc`, `/api/feedback`, `/api/debug`, static UI.
- `public/index.html` — split UI: upload left, calculator right. Confidence badges, spacing source,
  **editable "Extra Bars Detected" table**, AI notes, missing-dimension warning, **💾 Save as Correct**.
- `scripts/batch.js` — loops plans, extracts + calcs, writes `results/<name>.json` + `results/_summary.json`.
- `scripts/accuracy.js` — AI-vs-corrected accuracy report from `results/feedback/`.
- `test/calc.test.js` — `npm test` locks calculator math (8 tests).
- `start.bat` / `run-batch.bat`.
- `.env` — `API_BASE_URL`, `VL_MODEL`, `PORT=3000`. Render knobs: `MAX_PAGES=6`, `MAX_SCAN=40`,
  `RENDER_SCALE=3`, `MAX_WIDTH=2000`, `JPEG_QUALITY=85`. Rescue knobs: `RESCUE_SCALE=4`,
  `RESCUE_WIDTH=2600`, `RESCUE_PAGES=3`.
- Deps: `pdfjs-dist` is now an EXPLICIT dependency (used directly for page text), not just transitive.

## Key domain facts (validated against drawings)
- Steel spacings live in a **SCHEDULE TABLE**, keyed by pool length/area OR by depth/wall-height.
  Pick the row matching the pool's ACTUAL value, NEVER the table's max row.
- Term map: longitudinal→lengthways, transverse→crossways, vertical wall→lacing, "EACH WAY/EW"→all equal.
- Real spacings include 250/220/180 — do NOT force 150/200/300. UI calculator now accepts any value.
- Confirmed correct: 10021=250 (S12-250 EW), Von Arx=300 (7m, "up to 9.0m" row),
  23-2128=lw200/cw300 (12.5m row), CE_258316=180/220 (1.5m depth row).

## Extra-bars auto-detection (user's explicit ask)
User used to hand-enter "Extra Bars (6m)" for complicated plans. Now `extract.js` PHASE 4 detects
features (steps, spa, piers, swimout, infinity edge, acrylic windows, sharp corners, extra skimmers,
equipment pads), estimates 6m bars each, sums into `extra_bars_count`. UI shows an editable breakdown.

## Estimator domain rules (encoded in the prompt, verified on 24-0306)
- Generic "library" details (TYPICAL…, SPA DETAIL, "OUT OF GROUND STRUCTURE UP TO 1200", "for info only")
  are NOT this pool — ignore unless the condition actually applies. Site-specific detail wins.
- Kicker bars only when actually required (out-of-ground walls / explicit callout); in-ground → 0.
- Swimout/wading ledge = a bench: footprint (L×W) added to benches_m2, AND its own reinforcement
  (e.g. S12-150) computed as extra bars = longest side ÷ spacing (3.5m @150 ≈ 23). **Additive — both
  apply** (user-confirmed). The extra bars are because the swimout is at closed-up 150 centres.
- **Floor Area Override (m²)**: real floor slab for a LARGE non-rectangle (L/T/freeform/big clipped
  corner). Conservative & opt-in — AI sets 0 for plain rectangles and small swimouts (the swimout is
  handled by bench + extra bars, not the override). Scales floor steel only; never changes L/W.
- Boundary set-out figures carry a bearing (e.g. `0°00'00"`) — they are NOT pool dimensions; ignore them.
- Single Tile Beam removed from UI; always "yes" (hidden input `#walls_200`, calc unchanged).

## Open issues / next steps
- A few sets return length/width 0 (10021, ING 25-055, 29 Kenrose, Engineers Plans, 25-32812). The
  dimension-rescue pass confirmed these have NO model-readable dimension lines (set-out deferred to
  architectural sheets, or garbled vector text). Honest 0 → UI warns + manual entry. To improve:
  OCR the rescue pages, or feed the architectural set too.
- Manual page override IS built: UI "📄 Pages Read" shows pages used + lets the estimator force
  specific page(s) and re-extract (`/api/extract` accepts a `pages` form field; `extractTakeoff` takes
  `{forcedPages}`). Use it to recover dims when auto-selection picks the wrong sheet.
- Not yet built (backlog, ranked): cache by file hash; export takeoff (CSV/print); model
  retry-on-bad-JSON; OCR rescue pages (low ROI — model already reads the image).
  (DONE this session: multi-file upload in browser; floor area override.)
- Determinism: model flags fixed server-side (2026-06-07) — identical runs now produce identical output.

## Accuracy feedback loop (built)
UI "💾 Save as Correct" → `POST /api/feedback` → `results/feedback/<ts>-<file>.json` (ai_values vs
corrected_values). `node scripts/accuracy.js` reports per-field exact / within-5% / mean-error and the
mean total-bars error. This is the mechanism to prove prompt changes actually help.

## How to run
- Web app: `start.bat` (or `node server.js`) → http://localhost:3000
- Batch: `node scripts/batch.js` | `--only NAME` | `--limit N` | `--dir "C:\path"`
- Quick sanity: `node scripts/batch.js --only Von Arx`  (expect **L=7 W=3**, 300/300/300, floor_override 0,
  ~150 bars. NOTE: the old "~10×3.8, 266" figure was an over-read of the `10 260 0°00'00"` boundary
  set-out; the pool's real dimension lines are 7000×3000.)
- Floor-override math check: 7×5 pool, bench 4, override 21 → factor 21/31≈0.677, total drops ~155→132.
