// Locks the steel calculator math. Run: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const { calcSteel } = require('../lib/calc');

test('standard 8x4 pool, 300 each way, STB yes', () => {
    const r = calcSteel({
        length: 8, width: 4, lacing_spacing_mm: 300, crossways_mm: 300,
        lengthways_mm: 300, single_tile_beam: 'yes', kicker_bars_m: 12, intermediates_m: 15
    });
    assert.strictEqual(r.total, 201);
});

test('empty input -> floor (skimmer only + waste)', () => {
    // perimeter is only 0.8 so wall/lacing terms stay 0; skimmer=2 is the only bar.
    assert.strictEqual(calcSteel({}).total, 3);
});

test('depth defaults applied when 0/missing', () => {
    const a = calcSteel({ length: 8, width: 4 });
    const b = calcSteel({ length: 8, width: 4, shallow_depth: 1.2, deep_depth: 1.8 });
    assert.strictEqual(a.total, b.total);
});

test('tighter spacing => more bars', () => {
    const wide = calcSteel({ length: 8, width: 4, lacing_spacing_mm: 300, crossways_mm: 300, lengthways_mm: 300 });
    const tight = calcSteel({ length: 8, width: 4, lacing_spacing_mm: 150, crossways_mm: 150, lengthways_mm: 150 });
    assert.ok(tight.total > wide.total, `${tight.total} should exceed ${wide.total}`);
});

test('non-standard 250 spacing is honoured (not snapped)', () => {
    const r = calcSteel({ length: 10, width: 5, lacing_spacing_mm: 250, crossways_mm: 250, lengthways_mm: 250 });
    const at300 = calcSteel({ length: 10, width: 5, lacing_spacing_mm: 300, crossways_mm: 300, lengthways_mm: 300 });
    assert.ok(r.total > at300.total, '250 spacing should give more bars than 300');
});

test('single tile beam toggle changes total', () => {
    const yes = calcSteel({ length: 8, width: 4, single_tile_beam: 'yes' });
    const no = calcSteel({ length: 8, width: 4, single_tile_beam: 'no' });
    assert.ok(yes.total > no.total, 'STB adds wall bars');
});

test('extra_bars_count flows into total 1:1 (pre-waste)', () => {
    const base = calcSteel({ length: 8, width: 4 });
    const plus = calcSteel({ length: 8, width: 4, extra_bars_count: 10 });
    assert.ok(plus.total > base.total);
});

test('breakdown keys present and numeric', () => {
    const r = calcSteel({ length: 8, width: 4 });
    for (const k of ['droppers', 'lacing', 'crossways', 'longways', 'kickers', 'intermediates', 'walls_200_extra', 'skimmer']) {
        assert.strictEqual(typeof r.breakdown[k], 'number', `${k} should be a number`);
    }
});

test('floor area override 0 == no override (plain rectangle unchanged)', () => {
    const a = calcSteel({ length: 7, width: 5, lacing_spacing_mm: 300, crossways_mm: 300, lengthways_mm: 300 });
    const b = calcSteel({ length: 7, width: 5, lacing_spacing_mm: 300, crossways_mm: 300, lengthways_mm: 300, floor_area_override: 0 });
    assert.strictEqual(a.total, b.total);
});

test('floor area override scales ONLY floor steel by override/((L*W)-bench)', () => {
    // User's example plan: bounding box 7x5, bench 4 m², real floor 21 m².
    const opts = { length: 7, width: 5, lacing_spacing_mm: 300, crossways_mm: 300, lengthways_mm: 300, benches_m2: 4 };
    const base = calcSteel(opts);
    const over = calcSteel({ ...opts, floor_area_override: 21 });
    const f = 21 / ((7 * 5) - 4); // ≈ 0.677

    assert.ok(Math.abs(over.breakdown.crossways - base.breakdown.crossways * f) < 1e-9, 'crossways scaled by factor');
    assert.ok(Math.abs(over.breakdown.longways - base.breakdown.longways * f) < 1e-9, 'longways scaled by factor');
    // Walls, perimeter pins and bench stay on the bounding box (NOT scaled).
    assert.strictEqual(over.breakdown.lacing, base.breakdown.lacing, 'lacing unaffected');
    assert.strictEqual(over.breakdown.droppers, base.breakdown.droppers, 'droppers unaffected');
    assert.strictEqual(over.breakdown.bench, base.breakdown.bench, 'bench unaffected');
    assert.ok(over.total < base.total, 'smaller real floor => fewer bars');
});

test('floor area override >= gross floor is clamped (never inflates floor steel)', () => {
    const opts = { length: 7, width: 5, lacing_spacing_mm: 300, crossways_mm: 300, lengthways_mm: 300 };
    const base = calcSteel(opts);                               // factor 1
    const up = calcSteel({ ...opts, floor_area_override: 50 }); // 50/35 > 1 -> clamped to 1
    assert.strictEqual(up.total, base.total, 'override above bounding box does not add bars');
    assert.strictEqual(up.breakdown.crossways, base.breakdown.crossways, 'crossways not inflated');
});
