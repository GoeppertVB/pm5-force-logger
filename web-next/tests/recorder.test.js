// Saving a row: nothing lost or misfiled when two pieces meet mid-save, a failed write leaves the
// row in hand, and a row cut off by a closed tab can be rebuilt from its last checkpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readRaw } from "../decode.js";
import { Recorder, rebuild } from "../recorder.js";

const { events } = readRaw(readFileSync(new URL("../examples/sample_row.jsonl", import.meta.url), "utf8"));
const STROKES = 66;   // in the sample, as the Python logger's --reparse also finds

/** A store kept in memory; `hold` makes putSession wait until release() is called. */
function memoryStore({ hold = false, failSession = false, failRaw = false } = {}) {
  const st = { sessions: new Map(), raw: new Map(), waiting: [] };
  st.putSession = data => {
    if (failSession) return Promise.reject(new Error("quota exceeded"));
    const write = () => { st.sessions.set(data.started, structuredClone(data)); };
    if (!hold) { write(); return Promise.resolve(); }
    return new Promise(res => st.waiting.push(() => { write(); res(); }));
  };
  st.putRaw = (started, lines) => {
    if (failRaw) return Promise.reject(new Error("quota exceeded"));
    st.raw.set(started, structuredClone(lines)); return Promise.resolve();
  };
  st.release = () => { for (const w of st.waiting.splice(0)) w(); };
  return st;
}
const names = () => { let n = 0; return () => `2026-09-24_1000${String(n++).padStart(2, "0")}`; };
const feed = (rec, evs, dt = 0) => { for (const [t, short, b] of evs) rec.packet(t + dt, short, b); };

test("a row is saved whole: every stroke, and every message in its raw log", async () => {
  const store = memoryStore(), rec = new Recorder({ store, stamp: names() });
  feed(rec, events);
  const out = await rec.finish();
  assert.equal(out.saved, "all");
  assert.equal(store.sessions.get(out.id).strokes.length, STROKES);
  const lines = store.raw.get(out.id);
  assert.equal(lines.filter(l => l.uuid).length, events.length - events.findIndex(([, s]) => s === 0x35), "from its first stroke on");
});

test("a second piece started mid-session: it stays in the same session, nothing dropped", async () => {
  const store = memoryStore(), rec = new Recorder({ store, stamp: names() });
  feed(rec, events);
  const first = rec.meta.started;
  const sessionAtStart = rec.session;
  feed(rec, events, 1000);        // the whole second piece arrives: a piece boundary, not a stop
  assert.equal(rec.session, sessionAtStart, "a piece boundary does not split the session");
  assert.equal(rec.session.strokes.size, 2 * STROKES, "both pieces' strokes are in the one session");
  const out = await rec.finish();
  assert.equal(out.id, first);
  assert.equal(store.sessions.get(first).strokes.length, 2 * STROKES);
  assert.equal(store.sessions.get(first).pieces, 2);
  assert.equal(store.sessions.get(first).strokes.filter(s => s.piece === 2).length, STROKES, "the second piece's strokes are tagged");
  const lines = store.raw.get(first).filter(l => l.uuid).length;
  const firstStroke = events.findIndex(([, s]) => s === 0x35);
  assert.equal(lines, 2 * events.length - firstStroke, "every message is in the one raw log");
});

test("a failed write leaves the row in hand, and says which part was saved", async () => {
  for (const [opts, saved] of [[{ failSession: true }, "none"], [{ failRaw: true }, "session"]]) {
    const rec = new Recorder({ store: memoryStore(opts), stamp: names() });
    feed(rec, events);
    const out = await rec.finish();
    assert.equal(out.saved, saved);
    assert.match(out.error.message, /quota/);
    assert.equal(out.data.strokes.length, STROKES, "the session is still there to download");
    assert.equal(out.lines.filter(l => l.uuid).length, events.length - events.findIndex(([, s]) => s === 0x35), "and so is its raw log");
    assert.equal(rec.session, null);
  }
});

test("a row cut off mid-way can be rebuilt from its last checkpoint", () => {
  const store = memoryStore(), rec = new Recorder({ store, stamp: names(), checkpointS: 30 });
  feed(rec, events.slice(0, Math.floor(events.length / 2)));   // then the tab closes
  const lines = store.raw.get(rec.meta.started);
  assert.ok(lines && lines.length > 1, "a checkpoint was written");
  assert.equal(store.sessions.size, 0, "and no session file, which is how an unfinished row is recognised");
  const data = rebuild(rec.meta.started, lines, { recovered: true });
  assert.ok(data.strokes.length > 5 && data.strokes.length < STROKES, `${data.strokes.length} strokes recovered`);
  assert.equal(data.started, rec.meta.started);
  assert.equal(data.recovered, true);
});

test("rebuilding a whole raw log gives the row the logger would", () => {
  const rec = new Recorder({ store: memoryStore(), stamp: names() });
  feed(rec, events);
  const data = rebuild("2026-09-20_071500", [{ t: events[0][0], device: { name: "PM5" } }, ...rec.raw]);
  assert.equal(data.strokes.length, STROKES);
  assert.equal(data.strokes[STROKES - 1].distance_m, 626.8);
  assert.equal(data.summary.distance_m, 633.3);
  assert.equal(data.device.name, "PM5");
});
