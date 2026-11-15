// Traversability model, A* route search and walk-back field.
// Pure logic, no DOM: runs in the browser and in Node (see pipeline/test_planner.mjs).

export const DEFAULT_PARAMS = {
  maxSlope: 20,       // deg  - cells steeper than this are closed to a suited walker
  cautionSlope: 10,   // deg
  maxStep: 0.5,       // m    - local step / block height that closes a cell
  cautionStep: 0.25,  // m
  flatSpeed: 0.8,     // m/s  - suited walking speed on firm, level ground
  softPenalty: 0.3,   // extra time on cold (= loose, dusty) ground, from THEMIS night IR
  evaLimitH: 7,       // h    - suit consumables
  reserveMin: 45,     // min  - untouchable reserve
  workMin: 25,        // min  - science time per stop
  doseRate: 0.64 / 24.66, // mSv per hour, GCR at the surface (MSL RAD mean, Hassler et al. 2014)
};

class MinHeap {
  constructor(cap = 1 << 16) {
    this.k = new Float32Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float32Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v;
    const top = V[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], val = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = val;
    }
    return top;
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

export class Planner {
  /** grids: {n, cell, dem:Float32Array(m), slope:Float32Array(deg), rough:Float32Array(m), thermal:Float32Array(0..1)} */
  constructor(grids, params = {}) {
    Object.assign(this, grids);
    this.params = { ...DEFAULT_PARAMS, ...params };
    const N = this.n * this.n;
    this.cls = new Uint8Array(N);      // 0 go, 1 caution, 2 no-go
    this.mult = new Float32Array(N);   // time multiplier of a cell
    this.g = new Float32Array(N);
    this.parent = new Int32Array(N);
    this.state = new Uint8Array(N);
    this.walkback = null;              // Float32Array: seconds to reach the habitat
    this.toHab = null;                 // Int32Array: next cell on the way to the habitat
    this.buildCost();
  }

  setParams(p) { Object.assign(this.params, p); this.buildCost(); this.walkback = null; }

  buildCost() {
    const { slope, rough, thermal, cls, mult } = this;
    const P = this.params;
    for (let i = 0; i < cls.length; i++) {
      const s = slope[i], r = rough[i];
      if (s > P.maxSlope || r > P.maxStep) cls[i] = 2;
      else if (s > P.cautionSlope || r > P.cautionStep) cls[i] = 1;
      else cls[i] = 0;
      const sr = s / P.maxSlope;
      mult[i] = 1 + 0.6 * Math.min(1, r / P.maxStep) + 0.5 * sr * sr + P.softPenalty * (1 - thermal[i]);
    }
  }

  /** Walking speed (m/s) for a signed grade (rise/run): Tobler's hiking function scaled to suited pace. */
  speed(grade) {
    return this.params.flatSpeed * Math.exp(-3.5 * Math.abs(grade + 0.05) + 0.175);
  }

  /** seconds to walk from cell a to neighbouring cell b */
  edgeTime(a, b, dist) {
    const grade = (this.dem[b] - this.dem[a]) / dist;
    return dist / this.speed(grade) * 0.5 * (this.mult[a] + this.mult[b]);
  }

  idx(x, y) { // metres (x east, y south of the NW corner) -> cell index
    const n = this.n;
    const i = Math.max(0, Math.min(n - 1, Math.floor(x / this.cell)));
    const j = Math.max(0, Math.min(n - 1, Math.floor(y / this.cell)));
    return j * n + i;
  }
  xy(idx) { const n = this.n; return [((idx % n) + 0.5) * this.cell, (Math.floor(idx / n) + 0.5) * this.cell]; }

  /** nearest cell that is not closed (spiral search) */
  nearestOpen(idx) {
    if (this.cls[idx] !== 2) return idx;
    const n = this.n, ci = idx % n, cj = Math.floor(idx / n);
    for (let r = 1; r < 60; r++) {
      let best = -1, bd = Infinity;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const k = j * n + i;
        if (this.cls[k] === 2) continue;
        const d = di * di + dj * dj;
        if (d < bd) { bd = d; best = k; }
      }
      if (best >= 0) return best;
    }
    return idx;
  }

  /** A* from start cell to goal cell. Returns {cells:Int32Array, time} or null. */
  findPath(start, goal) {
    const n = this.n, { g, parent, state, cls, cell } = this;
    state.fill(0);
    const vmax = this.params.flatSpeed * Math.exp(0.175);
    const gi = goal % n, gj = Math.floor(goal / n);
    const h = (k) => Math.hypot((k % n) - gi, Math.floor(k / n) - gj) * cell / vmax;
    const heap = new MinHeap();
    g[start] = 0; parent[start] = -1; state[start] = 1;
    heap.push(h(start), start);
    const diag = cell * Math.SQRT2;
    while (heap.n > 0) {
      const cur = heap.pop();
      if (state[cur] === 2) continue;
      state[cur] = 2;
      if (cur === goal) break;
      const ci = cur % n, cj = (cur - ci) / n, gc = g[cur];
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d], j = cj + DY[d];
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const nb = j * n + i;
        if (state[nb] === 2 || cls[nb] === 2) continue;
        if (d >= 4 && (cls[cj * n + i] === 2 || cls[j * n + ci] === 2)) continue; // no corner cutting
        const t = gc + this.edgeTime(cur, nb, d < 4 ? cell : diag);
        if (state[nb] === 0 || t < g[nb]) {
          g[nb] = t; parent[nb] = cur; state[nb] = 1;
          heap.push(t + h(nb), nb);
        }
      }
    }
    if (state[goal] !== 2) return null;
    const out = [];
    for (let k = goal; k !== -1; k = parent[k]) out.push(k);
    out.reverse();
    return { cells: Int32Array.from(out), time: g[goal] };
  }

  /** Dijkstra over the whole box: time needed to walk from every cell back to the habitat. */
  computeWalkback(hab) {
    const n = this.n, N = n * n, { cls, cell } = this;
    const t = new Float32Array(N).fill(Infinity);
    const next = new Int32Array(N).fill(-1);
    const done = new Uint8Array(N);
    const heap = new MinHeap(1 << 18);
    const diag = cell * Math.SQRT2;
    t[hab] = 0; heap.push(0, hab);
    while (heap.n > 0) {
      const cur = heap.pop();
      if (done[cur]) continue;
      done[cur] = 1;
      const ci = cur % n, cj = (cur - ci) / n, tc = t[cur];
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d], j = cj + DY[d];
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const nb = j * n + i;
        if (done[nb] || cls[nb] === 2) continue;
        if (d >= 4 && (cls[cj * n + i] === 2 || cls[j * n + ci] === 2)) continue;
        const tt = tc + this.edgeTime(nb, cur, d < 4 ? cell : diag); // walking nb -> cur (towards habitat)
        if (tt < t[nb]) { t[nb] = tt; next[nb] = cur; heap.push(tt, nb); }
      }
    }
    this.walkback = t; this.toHab = next; this.habCell = hab;
    return t;
  }

  /** cells from idx back to the habitat along the fastest way */
  pathToHab(idx) {
    if (!this.toHab) return null;
    const out = [idx];
    let k = idx, guard = 0;
    while (this.toHab[k] !== -1 && guard++ < 1e6) { k = this.toHab[k]; out.push(k); }
    return k === this.habCell ? Int32Array.from(out) : null;
  }

  /**
   * Turn a chain of legs (arrays of cells) into a sampled EVA timeline.
   * stops[i] = {name, workMin} is the stop at the END of leg i (null for a plain waypoint).
   */
  evaluate(legs, stops) {
    const P = this.params, n = this.n, cell = this.cell;
    const S = { x: [], y: [], z: [], dist: [], time: [], cls: [], slope: [], wb: [], leg: [] };
    const events = [];
    let dist = 0, time = 0, up = 0, down = 0, walk = 0, work = 0, caution = 0;
    const push = (k, li) => {
      S.x.push(((k % n) + 0.5) * cell); S.y.push((Math.floor(k / n) + 0.5) * cell);
      S.z.push(this.dem[k]); S.dist.push(dist); S.time.push(time); S.cls.push(this.cls[k]);
      S.slope.push(this.slope[k]); S.wb.push(this.walkback ? this.walkback[k] : NaN); S.leg.push(li);
    };
    legs.forEach((cells, li) => {
      if (li === 0) push(cells[0], 0);
      for (let c = 1; c < cells.length; c++) {
        const a = cells[c - 1], b = cells[c];
        const d = (a % n !== b % n && Math.floor(a / n) !== Math.floor(b / n)) ? cell * Math.SQRT2 : cell;
        const dz = this.dem[b] - this.dem[a];
        const dt = this.edgeTime(a, b, d);
        dist += Math.hypot(d, dz); time += dt; walk += dt;
        if (dz > 0) up += dz; else down -= dz;
        if (this.cls[b] === 1) caution += d;
        push(b, li);
      }
      const st = stops[li];
      if (st) {
        const w = (st.workMin ?? P.workMin) * 60;
        events.push({ name: st.name, kind: st.kind, sample: S.x.length - 1, arrive: time, work: w, dist });
        if (w > 0) { time += w; work += w; push(cells[cells.length - 1], li); }
      }
    });
    const limit = P.evaLimitH * 3600, reserve = P.reserveMin * 60;
    // margin(t) = consumables left after walking straight home from that point, minus the reserve
    let minMargin = Infinity, minAt = 0, maxWb = 0;
    for (let i = 0; i < S.time.length; i++) {
      const wb = S.wb[i];
      if (!isFinite(wb)) continue;
      const m = limit - reserve - S.time[i] - wb;
      if (m < minMargin) { minMargin = m; minAt = i; }
      if (wb > maxWb) maxWb = wb;
    }
    return {
      samples: S, events, dist, time, walk, work, up, down, caution,
      limit, reserve, slack: limit - reserve - time,
      minMargin: isFinite(minMargin) ? minMargin : NaN, minMarginAt: minAt, maxWalkback: maxWb,
      dose: time / 3600 * P.doseRate,
    };
  }
}
