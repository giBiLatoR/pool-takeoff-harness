# Pool Takeoff Harness 🏊

AI harness for JJZ steel pools: reads pool construction PDF plans, extracts steel-takeoff
dimensions with a local vision model, and fills the steel-bar calculator.

## Quick start
```
start.bat            # installs deps if needed, runs the server, opens the browser
```
Then drop a PDF plan in the upload zone and click **Extract Values with AI**.
Review the filled fields (especially Length/Width and spacings), then **Calculate Steel Bars**.

After extraction the UI shows **which pages the AI read** (e.g. "read page 3 of 21"). If it read the
wrong sheet, type the correct page number(s) under **📄 Pages Read** and click **Re-extract from
page(s)** — handy when the dimensioned pool plan sits deep in a big set.

Requires the local vision model API running at the `API_BASE_URL` in `.env`
(default `http://192.168.1.127:8080`, llama.cpp, OpenAI-compatible).

## Validate against all plans
```
run-batch.bat                       # all PDFs in the plans folder
node scripts/batch.js --only Von Arx
node scripts/batch.js --limit 3
node scripts/batch.js --dir "C:\some\folder"
```
Writes `results/<plan>.json` (full values + calc + which pages were read) and `results/_summary.json`.

## Accuracy feedback loop
In the web UI, after reviewing/fixing the extracted values, click **💾 Save as Correct**. This stores
the AI output vs your corrected values in `results/feedback/`. Then:
```
node scripts/accuracy.js     # per-field exact / within-5% / mean-error, AI vs your corrections
```
Use it to measure whether prompt changes actually improve accuracy over time.

## Tests
```
npm test                     # locks the steel calculator math (lib/calc.js)
```

## How it works
PDF → pick the most relevant pages (pdfjs text scan) → render with pdf-to-img → vision model →
JSON (dimensions, spacings, auto-detected extra-bar features) → steel calculator.

Full details, the exact prompt rationale, and accuracy findings: **[METHODOLOGY.md](METHODOLOGY.md)**.
Session state / where to pick up: **[HANDOFF.md](HANDOFF.md)**.

## Gotchas (already handled, don't undo)
- The model is a **reasoning model** — requests must send `chat_template_kwargs:{enable_thinking:false}`
  or it returns empty content. (`lib/extract.js`)
- **sharp cannot render PDFs** on this machine — `pdf-to-img` does the rasterizing.

## Config (`.env`)
`API_BASE_URL`, `VL_MODEL`, `PORT`. Render tuning: `MAX_PAGES`, `MAX_SCAN`, `RENDER_SCALE`,
`MAX_WIDTH`, `JPEG_QUALITY`.
