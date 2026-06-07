require('dotenv').config();
const fs = require('fs');
const sharp = require('sharp');
const { OpenAI } = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'not-needed',
    baseURL: `${process.env.API_BASE_URL || 'http://192.168.1.127:8080'}/v1`
});

const MAX_PAGES = parseInt(process.env.MAX_PAGES || '6', 10);
// Total image cap when several PDFs are uploaded together (plan in file A, steel detail in file B).
// Pages are shared across files so the single model call stays a sane size.
const MAX_TOTAL_PAGES = parseInt(process.env.MAX_TOTAL_PAGES || '8', 10);
const RENDER_SCALE = parseFloat(process.env.RENDER_SCALE || '3');
const MAX_WIDTH = parseInt(process.env.MAX_WIDTH || '2000', 10);
const JPEG_QUALITY = parseInt(process.env.JPEG_QUALITY || '85', 10);
const MODEL = process.env.VL_MODEL || 'qwen2.5-vl-72b-instruct';
// Dimension-rescue pass (only fires when the main pass returns length/width 0):
const RESCUE_SCALE = parseFloat(process.env.RESCUE_SCALE || '4');   // higher DPI so small dim text is legible
const RESCUE_WIDTH = parseInt(process.env.RESCUE_WIDTH || '2600', 10);
const RESCUE_PAGES = parseInt(process.env.RESCUE_PAGES || '3', 10);
// Mud-map snapshot (the dimensioned plan view, shown on the output page for visual sanity-check):
const MUDMAP_SCALE = parseFloat(process.env.MUDMAP_SCALE || '5');         // high DPI so dim text stays legible
const MUDMAP_WIDTH = parseInt(process.env.MUDMAP_WIDTH || '1600', 10);    // output image width (px)
const MUDMAP_TRIM_BOTTOM = parseFloat(process.env.MUDMAP_TRIM_BOTTOM || '0.16'); // drop bottom title-block strip
// Safety cap on any single auto-detected feature's 6m-bar estimate (guards model hallucinations like
// "450 bored piers"). A dense-spaced swimout/bench tops ~30; piers are 1 each (realistic ≤ ~20).
const MAX_FEATURE_BARS = parseInt(process.env.MAX_FEATURE_BARS || '40', 10);

// ---- System prompt (the "harness") ----
const SYSTEM_PROMPT = `You are a senior steel pool estimator with 20+ years experience reading Australian swimming pool construction drawings.
Your job is to analyze pool plans and extract precise measurements for steel takeoff calculations.

## SITE-SPECIFIC vs GENERIC DETAILS (read this first)
Engineering sets mix THIS pool's site-specific details with GENERIC standard "library" details that
appear on every job "just in case". Only extract steel for conditions that actually apply to THIS pool.
- GENERIC / IGNORE-unless-applicable: anything titled "TYPICAL ...", "STANDARD ...", "SPA POOL DETAIL",
  "POOL WALL SECTION FOR OUT OF GROUND STRUCTURE UP TO ____", "HALF SECTION", "EXPANSIVE CLAY ...",
  or sheets noted "for information only / standard drawings". These describe POSSIBILITIES, not facts.
- SITE-SPECIFIC / USE: the dimensioned plan view, the pier/set-out plan, and sections that carry this
  pool's actual dimensions and reinforcement. When a site-specific detail conflicts with a generic one,
  the site-specific detail wins.
- Example: an "out of ground structure up to 1200" section is generic. If the plan does NOT show the
  pool sitting out of the ground, do NOT add kicker bars or extra steel for that condition.

## STEP-BY-STEP EXTRACTION PROCESS:

### PHASE 1: Pool Dimensions (from PLAN VIEW)
Look at the main plan view showing the pool shape. Extract:
1. **Length (m)** - Overall internal length of pool (longest dimension). Read overall dimension lines.
2. **Width (m)** - Overall internal width of pool (shorter dimension).
   >>> ALWAYS prefer real dimension lines / set-out figures shown anywhere (plan view, sections,
       set-out notes). Use them even if the sheet ALSO says "refer to architect for set out" — that
       note is boilerplate and does NOT mean there are no dimensions.
   >>> The ONE thing to avoid: do NOT mistake a schedule's MAXIMUM/LIMIT size for this pool's size,
       e.g. "MAX 16.7m x 7m", "SHALL NOT EXCEED 15m", "UP TO 9.0m (45m²)". Those are design limits.
       Only set length/width to 0 (confidence "low") if the document contains NO numeric pool
       dimensions at all (e.g. a pure structural-notes sheet with no dimensioned drawing).
   >>> ALSO ignore SURVEY / BOUNDARY set-out figures, which are shown with a BEARING such as
       "10 260  0°00'00"" or "40 234  270°00'00"". A number paired with a degrees-minutes-seconds
       bearing is a property-boundary line, NOT the pool. The pool's own size is the plain dimension
       (e.g. "7000", "3000") on the pool outline. Use those.
   >>> Read length & width as the overall BOUNDING BOX: the largest extent of the pool in each
       direction. CRITICAL — a bench / seat / swimout / wading ledge / sun shelf / spa that PROTRUDES
       beyond the main rectangle (a wing sticking out one side, usually drawn as its own smaller
       outline with a "WALL UNDER" / dashed line where it meets the main pool) PUSHES OUT the bounding
       box. You MUST add that protrusion to the dimension it sticks out along. Do NOT report only the
       main rectangle.
       WORKED EXAMPLE (an L-shaped pool, common in this set): a 7000 long × 3000 wide main pool with a
       2000 × 2000 BENCH wing protruding off the long (bottom) side → length = 7.0, WIDTH = 3000 + 2000
       = 5.0 (NOT 3.0/3.6). Reporting width 3.6 here would be WRONG — it ignores the wing. The wing's own
       4.0 m² then goes in benches_m2, and the 7×3 = 21 m² main slab goes in floor_area_override (2b).
       A swimout/ledge that stays WITHIN the rectangle's outline (no edge steps out) does NOT change L/W;
       it is benches_m2 only and floor_area_override stays 0.
   >>> Small perimeter figures such as "300" sitting OUTSIDE the main dimension line are WALL / COPING
       thicknesses, NOT pool size. Use the pool's internal dimensioned span (e.g. 7000 → 7.0, 3000 →
       3.0), then add any protruding wing as above. Item 2b below is a SEPARATE optional value and must
       NOT change how you read length or width.
2b. **Floor Area Override (m²)** - OPTIONAL. Default 0. Leave 0 for almost every pool.
   >>> Set a non-zero value ONLY for a pool whose floor is a LARGE non-rectangle — a pronounced L-shape,
       T-shape, freeform, or a big clipped/angled corner — where the Length×Width bounding box clearly
       overstates the real floor slab. Then set it to the actual floor-slab area read from THIS plan
       (sum the real floor rectangles; exclude any swimout/bench footprint, which goes in benches_m2).
       It must be LESS than Length×Width.
   >>> Set floor_area_override > 0 ONLY when you ALSO extended L or W for a wing PROTRUDING OUTSIDE the
       main rectangle (the L/T case above) — then it equals the MAIN floor rectangle. Example: bounding
       box 7×5 = 35 m², bench wing 4 m² → floor_area_override = the 7×3 = 21 m² main slab (NOT 35, NOT 0).
       A plain rectangular pool — INCLUDING one with an INTERNAL swimout / ledge / step inside the
       rectangle — keeps floor_area_override = 0 (that swimout is benches_m2 only, and never changes L/W).
       Never set floor_area_override if you did not extend L or W.
   >>> For a plain rectangular pool, a rectangle with only a small swimout/bench, or whenever you are
       unsure → floor_area_override = 0. When 0, the calculator just uses Length×Width. Reading length
       and width is unchanged; this value never overrides them. Do NOT copy numbers from these notes.
3. **Shallow End Depth (m)** - From elevation/section/depth notes. Default: 1.2m
4. **Deep End Depth (m)** - From elevation/section/depth notes. Default: 1.8m
5. **Benches Area (m²)** - From bench callouts, e.g. "BENCH 2400x900" = 2.4*0.9 = 2.16m².
   >>> A SWIMOUT / WADING LEDGE / SUN SHELF / BEACH ENTRY COUNTS AS A BENCH. Add its footprint area
       (length x width, e.g. a 3.5m x 1.8m swimout = 6.3 m²) to benches_m2. Sum all benches + swimouts. Default 0.
   >>> Read BOTH bench dimensions off the plan's dimension lines — a bench/seat wing is fully dimensioned
       (e.g. 2000 × 2000 = 4.0 m²). NEVER invent a bench width from "typical / standard proportions". If
       one side looks undimensioned, find its dimension line (it shares the wing's own outline). A guessed
       0.9 m² for a clearly 2×2 m wing is WRONG — it must read 4.0 m².
6. **Beam Area (m²)** - From beam/coping/extra-reinforcement notes. Default 0.

### PHASE 2: Steel Spacing Details (CRITICAL - from STRUCTURAL/STEEL DETAILS)
This is the most important part. Spacings come from steel detail drawings/notes/schedules, NOT the pool outline.

HOW SPACINGS ARE SHOWN — and WHICH TO TRUST. The general STEEL NOTES / generic schedule are OFTEN WRONG
for this pool; the REAL reinforcement is the callout written ON the wall/floor SECTION & DETAIL drawings.
Read in THIS priority (do NOT default to the notes):
(A) **DIRECT CALLOUTS on the actual SECTION / DETAIL drawings** — HIGHEST PRIORITY, this is THIS pool's
    real steel. The spacing written on a wall section, floor section, edge/beam detail, deep-end section,
    bench detail, e.g. "S12-300 EACHWAY", "S12-150", "N12 @ 200 c/c", "S12 AT 300 CRS". Read EVERY section
    and detail (A, B, edge, bench, deep end, shallow end) — they can carry DIFFERENT spacings. Prefer
    these over any note or schedule.
(B) **STEEL SCHEDULE TABLE** keyed by pool SIZE or DEPTH — use to FILL GAPS or confirm, NOT to override a
    detail callout. Pick the row matching THIS pool's ACTUAL value, NOT the largest/last row:
      "UP TO 9.0m LONG (45m²) -> S12 AT 300 EACH WAY";  "9.1-12.5m -> S12@200 LONG & S12@300 TRANSVERSE"
      depth table: "WALL HEIGHT 1301-1800 -> VERT S12@180, HORIZ S12@220" (use the pool's ACTUAL depth row).
      In a VERT/HORIZ table: VERT -> lacing; HORIZ -> crossways AND lengthways.
(C) **General structural NOTES** stating a spacing — LOWEST priority, often generic boilerplate. Use ONLY
    when no section/detail and no schedule give a value. Do NOT cite the notes as the source when a
    section/detail callout exists.

>>> WORST-CASE RULE (conservative — never under-estimate steel). If DIFFERENT details give DIFFERENT
    spacings for the SAME direction (e.g. one wall section S12-300 but the deep-end section S12-200), take
    the SMALLEST mm — the DENSEST = the WORST case = the MOST bars — for that direction. Smaller number
    wins. Apply per direction (lacing / crossways / lengthways) independently.
>>> spacing_source MUST name the actual SECTION / DETAIL it came from (e.g. "Section A/S04 wall detail:
    S12-300 EACH WAY"), NOT "steel notes" — unless a note truly was the only source. If you took a
    worst-case among conflicting details, say so (e.g. "deep-end section S12-200 taken as worst case").

BAR CODE: a label like S12 / N12 / Y12 = grade+DIAMETER (12mm bar). The spacing is the OTHER number,
the one after "@", "-", "AT ___ CENTRES/CRS/c/c". Do NOT confuse bar diameter (12/16) with spacing.
A SPACING is ALWAYS a bar code PAIRED with a pitch: "S12-150", "S12 @ 150", "S12 AT 150 CRS", "150 c/c".
NOT A SPACING — never read these as a bar pitch:
  - a SHELL / SLAB THICKNESS: "150 THICK", "150 THICK SHELL", "150 SLAB", "SHELL 150". In a note like
    "S12-300 (UNO) AT 150 THICK SHELL" the spacing is 300; the 150 is the shell thickness — IGNORE it.
  - a cover ("50 COVER"), a bar LENGTH ("x 900 LONG"), a radius ("R300"), or a plain dimension on a
    dimension line ("150", "2000"). A lone number with NO bar code beside it is NOT a spacing.

TERM MAPPING (engineer term -> our field):
  - "longitudinal" / "long way" / bars running along the LENGTH      -> lengthways
  - "transverse" / "crossways" / bars running across the WIDTH        -> crossways
  - vertical wall bars / wall reinforcement in a wall section          -> lacing
  - "EACH WAY" / "EW" / "BOTH WAYS"  -> the same value for ALL THREE (lacing, crossways, lengthways)
  - if only ONE wall-section spacing is given (e.g. "S12-250"), use it for all three unless a schedule says otherwise.

7. **Lacing Spacing (mm)** - vertical wall bar spacing. Report the ACTUAL value read (e.g. 150/200/250/300). Default 300 only if nothing found.
8. **Crossways Spacing (mm)** - transverse (across width) bar spacing. Report ACTUAL value. Default 300 only if nothing found.
9. **Lengthways Spacing (mm)** - longitudinal (along length) bar spacing. Report ACTUAL value. Default 300 only if nothing found.

### PHASE 3: Additional Steel (from NOTES/SCHEDULE)
10. **Kicker Bars** per linear metre of edge. DEFAULT 0.
    >>> kicker_bars_m = 0 UNLESS this pool has OUT-OF-GROUND walls drawn sitting above ground, OR a
        section/note for THIS pool explicitly calls up "KICKER" bars by name. A fully in-ground pool with
        no kicker callout = 0. NEVER output a non-zero kicker number as a "standard" value or a guess —
        if you did not actually read a kicker callout, it is 0. Do NOT add kickers because a GENERIC
        "out of ground structure up to ____" library detail exists on the sheet. Only when genuinely
        called up: ~12 typical, up to 16 deep.
11. **Intermediates** per linear metre. Typical 10-20. ~15 standard. Default 15.
12. **Single Tile Beam** - "yes" if notes mention single tile / STB / tile beam. Default "yes".

### PHASE 4: Special Features -> EXTRA 6m BARS (auto-detect — this is normally done by hand)
The standard takeoff above covers walls, floor, lacing, crossways, lengthways, kickers, intermediates,
bench area, beam area and one skimmer. COMPLICATED plans have features that need ADDITIONAL 6m bars
NOT captured above. Scan every page (sections, details, isometrics, notes) and list each special feature
present on THIS plan with an estimate of the extra 6m bars it adds. Typical per-feature estimates (adjust
to what the plan actually shows — more flights/piers/windows = proportionally more bars):
  - Steps / stairs (per flight)................. 3 bars
  - Spa / attached spa shell.................... 5 bars
  - Swimout / wading ledge / sun shelf / beach / a BENCH or SEAT — counts ONLY if its own detail shows a
    spacing DENSER than the main floor grid.
        >>> DEFAULT for a bench / seat = NO extra bars. Most bench/seat details are reinforced at the SAME
            spacing as the floor (a detail that says "S12-300 EACH WAY" with an S12-300 floor → extra = 0;
            the bench is just benches_m2). This is the COMMON case — assume it unless proven otherwise.
        >>> Add extra bars ONLY if the feature's OWN detail LITERALLY PRINTS a denser bar callout — a bar
            code + a smaller pitch you can actually SEE written on that swimout/bench section, e.g. the
            text "S12-150" or "S12-200", AND it is smaller than the floor grid. You must be able to quote
            that exact text in the basis. NEVER assume or infer S12-150 for a bench. A "150 THICK SHELL",
            a "50 COVER", a radius, or a plain dimension is NOT a bar callout — if the only "150" on the
            detail is a thickness/dimension, the bench is NOT denser → extra = 0.
        >>> When it genuinely IS denser, COMPUTE from size + the READ spacing; "EACH WAY / EW" counts BOTH
            directions: bars ≈ (length ÷ spacing) + (width ÷ spacing). Example: a 3.5×1.8 m SWIMOUT whose
            section literally reads "S12-150" → 3.5/0.15 ≈ 23 bars (its footprint is ALSO in benches_m2).
  - Bored or cast piers (per pier).............. 1 bar each (vertical starter cage)
        >>> ONLY when a PIER PLAN or pier schedule explicitly shows pier symbols (e.g. BP1, BP2, circles
            on a set-out). COUNT = the number of pier symbols actually drawn — realistically 2-12, almost
            never more than ~20. A pool with no pier plan has ZERO piers. NEVER output hundreds of piers;
            a count like 450 is a misread — set 0 if you are not literally counting drawn pier symbols.
  - Raised beam / infinity / vanishing / spillover edge / weir trough ... 4 bars
  - Acrylic or glass window framing (per window) 3 bars
  - Re-entrant or sharp corner extra/diagonal bars (per corner) ......... 1 bar
  - Each ADDITIONAL skimmer box beyond the first 1 bar
  - Equipment pad / plant box / built-in ladder. 1 bar
DO NOT add extra-bars lines for things already counted elsewhere or that are not genuinely added steel:
  - A plain BENCH / SEAT / LEDGE and the single STEP down into it AT THE MAIN GRID spacing are ALREADY
    counted as benches_m2 (Phase 1) + the floor/wall S12 grid. Do NOT add a "bench"/"steps" line for
    them — that DOUBLE-COUNTS. EXCEPTION: if the bench/seat DETAIL calls up its OWN DENSER spacing (e.g.
    "S12-150 EW", tighter than the S12-300 grid), it IS genuine extra steel — compute it like a swimout
    (the swimout bullet above: size ÷ spacing, EACH WAY). Count STEPS as a feature only when a SEPARATE
    stair flight (several treads), not a single step into a bench/ledge.
  - A plan note "WITH EXTRA BARS AS SHOWN ON DETAILS" only tells you to GO LOOK at the section/detail
    drawings — it does NOT by itself add any bars. Read the bench/seat/swimout detail's ACTUAL spacing
    there and add extra bars ONLY if that spacing is denser than the grid (above). NEVER assume S12-150
    from the note. Main-drain trimmers ("4-S12 EACH SIDE OF DRAIN") and standard skimmer trim stay in the
    standard takeoff (not separate features).
List ONLY genuine added features. If none, return an empty list and extra_bars_count 0. A bench / seat /
swimout / step adds extra bars ONLY when you actually READ, on its detail, a spacing DENSER than the main
floor grid — then it MUST appear with its computed each-way count. A bench at the SAME spacing as the grid
(e.g. an S12-300 seat detail against an S12-300 floor — like a plain bench) adds NOTHING; return an empty
list. Never assume a denser value you did not read on the drawing.
13. **extra_features** - the itemized list above.
14. **Extra Bars** (extra_bars_count) - the SUM of estimated_6m_bars across extra_features (rounded). Default 0.

## OUTPUT FORMAT:
Return ONLY valid JSON (no prose, no markdown fences):
{
    "length": <number>,
    "width": <number>,
    "floor_area_override": <number>,
    "benches_m2": <number>,
    "shallow_depth": <number>,
    "deep_depth": <number>,
    "beam_m2": <number>,
    "lacing_spacing_mm": 300,
    "crossways_mm": 300,
    "lengthways_mm": 300,
    "kicker_bars_m": <number>,
    "intermediates_m": <number>,
    "single_tile_beam": "yes",
    "extra_features": [
        { "feature": "<name e.g. steps>", "estimated_6m_bars": <number>, "basis": "<what the plan shows>" }
    ],
    "extra_bars_count": 0,
    "confidence": {
        "length": "high/medium/low", "width": "high/medium/low",
        "floor_area_override": "high/medium/low",
        "benches_m2": "high/medium/low", "shallow_depth": "high/medium/low",
        "deep_depth": "high/medium/low", "beam_m2": "high/medium/low",
        "lacing_spacing_mm": "high/medium/low", "crossways_mm": "high/medium/low",
        "lengthways_mm": "high/medium/low", "kicker_bars_m": "high/medium/low",
        "intermediates_m": "high/medium/low"
    },
    "spacing_source": "<WHERE you found the spacing values, e.g. 'wall section detail @300 c/c'>",
    "notes": "<assumptions, unclear/missing info>"
}

## RULES:
- Convert all measurements to METRES (1 ft = 0.3048m, 1 inch = 0.0254m).
- Report the ACTUAL spacing you read (150, 200, 250, 300, etc.). Do NOT round to "standard" values — a real 250 is 250.
- Only fall back to 300 when no schedule, callout, or note gives a spacing. Mark such fields confidence "low".
- When you DID read a spacing, set its confidence "high" (direct callout) or "medium" (inferred from a size schedule), and name the source in spacing_source (e.g. "size schedule row 'up to 9.0m' -> S12@300 EW" or "wall section S12-250").
- Mark confidence "low" for any value you estimated rather than read.
- For freeform pools use the overall bounding box dimensions.`;

/** Strip Qwen <think> blocks then pull the JSON object out of model output. */
function parseModelJson(text) {
    let t = (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
    const candidates = [];
    const block = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (block) candidates.push(block[1]);
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(t.slice(first, last + 1));
    candidates.push(t);
    for (const c of candidates) {
        try { return JSON.parse(c); } catch (_) { /* try next */ }
    }
    throw new Error('Could not parse JSON from model response: ' + t.slice(0, 200));
}

const MAX_SCAN = parseInt(process.env.MAX_SCAN || '40', 10); // pages to text-scan for selection

async function encode(buf) {
    const jpg = await sharp(buf)
        .resize(MAX_WIDTH, null, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
    return `data:image/jpeg;base64,${jpg.toString('base64')}`;
}

/** Per-page text via pdfjs (transitive dep). Returns [] if no usable text layer. */
async function pageTexts(filePath) {
    try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        try {
            const { pathToFileURL } = require('url');
            pdfjs.GlobalWorkerOptions.workerSrc =
                pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
        } catch (_) { /* fake worker fallback */ }
        const opts = { data: new Uint8Array(fs.readFileSync(filePath)), isEvalSupported: false, disableFontFace: true };
        try {
            const path = require('path');
            const { pathToFileURL } = require('url');
            const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
            opts.standardFontDataUrl = pathToFileURL(path.join(pkgDir, 'standard_fonts')).href + '/';
            opts.cMapUrl = pathToFileURL(path.join(pkgDir, 'cmaps')).href + '/';
            opts.cMapPacked = true;
        } catch (_) { /* fonts/cmaps optional — only silences warnings */ }
        const doc = await pdfjs.getDocument(opts).promise;
        const texts = [];
        const n = Math.min(doc.numPages, MAX_SCAN);
        for (let i = 1; i <= n; i++) {
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            texts.push(tc.items.map(it => it.str).join(' '));
        }
        await doc.destroy();
        return texts;
    } catch (_) {
        return [];
    }
}

/** Score pages by pool-plan + steel-detail relevance; return 1-based indices to render.
 *  Returns null when there is no usable text signal (scanned or garbled font encoding),
 *  so the caller can fall back to sampling. */
function selectPageIndices(texts, budget) {
    if (texts.length === 0) return null;
    const scored = texts.map((t, i) => {
        const steel = (t.match(/(reinforc|\bS\d{2}\b|\bN\d{2}\b|\bY\d{2}\b|c\/c|centres?\b|\bcrs\b|schedule|typical|lacing|\bSL\d{2}\b|@\s*\d{2,3})/gi) || []).length;
        const plan = /(pool plan|plan view|set\s?out|coping plan|overall size)/i.test(t) ? 6 : 0;
        const dims = Math.min((t.match(/\b\d{3,5}\b/g) || []).length, 25) * 0.3;
        const section = /(section|elevation|detail)/i.test(t) ? 2 : 0;
        return { i: i + 1, plan, score: plan + steel + dims + section };
    });
    // No real signal anywhere (e.g. garbled text layer with no ToUnicode map) -> let caller sample.
    if (scored.reduce((a, p) => a + p.score, 0) < 1) return null;
    const picked = new Set();
    const bestPlan = [...scored].sort((a, b) => b.plan - a.plan || b.score - a.score)[0];
    if (bestPlan && bestPlan.plan > 0) picked.add(bestPlan.i);
    for (const p of [...scored].sort((a, b) => b.score - a.score)) {
        if (picked.size >= budget) break;
        picked.add(p.i);
    }
    return [...picked].sort((a, b) => a - b);
}

/** Evenly spread `budget` page indices (1-based) across a `total`-page document. */
function samplePages(total, budget) {
    if (total <= budget) return Array.from({ length: total }, (_, k) => k + 1);
    const out = new Set();
    for (let k = 0; k < budget; k++) {
        out.add(Math.round(1 + (k * (total - 1)) / (budget - 1)));
    }
    return [...out].sort((a, b) => a - b);
}

/** Rank pages by raw dimension density (for the dimension-rescue pass). */
function dimPageIndices(texts, budget) {
    if (!texts.length) return null;
    const scored = texts.map((t, i) => {
        const dims = (t.match(/\b\d{3,5}\b/g) || []).length;
        const plan = /(pool plan|plan view|set\s?out|overall)/i.test(t) ? 10 : 0;
        return { i: i + 1, score: plan + dims };
    });
    if (scored.reduce((a, p) => a + p.score, 0) < 1) return null;
    return scored.sort((a, b) => b.score - a.score).slice(0, budget).map(p => p.i).sort((a, b) => a - b);
}

/** Render specific 1-based page indices at a given scale/width. */
async function renderSpecificPages(filePath, indices, scale, width) {
    const { pdf } = await import('pdf-to-img');
    const doc = await pdf(filePath, { scale });
    const want = new Set(indices);
    const maxIdx = Math.max(...indices);
    const images = [];
    let i = 0;
    for await (const buf of doc) {
        i++;
        if (want.has(i)) {
            const jpg = await sharp(buf)
                .resize(width, null, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: JPEG_QUALITY })
                .toBuffer();
            images.push(`data:image/jpeg;base64,${jpg.toString('base64')}`);
        }
        if (i >= maxIdx) break;
    }
    return images;
}

/** Best 1-based page index showing the dimensioned plan view ("mud map"), or null if no text signal. */
function planPageIndex(texts) {
    if (!texts || !texts.length) return null;
    const scored = texts.map((t, i) => {
        const plan = /(swimming pool plan|pool plan|plan view|set\s?out|coping plan|overall size)/i.test(t) ? 8 : 0;
        const dims = Math.min((t.match(/\b\d{3,5}\b/g) || []).length, 25) * 0.3;
        const feat = /(bench|swim\s?-?out|main drain|skimmer|\bstep\b)/i.test(t) ? 2 : 0;
        return { i: i + 1, score: plan + dims + feat, plan };
    });
    if (scored.reduce((a, p) => a + p.score, 0) < 1) return null;
    // Prefer a page that actually says "plan"; otherwise the most dimension-dense page.
    const planned = scored.filter(p => p.plan > 0).sort((a, b) => b.score - a.score);
    return (planned[0] || scored.sort((a, b) => b.score - a.score)[0]).i;
}

/** Render a zoomed snapshot of the plan-view page (title block trimmed) as a JPEG data URL.
 *  Best-effort and side-channel only — it never blocks or alters the takeoff. */
async function renderMudMap(filePath, mimetype) {
    const isPdf = mimetype === 'application/pdf' || /\.pdf$/i.test(filePath);
    try {
        if (!isPdf) {
            const buf = await sharp(filePath)
                .resize(MUDMAP_WIDTH, null, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90 }).toBuffer();
            return { dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, page: 1, found: true };
        }
        const found = planPageIndex(await pageTexts(filePath));
        const page = found || 1;
        const { pdf } = await import('pdf-to-img');
        const doc = await pdf(filePath, { scale: MUDMAP_SCALE });
        let i = 0;
        for await (const buf of doc) {
            i++;
            if (i < page) continue;
            const meta = await sharp(buf).metadata();
            const keepH = Math.max(1, Math.floor(meta.height * (1 - MUDMAP_TRIM_BOTTOM)));
            const jpg = await sharp(buf)
                .extract({ left: 0, top: 0, width: meta.width, height: keepH })
                .resize(MUDMAP_WIDTH, null, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90 }).toBuffer();
            return { dataUrl: `data:image/jpeg;base64,${jpg.toString('base64')}`, page, found: !!found };
        }
    } catch (_) { /* best effort */ }
    return { dataUrl: null, page: 1, found: false };
}

/** Pick the best mud-map across all uploaded files (prefer a file with a real plan page). */
async function bestMudMap(files) {
    let dataUrl = null;
    for (const f of files) {
        try {
            const r = await renderMudMap(f.path, f.mimetype);
            if (r && r.dataUrl && (!dataUrl || r.found)) { dataUrl = r.dataUrl; if (r.found) break; }
        } catch (_) { /* skip */ }
    }
    return dataUrl;
}

/** Second pass focused only on pool length/width, using zoomed dimension-dense pages. */
async function rescueDimensions(filePath) {
    let idx = dimPageIndices(await pageTexts(filePath), RESCUE_PAGES);
    if (!idx) {
        const { pdf } = await import('pdf-to-img');
        const doc = await pdf(filePath, { scale: 1 });
        idx = samplePages(doc.length, RESCUE_PAGES);
    }
    const images = await renderSpecificPages(filePath, idx, RESCUE_SCALE, RESCUE_WIDTH);
    const prompt = 'These are swimming pool construction drawing pages. Find the OVERALL pool dimensions ' +
        'from the dimension lines / set-out figures. Convert to METRES (mm/1000). Return ONLY JSON ' +
        '{"length":<m>,"width":<m>}. length = longest plan dimension, width = shorter. ' +
        'Use real dimension lines only — NOT a schedule maximum like "up to 9.0m". ' +
        'If no dimension lines are visible, return {"length":0,"width":0}.';
    const r = await openai.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map(u => ({ type: 'image_url', image_url: { url: u, detail: 'high' } }))] }],
        temperature: 0, max_tokens: 300, chat_template_kwargs: { enable_thinking: false }
    });
    try {
        const v = parseModelJson(r.choices[0].message.content);
        return { length: parseFloat(v.length) || 0, width: parseFloat(v.width) || 0, pages: idx };
    } catch (_) {
        return { length: 0, width: 0, pages: idx };
    }
}

/** Select the most relevant pages of ONE file and render them to base64 jpeg data URLs.
 *  Returns { images, pages, pageCount }. `budget` caps how many pages are rendered.
 *  `forcedPages` (1-based array) overrides auto-selection — used when the estimator
 *  tells the harness exactly which page(s) to read. Non-PDFs render as a single image. */
async function selectAndRender(filePath, mimetype, budget, forcedPages) {
    const isPdf = mimetype === 'application/pdf' || /\.pdf$/i.test(filePath);
    if (!isPdf) return { images: [await encode(filePath)], pages: [1], pageCount: 1 };

    const { pdf } = await import('pdf-to-img'); // ESM-only, dynamic import from CJS
    const doc = await pdf(filePath, { scale: RENDER_SCALE });
    const pageCount = doc.length;

    let selected;
    if (Array.isArray(forcedPages) && forcedPages.length) {
        selected = forcedPages.filter(p => p >= 1 && p <= pageCount).slice(0, budget);
    }
    if (!selected || !selected.length) {
        // Prefer text-relevance selection; otherwise sample evenly across the document.
        selected = selectPageIndices(await pageTexts(filePath), budget) || samplePages(pageCount, budget);
    }

    const want = new Set(selected);
    const maxIdx = Math.max(...selected);
    const images = [];
    let i = 0;
    for await (const buf of doc) {
        i++;
        if (want.has(i)) images.push(await encode(buf));
        if (i >= maxIdx) break;
    }
    return { images, pages: selected, pageCount };
}

/** Back-compat single-file wrapper. Returns { images, pages } at the full per-file budget. */
async function renderToImages(filePath, mimetype, forcedPages) {
    const { images, pages } = await selectAndRender(filePath, mimetype, MAX_PAGES, forcedPages);
    return { images, pages };
}

/** Full extraction: render -> call model -> parse JSON.
 *  `input` may be a single file path (string) OR an array of files, where each entry is
 *  either a path string or `{ path, name, mimetype }`. When several files are given, the
 *  most relevant pages from EACH are rendered and sent in ONE model call (the plan view
 *  can live in one PDF and the steel schedule in another).
 *  opts.forcedPages = explicit 1-based page list (single-file only; skips auto-select + rescue). */
async function extractTakeoff(input, mimetype, opts = {}) {
    const path = require('path');
    // Normalize to a files array: [{ path, name, mimetype }].
    const files = (Array.isArray(input) ? input : [input]).map(f =>
        typeof f === 'string'
            ? { path: f, name: path.basename(f), mimetype }
            : { path: f.path, name: f.name || path.basename(f.path), mimetype: f.mimetype || mimetype });

    const multi = files.length > 1;
    // Page override only makes sense for a single file (it's a page list, not file:page).
    const forced = !multi && Array.isArray(opts.forcedPages) && opts.forcedPages.length ? opts.forcedPages : null;

    // Render: a lone file keeps the full per-file budget; several files share MAX_TOTAL_PAGES.
    let images = [];
    const sources = []; // [{ file, pages, pageCount }] — one entry per uploaded file
    if (multi) {
        const perFile = Math.max(2, Math.ceil(MAX_TOTAL_PAGES / files.length));
        for (const f of files) {
            const r = await selectAndRender(f.path, f.mimetype, perFile, null);
            sources.push({ file: f.name, pages: r.pages, pageCount: r.pageCount });
            for (const img of r.images) {
                if (images.length >= MAX_TOTAL_PAGES) break;
                images.push(img);
            }
        }
    } else {
        const r = await selectAndRender(files[0].path, files[0].mimetype, MAX_PAGES, forced);
        images = r.images;
        sources.push({ file: files[0].name, pages: r.pages, pageCount: r.pageCount });
    }

    const model = MODEL;
    const pageNote = multi
        ? `I've sent ${images.length} page(s) drawn from ${files.length} separate files for the SAME pool (${files.map(f => f.name).join(', ')}). The plan view (pool outline) may be in one file and the steel/structural schedule in another. Treat them as ONE job and combine the information. Examine ALL pages.`
        : images.length > 1
            ? `I've sent ${images.length} pages from this PDF. The plan view (pool outline) is on one page; the steel/structural details (lacing/crossways/lengthways spacings) may be on another. Examine ALL pages.`
            : "I've sent a single image/page.";

    const imageParts = images.map(img => ({
        type: 'image_url',
        image_url: { url: img, detail: 'high' }
    }));

    const response = await openai.chat.completions.create({
        model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `${pageNote} Analyze all pages and extract the takeoff values. Pay special attention to steel detail drawings for spacing information. Return ONLY the JSON object.` },
                    ...imageParts
                ]
            }
        ],
        // Greedy decoding (temp 0) so the same plan gives the same takeoff run-to-run.
        temperature: 0,
        max_tokens: 3000,
        // This model is a reasoning model; without this it burns all tokens in the
        // hidden thinking channel and returns empty content. llama.cpp honors it.
        chat_template_kwargs: { enable_thinking: false }
    });

    const resultText = response.choices[0].message.content;
    const values = normalizeValues(parseModelJson(resultText));

    // Dimension-rescue: if the main pass missed length/width, retry zoomed on dim-dense pages.
    // Skip when the estimator forced specific pages (respect their explicit choice).
    // With several files, try each in turn until one yields real dimensions.
    const anyPdf = files.some(f => f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.path));
    if (anyPdf && !forced && (!parseFloat(values.length) || !parseFloat(values.width))) {
        for (const f of files) {
            try {
                const r = await rescueDimensions(f.path);
                if (r.length && r.width) {
                    values.length = r.length;
                    values.width = r.width;
                    values.confidence = values.confidence || {};
                    values.confidence.length = 'medium';
                    values.confidence.width = 'medium';
                    const where = `${multi ? f.name + ' ' : ''}page(s) ${r.pages.join(',')}`;
                    values.notes = `${values.notes ? values.notes + ' ' : ''}[dimension-rescue: ${r.length}x${r.width}m from ${where}]`;
                    values.rescued_dimensions = true;
                    break;
                }
            } catch (_) { /* rescue is best-effort */ }
        }
    }

    // Back-compat fields (single-file UI + batch): for multi, flatten/sum across files.
    const pageNums = sources.length === 1 ? sources[0].pages : sources.reduce((a, s) => a.concat(s.pages), []);
    const pageCount = sources.length === 1 ? sources[0].pageCount : sources.reduce((a, s) => a + s.pageCount, 0);

    // Mud-map snapshot of the plan view for the output page (best-effort; never blocks the takeoff).
    let mudMap = null;
    try { mudMap = await bestMudMap(files); } catch (_) { /* optional */ }

    return { values, raw: resultText, pages: images.length, pageNums, pageCount, sources, mudMap };
}

/** Make extra_bars_count the deterministic rounded sum of detected extra_features. */
function normalizeValues(values) {
    // Floor area override: numeric, 0 means "use Length×Width" (plain rectangle).
    values.floor_area_override = parseFloat(values.floor_area_override) || 0;
    if (!Array.isArray(values.extra_features)) values.extra_features = [];

    // Safety pass: a single hallucinated feature (e.g. "450 bored piers") must NOT blow the takeoff.
    // A "pier" feature with an ABSURD count (> 20) is a hallucinated pier plan — DROP it entirely (a real
    // pier plan shows ≤ ~12 symbols; Brannigan has none, yet the model invents 45/450). Plausible pier
    // counts (≤ 20, e.g. 24-0306's 4) are kept. Everything else is clamped to the general ceiling.
    values.extra_features = values.extra_features.filter(f => {
        if (!f) return false;
        const isPier = /pier/i.test(f.feature || '');
        const orig = parseFloat(f.estimated_6m_bars) || 0;
        if (isPier && orig > 20) return false; // hallucinated pier plan — drop
        const cap = isPier ? 20 : MAX_FEATURE_BARS;
        const clamped = Math.max(0, Math.min(orig, cap));
        if (clamped !== orig) f.basis = `${f.basis ? f.basis + ' ' : ''}[auto-clamped ${orig}→${clamped}: implausible]`;
        f.estimated_6m_bars = clamped;
        return true;
    });

    // Drop features that are NOT separate added steel — the model keeps re-adding these despite the
    // prompt: main-drain trimmer bars (part of the standard takeoff) and a SINGLE step down into a
    // bench/ledge (already covered). Genuine separate stair FLIGHTS (several treads) are kept.
    values.extra_features = values.extra_features.filter(f => {
        if (!f) return false;
        const name = (f.feature || '').toLowerCase();
        const basis = (f.basis || '').toLowerCase();
        const isMainDrain = /\bdrain\b/.test(name) || /each side of (the )?drain/.test(basis);
        const isSingleStep = /step/.test(name) && /(single|one|1)\s*[- ]?step|step\s*(down\s*)?into/.test(basis);
        return !(isMainDrain || isSingleStep);
    });

    // NOTE: no deterministic "bench is S12-150" add here. Bench/swimout extra bars must come from the
    // ACTUAL detail spacing the model reads on the plan — and ONLY when it is DENSER than the main grid
    // (e.g. a bench detailed S12-150 against an S12-300 floor). A bench at the same spacing as the grid
    // (e.g. Brannigan's S12-300 seat detail) adds NOTHING beyond benches_m2. Assuming 150 over-counted.

    if (values.extra_features.length) {
        const sum = values.extra_features.reduce(
            (a, f) => a + (parseFloat(f && f.estimated_6m_bars) || 0), 0);
        values.extra_bars_count = Math.round(sum);
    } else if (values.extra_bars_count == null) {
        values.extra_bars_count = 0;
    }
    return values;
}

module.exports = { extractTakeoff, renderToImages, parseModelJson, normalizeValues, SYSTEM_PROMPT };
