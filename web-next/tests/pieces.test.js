// Per-piece averages: pieces come from the strokes' own piece tags (decode.js's boundary
// detection), the measures from the stroke packets and raw curves. Synthetic strokes whose
// answers are known, like curve.test.js's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { strokeMeasures, pieceStats, piecesOverview, gateOk, GATES, resetCache, pieceAvg } from "../pieces.js";

/** A flat-topped stroke curve (see curve.test.js's shape); hold = where the force lets go. */
const curve = (n = 45, top = 110, hold = 0.7) => { const out = []; for (let i = 0; i < n; i++) { const x = i / (n - 1);
  out.push(Math.round(top * Math.min(1, x / 0.12) * (x < hold ? 1 : Math.max(0, 1 - (x - hold) / (1 - hold)) ** 1.3) || 1)); } return [0, ...out, 0]; };

const stroke = ({ piece = 1, len_m = 1.51, w = 450, spm = 38, hr = 150, peak = 300, avg = 210, c = null, key } = {}) =>
  ({ key, piece, drive_length_m: len_m, power_w: w, spm, hr, peak_force_lbf: peak, avg_force_lbf: avg, ...(c ? { force_curve_v2: c } : {}) });

test("a stroke's measures: length in cm, fingerprint from the packet's peak/avg force", () => {
  const m = strokeMeasures(stroke({ c: curve(45, 110, 0.92) }));
  assert.equal(m.len_cm, 151);
  assert.ok(Math.abs(m.fp - 300 / 210) < 1e-9);
  assert.equal(m.power_w, 450); assert.equal(m.spm, 38); assert.equal(m.hr, 150);
  // the flat-topped curve peaks within the first 20% and keeps most of its force to the end
  assert.ok(m.peak_pos != null && m.peak_pos <= 20, `peak position ${m.peak_pos} should be early`);
  assert.ok(m.plateau != null && m.plateau > 60, `plateau ${m.plateau} should be high on a flat top`);
});

test("a stroke with no curve still reports its numbers, with null curve measures", () => {
  const m = strokeMeasures(stroke({}));
  assert.equal(m.len_cm, 151); assert.equal(m.peak_pos, null); assert.equal(m.plateau, null); assert.equal(m.fp, 300 / 210);
});

test("pieceStats averages each column over the piece's strokes", () => {
  const s = pieceStats([stroke({ len_m: 1.50, w: 400 }), stroke({ len_m: 1.54, w: 500 })], 3);
  assert.equal(s.piece, 3); assert.equal(s.n, 2);
  assert.ok(Math.abs(s.len_cm - 152) < 1e-9); assert.equal(s.power_w, 450);
});

test("piecesOverview splits a session by piece tag; a missing tag reads as piece 1", () => {
  const rows = piecesOverview([stroke({ piece: 1, len_m: 1.40 }), stroke({ piece: 2, len_m: 1.50 }), stroke({ len_m: 1.60 }), stroke({ piece: 2, len_m: 1.54 })]);
  assert.deepEqual(rows.map(r => r.piece), [1, 2]);
  assert.equal(rows[0].n, 2);                                   // the untagged pair
  assert.ok(Math.abs(rows[1].len_cm - 152) < 1e-9);
});

test("pieceAvg: the mean of one field over the strokes given, null-safe", () => {
  const ss = [stroke({ len_m: 1.50 }), stroke({ len_m: 1.54 }), stroke({ len_m: null })];
  assert.ok(Math.abs(pieceAvg(ss, "drive_length_m") - 1.52) < 1e-9);
  assert.equal(pieceAvg([stroke({})], "hr"), 150);
  assert.equal(pieceAvg([], "drive_length_m"), null);
});

test("gates: length ≥150, peak ≤35, plateau ≥40; null fails quietly", () => {
  assert.equal(gateOk("len_cm", 149.9), false); assert.equal(gateOk("len_cm", 150), true);
  assert.equal(gateOk("peak_pos", 35), true); assert.equal(gateOk("peak_pos", 35.1), false);
  assert.equal(gateOk("plateau", 39.9), false); assert.equal(gateOk("plateau", 40), true);
  assert.equal(gateOk("len_cm", null), false);
  assert.equal(GATES.len_cm.label, "≥150 cm");
});

test("a stroke that gains its curve later recomputes: the cache key carries curve presence", () => {
  resetCache();
  const s = stroke({ c: null, key: 7 });
  assert.equal(piecesOverview([s])[0].plateau, null);           // curveless read, now cached
  s.force_curve_v2 = curve(45, 80);                             // the curve packet arrives
  const after = piecesOverview([s])[0];
  assert.ok(after.plateau != null && after.peak_pos != null, "the attach must recompute, not serve the stale cache");
  resetCache();
});
