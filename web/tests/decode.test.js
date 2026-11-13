// The decoder against the Python one: hand-built packets and the whole synthetic sample row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session, ForceCurve, parse, hexToBytes, readRaw, uuid, ROWING_SERVICE } from "../decode.js";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("every packet layout decodes as the Python parser does", () => {
  for (const { short, hex, expected } of fixture("packets.json")) {
    assert.deepEqual(parse(short, hexToBytes(hex)), expected, `0x${short.toString(16)} ${hex}`);
  }
});

test("force curves reassemble across packets and restart at sequence 0", () => {
  const le = v => [v & 0xff, v >> 8];
  const points = Array.from({ length: 20 }, (_, i) => 10 * i);
  const chunks = [points.slice(0, 9), points.slice(9, 18), points.slice(18)];
  const packets = chunks.map((c, seq) => Uint8Array.from([(3 << 4) | c.length, seq, ...c.flatMap(le)]));
  const fc = new ForceCurve();
  assert.equal(fc.add(packets[1]), null, "joined mid-curve: nothing until a sequence 0");
  assert.equal(fc.add(packets[0]), null);
  assert.equal(fc.add(packets[1]), null);
  assert.deepEqual(fc.add(packets[2]), points);
  assert.equal(fc.add(packets[0]), null);
  assert.equal(fc.add(packets[0]), null, "a fresh sequence 0 restarts the curve");
});

test("the synthetic sample row assembles into the same session as the Python logger", () => {
  const expected = fixture("sample_session.json");
  const text = readFileSync(new URL("../../examples/sample_row.jsonl", import.meta.url), "utf8");
  const { meta, events } = readRaw(text);
  const kinds = [];
  const session = new Session(kind => kinds.push(kind));
  for (const [t, short, b] of events) session.feed(t, short, b);
  const got = session.result(meta);
  assert.equal(got.strokes.length, expected.strokes.length);
  for (let i = 0; i < got.strokes.length; i++) {
    const g = { ...got.strokes[i] }, e = { ...expected.strokes[i] };
    assert.ok(Math.abs(g.t - e.t) < 2e-3, `stroke ${i} arrival time`);
    delete g.t; delete e.t;
    assert.deepEqual(g, e, `stroke ${e.stroke_count}`);
  }
  assert.deepEqual(got.summary, expected.summary);
  assert.deepEqual(got.last_status, expected.last_status);
  assert.deepEqual(got.unmatched_curves.map(c => c.kind), expected.unmatched_curves.map(c => c.kind));
  assert.equal(got.pieces, expected.pieces);
  assert.equal(got.device.serial, expected.device.serial);
  assert.ok(kinds.includes("stroke") && kinds.includes("curve") && kinds.includes("summary"));
});

test("a stroke count that goes backwards tags a new piece and the session carries on", () => {
  const le = (v, n) => Array.from({ length: n }, (_, i) => (v >> (8 * i)) & 0xff);
  const stroke = (n, t) => Uint8Array.from([...le(t * 100, 3), ...le(t * 30, 3), 140, 80, ...le(200, 2), ...le(950, 2), ...le(1000, 2), ...le(500, 2), ...le(4000, 2), ...le(n, 2)]);
  const events = [];
  const s = new Session((k, d) => events.push(k));
  for (let n = 1; n <= 5; n++) { s.feed(n * 4, 0x0035, stroke(n, n * 4)); s.feed(n * 4 + 2, 0x0035, stroke(n, n * 4)); }
  assert.equal(s.strokes.size, 5);
  assert.equal(s.strokes.get(5).recovery_time_s, 2, "the second copy fills the recovery time");
  s.feed(30, 0x0035, stroke(1, 30));
  s.feed(34, 0x0035, stroke(2, 34));
  assert.equal(s.strokes.size, 7, "the second piece's strokes are recorded");
  assert.ok(events.includes("piece"));
  const r = s.result({});
  assert.equal(r.pieces, 2);
  assert.deepEqual(r.strokes.map(x => x.piece), [1, 1, 1, 1, 1, 2, 2]);
  assert.deepEqual(r.strokes.map(x => x.stroke_count), [1, 2, 3, 4, 5, 1, 2]);
  assert.deepEqual(r.strokes.map(x => x.key), [1, 2, 3, 4, 5, 6, 7], "records keep their arrival order");
});

test("daisy-chained pieces with summaries between them form one session", () => {
  const le = (v, n) => Array.from({ length: n }, (_, i) => (v >> (8 * i)) & 0xff);
  const stroke = (n, t) => Uint8Array.from([...le(t * 100, 3), ...le(t * 30, 3), 140, 80, ...le(200, 2), ...le(950, 2), ...le(1000, 2), ...le(500, 2), ...le(4000, 2), ...le(n, 2)]);
  const summary = Uint8Array.from([...le(0, 2), ...le(0, 2), ...le(45000, 3), ...le(5000, 3), 30, 155, 142, 67, 162, 115, 0, 0, ...le(1100, 2)]);
  const s = new Session(() => {});
  for (let n = 1; n <= 4; n++) s.feed(n * 4, 0x0035, stroke(n, n * 4));
  s.feed(50, 0x0039, summary);
  for (let n = 1; n <= 4; n++) s.feed(100 + n * 4, 0x0035, stroke(n, n * 4));   // another Just Row, later
  s.feed(150, 0x0039, summary);
  const r = s.result({});
  assert.equal(r.pieces, 2);
  assert.equal(r.strokes.length, 8);
  assert.deepEqual(r.strokes.map(x => x.piece), [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.equal(s.endAt, 150, "the latest summary holds the end");
  s.feed(160, 0x0035, stroke(1, 160));   // a third Just Row starts
  assert.equal(s.endAt, null, "strokes after a summary clear the end, so the recording carries on");
  assert.equal(s.result({}).pieces, 3);
});

test("intervals of a programmed workout tag piece numbers while the state frames roll", () => {
  const le = (v, n) => Array.from({ length: n }, (_, i) => (v >> (8 * i)) & 0xff);
  const stroke = (n, t) => Uint8Array.from([...le(t * 100, 3), ...le(t * 30, 3), 140, 80, ...le(200, 2), ...le(950, 2), ...le(1000, 2), ...le(500, 2), ...le(4000, 2), ...le(n, 2)]);
  const status = (t, state) => Uint8Array.from([...le(t * 100, 3), ...le(1234, 3), 5, 0, 1, state, 1, ...le(0, 3), ...le(45000, 3), 0x00, 113]);
  const s = new Session(() => {});
  s.feed(100, 0x0031, status(100, 4));   // interval_work_time
  for (let n = 1; n <= 6; n++) s.feed(100 + n, 0x0035, stroke(n, n));
  s.feed(110, 0x0031, status(110, 3));   // interval_rest
  s.feed(120, 0x0031, status(120, 4));   // the next interval's work
  for (let n = 1; n <= 6; n++) s.feed(120 + n, 0x0035, stroke(n, n));
  const r = s.result({});
  assert.equal(r.pieces, 2);
  assert.deepEqual(r.strokes.map(x => x.piece), [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
});

test("uuid helper matches the Concept2 base", () => {
  assert.equal(ROWING_SERVICE, "ce060030-43e5-11e4-916c-0800200c9a66");
  assert.equal(uuid(0x43), "ce060043-43e5-11e4-916c-0800200c9a66");
});
