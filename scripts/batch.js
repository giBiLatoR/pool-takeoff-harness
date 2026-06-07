// Batch extraction harness.
// Loops every PDF in the plans dir, runs AI extraction + the steel calculator,
// writes per-file JSON to results/ and a summary table.
//
// Usage:
//   node scripts/batch.js                       # all PDFs in default dir
//   node scripts/batch.js --only "Naome"        # only files matching substring
//   node scripts/batch.js --limit 3             # first N files
//   node scripts/batch.js --dir "C:\\path"      # custom dir

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { extractTakeoff } = require('../lib/extract');
const { calcSteel } = require('../lib/calc');

function arg(name, dflt) {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const DIR = arg('--dir', 'C:\\Users\\gibil\\Downloads\\Documents\\Engineering plans');
const ONLY = arg('--only', null);
const LIMIT = parseInt(arg('--limit', '0'), 10);
const OUT = path.join(__dirname, '..', 'results');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function fmt(v) {
    if (v === null || v === undefined || v === '') return '-';
    return typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v;
}

(async () => {
    let files = fs.readdirSync(DIR).filter(f => /\.pdf$/i.test(f));
    if (ONLY) files = files.filter(f => f.toLowerCase().includes(ONLY.toLowerCase()));
    if (LIMIT > 0) files = files.slice(0, LIMIT);

    console.log(`\nBatch: ${files.length} file(s) from ${DIR}\n`);
    const summary = [];

    for (const f of files) {
        const full = path.join(DIR, f);
        const t0 = Date.now();
        process.stdout.write(`→ ${f} ... `);
        try {
            const { values, pages, pageNums, raw } = await extractTakeoff(full, 'application/pdf');
            const calc = calcSteel(values);
            const ms = Date.now() - t0;
            const rec = { file: f, pages, pageNums, ms, values, calc };
            fs.writeFileSync(
                path.join(OUT, f.replace(/\.pdf$/i, '') + '.json'),
                JSON.stringify({ ...rec, raw }, null, 2)
            );
            summary.push(rec);
            const nf = (values.extra_features || []).length;
            console.log(`OK  p[${(pageNums || []).join(',')}] ${(ms / 1000).toFixed(1)}s  ` +
                `L=${fmt(values.length)} W=${fmt(values.width)} ` +
                `lac=${fmt(values.lacing_spacing_mm)} cw=${fmt(values.crossways_mm)} lw=${fmt(values.lengthways_mm)} ` +
                `xb=${fmt(values.extra_bars_count)}${nf ? `(${nf}f)` : ''} => ${calc.total} bars`);
        } catch (e) {
            const ms = Date.now() - t0;
            summary.push({ file: f, ms, error: e.message });
            console.log(`FAIL ${(ms / 1000).toFixed(1)}s  ${e.message}`);
        }
    }

    // Summary table
    console.log('\n================= SUMMARY =================');
    const cols = ['file', 'L', 'W', 'shal', 'deep', 'lac', 'cw', 'lw', 'kick', 'int', 'STB', 'bars'];
    console.log(cols.join('\t'));
    for (const r of summary) {
        if (r.error) { console.log(`${r.file}\tERROR: ${r.error}`); continue; }
        const v = r.values;
        console.log([
            r.file.slice(0, 28),
            fmt(v.length), fmt(v.width), fmt(v.shallow_depth), fmt(v.deep_depth),
            fmt(v.lacing_spacing_mm), fmt(v.crossways_mm), fmt(v.lengthways_mm),
            fmt(v.kicker_bars_m), fmt(v.intermediates_m),
            (v.single_tile_beam || '-'), r.calc.total
        ].join('\t'));
    }

    fs.writeFileSync(path.join(OUT, '_summary.json'), JSON.stringify(summary, null, 2));
    const ok = summary.filter(s => !s.error).length;
    console.log(`\nDone. ${ok}/${summary.length} succeeded. Per-file JSON in results/\n`);
})().catch(e => { console.error('Batch crashed:', e); process.exit(1); });
