'use strict';
/**
 * The VOD picture-in-picture's correctness rests on two pure functions (public/js/vod-pip.js):
 *   - the time mapping between the main recording and the PIP's own VOD (offset + (t - from) inside [from, to),
 *     and the inverse when the viewer swaps the two views);
 *   - the drift decision: nothing under 0.3 s, a playbackRate nudge between 0.3 s and 2 s, a seek beyond 2 s.
 * The browser test (test/vod-pip-chrome.test.js) then checks them on two real <video> elements.
 */
const assert = require('assert');
const core = require('../public/js/vod-pip');

const span = (from, to, offset) => ({ from, to, offset });

// ── the mapping ─────────────────────────────────────────────
assert.strictEqual(core.pipTimeAt(span(20, 120, 5), 20), 5, 'at the start of the span the PIP is at its offset');
assert.strictEqual(core.pipTimeAt(span(20, 120, 5), 30), 15, 'one second of the main is one second of the PIP');
assert.strictEqual(core.pipTimeAt(span(20, 120, 5), 119.9), 104.9, 'the PIP runs to the end of the span');
assert.strictEqual(core.pipTimeAt(span(20, 120, 5), 120), null, 'the span is half-open: at `to` it is gone');
assert.strictEqual(core.pipTimeAt(span(20, 120, 5), 19.9), null, 'before the span it is not shown');
assert.strictEqual(core.pipTimeAt({ from: 1, to: 2 }, 1.5), null, 'a span with no offset has no mapping');

assert.strictEqual(core.hostTimeAt(span(20, 120, 5), 5), 20, 'the inverse mapping: offset is from');
assert.strictEqual(core.hostTimeAt(span(20, 120, 5), 105), null, 'the PIP range is half-open too');
assert.strictEqual(core.hostTimeAt(span(20, 120, 5), 104.9), 119.9, 'and just inside it maps to just before `to`');
assert.strictEqual(core.hostTimeAt(span(20, 120, 5), 4.9), null, 'before its offset there is no main second');
assert.strictEqual(core.hostTimeAt(span(20, 120, 5), 106), null, 'past its end there is none either');

// A round trip, for every kind of span.
for (const s of [span(0, 10, 0), span(20, 120, 42.5), span(60, 70, 3.25)]) {
    for (const t of [s.from, s.from + 0.5, (s.from + s.to) / 2, s.to - 0.1]) {
        const p = core.pipTimeAt(s, t);
        assert.ok(Math.abs(core.hostTimeAt(s, p) - t) < 1e-9, `round trip at ${t} (${p})`);
    }
}

// Several spans (the PIP came, went and came back): the one holding t wins; a gap has none.
const spans = [span(10, 20, 0), span(40, 60, 12), span(55, 70, 30)];
assert.strictEqual(core.activeSpan(spans, 5), null, 'before every span');
assert.strictEqual(core.activeSpan(spans, 15), spans[0], 'inside the first');
assert.strictEqual(core.activeSpan(spans, 30), null, 'in the gap it is hidden');
assert.strictEqual(core.activeSpan(spans, 50), spans[1], 'inside the second');
assert.strictEqual(core.activeSpan(spans, 65), spans[2], 'overlapping spans: the latest one wins');
assert.strictEqual(core.activeSpan([], 10), null);

// ── drift correction ────────────────────────────────────────
assert.strictEqual(core.NUDGE_AT, 0.3);
assert.strictEqual(core.SEEK_AT, 2);

const none = core.driftCorrection(10.2, 10, 1);
assert.strictEqual(none.action, 'none', 'under 0.3 s: leave it alone');
assert.strictEqual(none.rate, 1);
assert.strictEqual(core.driftCorrection(10.3, 10, 1).action, 'none', 'exactly 0.3 s is still inside');

const ahead = core.driftCorrection(10.5, 10, 1);
assert.strictEqual(ahead.action, 'nudge', 'over 0.3 s: nudge, not seek');
assert.ok(ahead.factor < 1 && ahead.factor >= 0.95, `ahead of the main → slower (${ahead.factor})`);
assert.ok(Math.abs(ahead.rate - ahead.factor) < 1e-12, 'at 1× the rate is the factor');

const behind = core.driftCorrection(9.5, 10, 1);
assert.strictEqual(behind.action, 'nudge', 'behind the main is nudged too');
assert.ok(behind.factor > 1 && behind.factor <= 1.05, `behind the main → faster (${behind.factor})`);

const atSpeed = core.driftCorrection(9.2, 10, 2);
assert.ok(Math.abs(atSpeed.rate - 2 * atSpeed.factor) < 1e-12, 'a 2× main keeps 2× while it catches up');
assert.ok(atSpeed.factor >= 0.95 && atSpeed.factor <= 1.05, 'the nudge factor stays within 0.95–1.05');
assert.ok(Math.abs(core.driftCorrection(9.2, 10, 1).factor - 1.05) < 1e-12, '0.8 s behind is 5% faster, capped');

const seekAhead = core.driftCorrection(13, 10, 1);
assert.deepStrictEqual(seekAhead, { action: 'seek', rate: 1, time: 10, drift: 3, factor: 1 }, 'over 2 s: seek, not nudge');
assert.strictEqual(core.driftCorrection(12.01, 10, 1).action, 'seek', 'just over 2 s seeks');
assert.strictEqual(core.driftCorrection(12, 10, 1).action, 'nudge', 'exactly 2 s still only nudges');
assert.strictEqual(core.driftCorrection(1, 10).action, 'seek', 'a PIP at 0 when it should be at 10 seeks');

// NaN never turns into a wild rate.
assert.deepStrictEqual(core.driftCorrection(NaN, 10, 1), { action: 'seek', rate: 1, time: 10, drift: 0, factor: 1 });
assert.strictEqual(core.driftCorrection(3, NaN, 1).action, 'none');
assert.strictEqual(core.driftCorrection(3, 3, 0).rate, 1, 'a nonsense base rate falls back to 1×');

process.stdout.write('  ✓ the time mapping and the drift correction\n');
