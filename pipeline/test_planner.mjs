// Sanity test for the route planner on the real data: node pipeline/test_planner.mjs
import { readFileSync } from 'node:fs';
import { Planner } from '../web/js/planner.js';
const D = new URL('../web/data/', import.meta.url);
const buf = (f) => readFileSync(new URL(f, D));
const meta = JSON.parse(buf('meta.json')), sites = JSON.parse(buf('sites.json'));
const n = meta.grid, b = buf('dem.bin');
const dem = new Float32Array(b.buffer, b.byteOffset, n * n);
const slope = Float32Array.from(buf('slope.bin'), (v) => v / 4);
const rough = Float32Array.from(buf('rough.bin'), (v) => v / 100);
const thermal = Float32Array.from(buf('thermal.bin'), (v) => v / 255);
const P = new Planner({ n, cell: meta.cell_m, dem, slope, rough, thermal });
const hab = P.nearestOpen(P.idx(+(process.argv[2] ?? 875), +(process.argv[3] ?? 959)));
let t0 = performance.now();
P.computeWalkback(hab);
console.log('walkback field', (performance.now() - t0).toFixed(0), 'ms');
for (const s of sites) {
  const k = P.nearestOpen(P.idx(s.x, s.y));
  t0 = performance.now();
  const r = P.findPath(hab, k);
  console.log(s.id, 'cls', P.cls[P.idx(s.x, s.y)], r ? `${(r.time / 60).toFixed(1)} min out, ${(P.walkback[k] / 60).toFixed(1)} min back, ${r.cells.length} cells` : 'UNREACHABLE', (performance.now() - t0).toFixed(0), 'ms');
}
const order = (process.argv[4] ?? 's05,s04,s07').split(',').map((id) => sites.find((s) => s.id === id));
const pts = [hab, ...order.map((s) => P.nearestOpen(P.idx(s.x, s.y))), hab];
const legs = []; for (let i = 1; i < pts.length; i++) legs.push(P.findPath(pts[i - 1], pts[i]).cells);
const ev = P.evaluate(legs, [...order.map((s) => ({ name: s.id })), null]);
console.log({ dist: ev.dist | 0, hours: +(ev.time / 3600).toFixed(2), walkH: +(ev.walk / 3600).toFixed(2), up: ev.up | 0, slackMin: ev.slack / 60 | 0, minMarginMin: ev.minMargin / 60 | 0, dose: +ev.dose.toFixed(3), cautionM: ev.caution | 0 });
