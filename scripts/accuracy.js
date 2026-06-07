// Accuracy report: compares the AI's extracted values against the estimator's
// corrected ("Save as Correct") values saved via the web UI.
// Run: node scripts/accuracy.js
const fs = require('fs');
const path = require('path');
const { calcSteel } = require('../lib/calc');

const DIR = path.join(__dirname, '..', 'results', 'feedback');
const FIELDS = ['length', 'width', 'shallow_depth', 'deep_depth', 'benches_m2', 'beam_m2',
    'lacing_spacing_mm', 'crossways_mm', 'lengthways_mm', 'kicker_bars_m', 'intermediates_m',
    'single_tile_beam', 'extra_bars_count'];

if (!fs.existsSync(DIR)) {
    console.log('No feedback yet. Use "💾 Save as Correct" in the web UI to record corrected takeoffs.');
    process.exit(0);
}
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
if (!files.length) { console.log('No feedback records in', DIR); process.exit(0); }

const n = num => (num === '' || num == null ? NaN : parseFloat(num));
const stats = {};
FIELDS.forEach(f => stats[f] = { n: 0, exact: 0, close: 0, absErr: 0 });
let totalBarsErr = 0, barsN = 0;

for (const fn of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(DIR, fn), 'utf8'));
    const ai = rec.ai_values || {}, gt = rec.corrected_values || {};
    for (const f of FIELDS) {
        if (gt[f] === undefined) continue;
        const s = stats[f]; s.n++;
        if (f === 'single_tile_beam') {
            if (String(ai[f]).toLowerCase() === String(gt[f]).toLowerCase()) s.exact++;
            continue;
        }
        const a = n(ai[f]), g = n(gt[f]);
        if (isNaN(a) || isNaN(g)) continue;
        const err = Math.abs(a - g);
        s.absErr += err;
        if (err < 1e-6) s.exact++;
        if (g !== 0 ? err / Math.abs(g) <= 0.05 : err === 0) s.close++;
    }
    if (ai && Object.keys(ai).length) {
        const ab = calcSteel(ai).total, gb = calcSteel(gt).total;
        totalBarsErr += Math.abs(ab - gb); barsN++;
    }
}

console.log(`\nAccuracy over ${files.length} reviewed plan(s)\n`);
console.log('field'.padEnd(20), 'n'.padStart(4), 'exact'.padStart(7), '≤5%'.padStart(6), 'avgErr'.padStart(8));
for (const f of FIELDS) {
    const s = stats[f];
    if (!s.n) continue;
    const pct = x => `${Math.round(100 * x / s.n)}%`;
    const avg = s.exact === s.n ? '0' : (s.absErr / s.n).toFixed(2);
    console.log(f.padEnd(20), String(s.n).padStart(4), pct(s.exact).padStart(7),
        pct(s.close).padStart(6), String(avg).padStart(8));
}
if (barsN) console.log(`\nTotal-bars mean abs error (AI vs corrected): ${(totalBarsErr / barsN).toFixed(1)} bars over ${barsN} plan(s)`);
console.log('\nField legend: exact = identical; ≤5% = within 5% of corrected; avgErr = mean absolute error.\n');
