// Steel takeoff calculator — ported verbatim from public/index.html calculateSteel().
// Pure function so server, frontend, and batch harness all agree on the math.

function n(x, dflt = 0) {
    const v = parseFloat(x);
    return isNaN(v) ? dflt : v;
}

/**
 * @param {object} v extracted/entered values
 * @returns {{ total:number, breakdown:object, waste:number, subtotal:number }}
 */
function calcSteel(v) {
    const length = n(v.length);
    const width = n(v.width);
    const benches_m2 = n(v.benches_m2);
    const shallow_depth = n(v.shallow_depth) || 1.2;
    const deep_depth = n(v.deep_depth) || 1.8;
    const beam_m2 = n(v.beam_m2);
    const lacing_spacing_mm = n(v.lacing_spacing_mm);
    const crossways_mm = n(v.crossways_mm);
    const lengthways_mm = n(v.lengthways_mm);
    const kicker_bars_m = n(v.kicker_bars_m);
    const intermediates_m = n(v.intermediates_m);
    const walls_200_option = (v.single_tile_beam || v.walls_200 || 'yes').toString().toLowerCase();
    const extra_bars_count = n(v.extra_bars_count);
    const floor_area_override = n(v.floor_area_override);

    const bar_length = 6.0;
    const bar_effective_length = 5.3;
    const avg_depth = (Math.max(0, shallow_depth) + Math.max(0, deep_depth)) / 2;
    const perimeter = (length * 2) + (width * 2) + 0.8;
    const lacing_spacing_m = lacing_spacing_mm / 1000;
    const crossways_m = crossways_mm / 1000;
    const lengthways_m = lengthways_mm / 1000;

    // Floor Area Override (mirrors the JJZ Quote Calculator's FloorAreaOverrideFactor).
    // A non-rectangular pool (L-shape / freeform / cut corner) has a real floor slab
    // smaller than its bounding box L*W. The override is that real floor area (m²); it
    // scales ONLY the floor steel (crossways + longways) down proportionally. Walls
    // (lacing), perimeter pins (droppers), bench, kickers etc. stay on the bounding box.
    //   factor = override / ((L*W) - bench)   when override > 0, else 1
    // Clamped to <= 1: the real floor is always inside the bounding box, so the override can
    // only REDUCE floor steel. (Defends against a bad read where override ~ L*W inflates it.)
    const gross_floor = (length * width) - benches_m2;
    const floor_factor = (floor_area_override > 0 && gross_floor > 0)
        ? Math.min(1, floor_area_override / gross_floor)
        : 1;

    const bars = {
        droppers: 0, lacing: 0, crossways: 0, longways: 0, bench: 0,
        kickers: 0, intermediates: 0, beam: 0, walls_200_extra: 0,
        skimmer: 2, extra: extra_bars_count
    };

    if (length > 0 || width > 0) {
        const dl = Math.ceil(length / 1.2) + 1;
        const dw = Math.ceil(width / 1.2) + 1;
        const total = (dl * 2) + (dw * 2);
        const len = (total * 2.0) + (total * 0.5);
        bars.droppers = len / bar_length;
    }
    if (lacing_spacing_m > 0 && perimeter > 0.8) {
        bars.lacing = ((perimeter / bar_effective_length) + 2) * ((avg_depth + 0.2) / lacing_spacing_m);
    }
    if (crossways_m > 0 && length > 0) {
        const t = (length / crossways_m) * ((avg_depth * 2) + width);
        bars.crossways = (t / bar_effective_length) * floor_factor;
    }
    if (lengthways_m > 0 && width > 0) {
        const sections = width / lengthways_m;
        const len_factor = (avg_depth * 2 + length) / bar_effective_length;
        bars.longways = sections * len_factor * floor_factor;
    }
    if (benches_m2 > 0) bars.bench = benches_m2 * 1.5;
    if (kicker_bars_m > 0) bars.kickers = (kicker_bars_m * 6.66 * 2.25) / bar_length;
    if (intermediates_m > 0) bars.intermediates = (intermediates_m * 3.33) / 2;
    if (beam_m2 > 0) bars.beam = beam_m2 * 1.8;
    if (walls_200_option === 'yes' && perimeter > 0.8) {
        bars.walls_200_extra = (perimeter / 5.0) + (perimeter / 0.25 / bar_length);
    }

    let subtotal = 0;
    for (const k in bars) {
        if (typeof bars[k] === 'number' && !isNaN(bars[k])) subtotal += bars[k];
    }

    let waste = 0;
    if (subtotal > 0) {
        waste = (0.085 * subtotal) - (0.00015 * Math.pow(subtotal, 2));
        if (waste < 0) waste = 0;
    }

    const total = Math.ceil(subtotal + waste);
    return { total, subtotal, waste, breakdown: bars };
}

module.exports = { calcSteel };
