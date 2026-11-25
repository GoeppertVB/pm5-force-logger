// Per-piece averages for the live dashboard: one row per piece the monitor has rowed this
// session, the current piece's running averages, and the previous piece kept beside it.
//
// Every stroke already carries its piece (decode.js tags it from the monitor's own piece
// boundaries — a programmed workout's next interval or another Just Row started on the
// monitor), so nothing new is detected here; this only aggregates what arrived.
//
// The gates are the W2 sprint-rehearsal gates (Vanya's card, Nov 22 2026): peak position
// ≤35% of the drive, finish plateau ≥40%, stroke length ≥150 cm. Like the tiles' targets
// they are guidance, not rules — on 4-minute rungs they read as "did the length hold".
//
// The measures match pm5_ingest.py's post-hoc numbers (the analysis scripts') so a live
// panel and the ingested session agree: fingerprint from the stroke packet's peak/avg
// force, peak position and plateau from the raw trimmed curve (no smoothing).
import { trim, metrics } from "./curve.js";

export const GATES = {
  len_cm: { lo: 150, label: "≥150 cm" },
  peak_pos: { hi: 35, label: "≤35%" },
  plateau: { lo: 40, label: "≥40%" },
};

export const gateOk = (k, v) => v != null &&
  (GATES[k].lo == null || v >= GATES[k].lo) && (GATES[k].hi == null || v <= GATES[k].hi);

/** The measures of one stroke. Curve measures are null when no curve matched the stroke. */
export function strokeMeasures(s) {
  const c = s.force_curve_v2 || s.force_curve, m = c ? metrics(trim(c)) : null;
  return {
    len_cm: s.drive_length_m != null ? s.drive_length_m * 100 : null,
    power_w: s.power_w ?? null, spm: s.spm ?? null, hr: s.hr ?? null,
    peak_pos: m ? m.a100 : null,
    plateau: m ? (() => { const tail = m.norm.slice(80); return 100 * tail.reduce((a, b) => a + b, 0) / tail.length; })() : null,
    fp: s.peak_force_lbf && s.avg_force_lbf ? s.peak_force_lbf / s.avg_force_lbf : null,
  };
}

const avg = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };

/** The mean of one stroke field over the strokes given (the current piece's strokes). */
export function pieceAvg(strokes, field) {
  return avg(strokes.map(s => s[field]));
}

/** One piece's averages from its strokes (their cached measures). */
export function pieceStats(strokes, piece) {
  const ms = strokes.map(measures);
  return { piece, n: strokes.length,
    len_cm: avg(ms.map(m => m.len_cm)), power_w: avg(ms.map(m => m.power_w)), spm: avg(ms.map(m => m.spm)),
    hr: avg(ms.map(m => m.hr)), peak_pos: avg(ms.map(m => m.peak_pos)), plateau: avg(ms.map(m => m.plateau)),
    fp: avg(ms.map(m => m.fp)) };
}

/** A session's pieces, in piece order. Per-stroke measures are cached — strokes arrive
 *  before their curves do (H.curve attaches them later), so the cache key carries which
 *  curves the stroke has; a stroke that gains one recomputes. Strokes are otherwise
 *  immutable once received, and render() redraws often. */
const cache = new Map();
const sig = s => (s.force_curve_v2 ? 2 : 0) + (s.force_curve ? 1 : 0);
const measures = s => {
  if (s.key == null && s.stroke_count == null) return strokeMeasures(s);   // no identity: no cache entry
  const k = `${s.key ?? s.stroke_count}:${sig(s)}`;
  if (!cache.has(k)) cache.set(k, strokeMeasures(s));
  return cache.get(k);
};
export function resetCache() { cache.clear(); }

export function piecesOverview(all) {
  const by = new Map();
  for (const s of all) { const p = s.piece || 1; if (!by.has(p)) by.set(p, []); by.get(p).push(s); }
  return [...by.keys()].sort((a, b) => a - b).map(p => pieceStats(by.get(p), p));
}
