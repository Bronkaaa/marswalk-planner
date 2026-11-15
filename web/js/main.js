// Marswalk Planner – app wiring: data loading, layers, mission editing, EVA budget, HUD.
import { Planner, DEFAULT_PARAMS } from './planner.js';
import { TerrainScene } from './scene.js';
import { sunAt, inShadow } from './sun.js';
import { cuffCards, printCuff, CUFF_CSS } from './cuff.js';

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); Object.assign(e, attrs); if (html) e.innerHTML = html; return e; };
const fmtT = (s) => { s = Math.max(0, Math.round(s / 60)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtMin = (s) => `${Math.round(s / 60)} min`;
const hm = (str) => { const [h, m] = str.split(':').map(Number); return h * 60 + m; };
const clock = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}`;

// Crew tasks for the science stops (mission design, not rover results).
const TASKS = [
  ['Arrival terrace', 'Context panorama and a regolith scoop at the foot of the climb: baseline for everything sampled higher up.'],
  ['Layered slope', 'Log the layer sequence of the sulfate-bearing unit; chip one sample per visible bed to date the wet-to-dry transition.'],
  ['Orbital ground truth', 'Compare rock type and grain size on the ground with the orbital thermal and mineral signal of this cell.'],
  ['Boxwork margin', 'Find where the ridge network starts. Photograph the first ridges and measure their strike with the hand compass.'],
  ['Boxwork ridge', 'Core a cemented ridge crest: which minerals did groundwater leave in the fractures?'],
  ['Boxwork hollow', 'Sample the eroded hollow floor next to a ridge – the direct comparison that explains how boxwork forms.'],
  ['Vein survey', 'Search ridge walls for mineral veins and nodules; veins are the best place to look for preserved organics.'],
  ['Upper ridge field', 'Second ridge/hollow pair 40 m higher: does the cement chemistry change with elevation?'],
  ['Stratigraphy step', 'Measure bed thickness along the step and collect a fresh-fracture sample for the habitat lab.'],
  ['Upper overlook', 'Panorama back over the boxwork field and reconnaissance of the next traverse up Mount Sharp.'],
];

const LAYERS = [
  { id: 'none', name: 'Optical', sub: 'HiRISE orthophoto, 0.5 m/px (MRO)' },
  { id: 'trav', name: 'Traversability', sub: 'go / caution / no-go from slope + step height' },
  { id: 'range', name: 'Safe range', sub: 'how long you could still stay at each place and get home with the reserve – follows the mission clock' },
  { id: 'slope', name: 'Slope', sub: 'from HiRISE stereo DEM, 2 m grid' },
  { id: 'rough', name: 'Step height', sub: 'local relief of the 1 m DEM' },
  { id: 'thermal', name: 'Thermal (night IR)', sub: 'THEMIS, 100 m/px (Mars Odyssey): warm = rocky, cold = loose' },
  { id: 'mineral', name: 'Minerals', sub: 'CRISM spectrometer, 18 m/px (MRO): where which mineral shows from orbit' },
  { id: 'elev', name: 'Elevation', sub: 'contours every 10 m' },
  { id: 'walkback', name: 'Walk-back time', sub: 'minutes on foot to the habitat' },
];
const PARAM_UI = [
  ['maxSlope', 'Max slope', 12, 30, 1, (v) => `${v}°`],
  ['maxStep', 'Max step height', 0.25, 1, 0.05, (v) => `${v.toFixed(2)} m`],
  ['flatSpeed', 'Walking speed (level)', 0.4, 1.4, 0.05, (v) => `${v.toFixed(2)} m/s`],
  ['evaLimitH', 'Suit endurance', 4, 9, 0.5, (v) => `${v} h`],
  ['reserveMin', 'Reserve', 15, 90, 5, (v) => `${v} min`],
  ['workMin', 'Science time per stop', 5, 60, 5, (v) => `${v} min`],
];
const STORM_FACTOR = 5; // hypothetical dose-rate multiplier used by the drill

const S = {
  meta: null, sites: [], traverse: [], weather: null,
  planner: null, scene: null,
  hab: null, route: [], tool: null, layer: 'none', alpha: 0.6, mode: 'orbit',
  ev: null, t: 0, playing: false, storm: null, overlay: document.createElement('canvas'), wpCount: 0, sciCount: 0,
  min: null, mineral: 'all', sunFollow: true, sunMin: 0, sunNow: null, sunSite: null, shGrid: null,
};

// ------------------------------------------------------------------ loading
async function load() {
  const j = (f) => fetch(`data/${f}`).then((r) => r.json());
  const b = (f) => fetch(`data/${f}`).then((r) => r.arrayBuffer());
  const img = new Image(); img.src = 'data/ortho.jpg';
  const [meta, sites, traverse, weather, dem, slope, rough, thermal, minerals] = await Promise.all([
    j('meta.json'), j('sites.json'), j('traverse.json'), j('weather.json'),
    b('dem.bin'), b('slope.bin'), b('rough.bin'), b('thermal.bin'), b('minerals.bin'), img.decode(),
  ]);
  S.meta = meta; S.traverse = traverse; S.weather = weather;
  const mg = meta.minerals.grid;
  S.min = { n: mg, info: meta.minerals.layers, scenes: meta.minerals.scenes, layers: meta.minerals.layers.map((_, i) => new Uint8Array(minerals, i * mg * mg, mg * mg)) };
  const w0 = weather.sols[0];
  S.sunSite = { lat: (meta.lat_n + meta.lat_s) / 2, ls: w0.ls, sunrise: hm(w0.sunrise), sunset: hm(w0.sunset) };
  S.shGrid = { n: meta.grid, cell: meta.cell_m, dem: new Float32Array(dem), elevMax: meta.elev_max };
  S.sites = sites.map((s, i) => ({ ...s, label: `S${i + 1}`, name: TASKS[i % TASKS.length][0], task: TASKS[i % TASKS.length][1] }));
  const n = meta.grid;
  const grids = {
    n, cell: meta.cell_m, dem: new Float32Array(dem),
    slope: Float32Array.from(new Uint8Array(slope), (v) => v / 4),
    rough: Float32Array.from(new Uint8Array(rough), (v) => v / 100),
    thermal: Float32Array.from(new Uint8Array(thermal), (v) => v / 255),
  };
  S.planner = new Planner(grids);
  S.scene = new TerrainScene($('#gl'), { ...grids, elevMin: meta.elev_min, elevMax: meta.elev_max }, img);
  S.overlay.width = S.overlay.height = n;

  // default mission: habitat on the flat terrace below the boxwork field, four stops up-slope
  if (!loadPlan()) exampleMission();
  buildUI();
  recompute(true);
  $('#loading').remove();
  let seen = false; try { seen = !!localStorage.getItem(INTRO_KEY); } catch { /* storage blocked */ }
  if (!seen) $('#intro').showModal();
  window.__app = S; // handy for debugging / automated checks
}

// the plan survives a reload: habitat, route and start time are kept in the browser
const PLAN_KEY = 'marswalk.plan.v1', INTRO_KEY = 'marswalk.intro.v1';
function exampleMission() {
  S.hab = flatSpot(1250, 200, 120);
  S.route = ['s03', 's05', 's06', 's07'].filter((id) => S.sites.some((s) => s.id === id)).map((id) => ({ type: 'stop', id }));
}
function savePlan() {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify({ hab: S.hab, route: S.route, start: $('#startTime').value, wp: S.wpCount, sci: S.sciCount })); } catch { /* storage blocked */ }
}
function loadPlan() {
  try {
    const p = JSON.parse(localStorage.getItem(PLAN_KEY));
    const ok = (v) => typeof v === 'number' && isFinite(v) && v >= 0 && v <= S.meta.size_m;
    if (!p || !p.hab || !ok(p.hab.x) || !ok(p.hab.y) || !Array.isArray(p.route)) return false;
    S.hab = { x: p.hab.x, y: p.hab.y };
    S.route = p.route.filter((it) => it && (it.type === 'wp' ? ok(it.x) && ok(it.y) : S.sites.some((s) => s.id === it.id)));
    if (/^\d\d:\d\d$/.test(p.start || '')) $('#startTime').value = p.start;
    S.wpCount = p.wp | 0; S.sciCount = p.sci | 0;
    return true;
  } catch { return false; }
}

/** flattest open patch (20 m) within r metres of (cx, cy) */
function flatSpot(cx, cy, r) {
  const P = S.planner, n = P.n, c = P.cell;
  let best = null, bs = Infinity;
  for (let y = cy - r; y <= cy + r; y += 8) for (let x = cx - r; x <= cx + r; x += 8) {
    if (x < 30 || y < 30 || x > n * c - 30 || y > n * c - 30) continue;
    let s = 0, bad = false;
    for (let dj = -5; dj <= 5 && !bad; dj++) for (let di = -5; di <= 5; di++) {
      const k = P.idx(x + di * c, y + dj * c);
      if (P.cls[k] === 2) { bad = true; break; }
      s += P.slope[k];
    }
    if (!bad && s < bs) { bs = s; best = { x, y }; }
  }
  return best || { x: cx, y: cy };
}

// ------------------------------------------------------------------ minerals (CRISM)
const LEVELS = [[0.65, 'strong'], [0.4, 'moderate'], [0.2, 'weak']];
const level = (t) => (LEVELS.find(([lim]) => t >= lim) || [0, ''])[1];
/** signal strength 0..1 of every mineral layer at box coordinates */
function mineralsAt(x, y) {
  const M = S.min, f = M.n / S.meta.size_m;
  const k = Math.max(0, Math.min(M.n - 1, Math.floor(y * f))) * M.n + Math.max(0, Math.min(M.n - 1, Math.floor(x * f)));
  return M.layers.map((l) => l[k] / 255);
}
/** [{name, level, color, t}] for the minerals that show at this point, strongest first */
function mineralSignals(x, y) {
  return mineralsAt(x, y).map((t, i) => ({ t, name: S.min.info[i].name, color: S.min.info[i].color, level: level(t) }))
    .filter((m) => m.level).sort((a, b) => b.t - a.t);
}
const mineralText = (x, y) => mineralSignals(x, y).map((m) => `${m.name.toLowerCase()} ${m.level}`).join(', ') || 'no clear mineral signal';
const mineralChips = (x, y) => {
  const sig = mineralSignals(x, y).slice(0, 2);
  return sig.length ? `<span class="chips">${sig.map((m) => `<span class="chip${m.level === 'weak' ? ' weak' : ''}" style="color:${css(m.color)}"><i>${m.name}, ${m.level}</i></span>`).join('')}</span>` : '';
};

// ------------------------------------------------------------------ sun
const startMin = () => hm($('#startTime').value);
function updateSun(force = false) {
  const min = S.sunFollow ? startMin() + S.t / 60 : S.sunMin;
  if (!force && S.sunNow && Math.abs(min - S.sunMin) < 0.4) return;
  S.sunMin = min; S.sunNow = sunAt(min, S.sunSite);
  S.scene.setSun(S.sunNow.el, S.sunNow.az);
  $('#sunTime').value = Math.round(min);
  const deg = S.sunNow.el * 180 / Math.PI, az = S.sunNow.az * 180 / Math.PI;
  $('#sunSum').textContent = `${clock(min)} · ${deg > 0 ? `${deg.toFixed(0)}° high` : 'down'}`;
  $('#sunInfo').innerHTML = `<span>Local time</span><b>${clock(min)}</b><span>Sun</span><b>${deg > 0 ? `${deg.toFixed(0)}° high · bearing ${String(Math.round(az) % 360).padStart(3, '0')}°` : 'below the horizon'}</b>`;
}
/** which route samples lie in terrain shadow at the time the crew passes them */
function shadeStats() {
  const ev = S.ev, sm = ev.samples, n = sm.x.length, t0 = startMin();
  const flags = new Uint8Array(n); let sec = 0, lowest = Infinity;
  for (let i = 0; i < n; i++) {
    const sun = sunAt(t0 + sm.time[i] / 60, S.sunSite);
    if (sun.el < lowest) lowest = sun.el;
    flags[i] = inShadow(S.shGrid, sm.x[i], sm.y[i], sun) ? 1 : 0;
    if (i && flags[i]) sec += sm.time[i] - sm.time[i - 1];
  }
  ev.shade = flags; ev.shadeSec = sec; ev.sunLowest = lowest * 180 / Math.PI;
}

/** route samples that pass within 4 m (2 cells) of no-go terrain */
function hazardStats() {
  const ev = S.ev, sm = ev.samples, P = S.planner, n = P.n, near = new Uint8Array(sm.x.length);
  let m = 0;
  for (let i = 0; i < sm.x.length; i++) {
    const k = P.idx(sm.x[i], sm.y[i]), ci = k % n, cj = (k - ci) / n;
    scan: for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const a = ci + di, b = cj + dj;
      if (a >= 0 && b >= 0 && a < n && b < n && P.cls[b * n + a] === 2) { near[i] = 1; break scan; }
    }
    if (i && near[i]) m += sm.dist[i] - sm.dist[i - 1];
  }
  ev.near = near; ev.nearM = m;
}

// ------------------------------------------------------------------ mission
const itemPos = (it) => (it.type === 'stop' ? S.sites.find((s) => s.id === it.id) : it);
const itemName = (it) => (it.type === 'stop' ? (() => { const s = itemPos(it); return `${s.label} ${s.name}`; })() : it.name);

function recompute(habMoved = false) {
  const P = S.planner;
  const habCell = P.nearestOpen(P.idx(S.hab.x, S.hab.y));
  if (habMoved || !P.walkback) P.computeWalkback(habCell);
  const cells = [habCell, ...S.route.map((it) => { const p = itemPos(it); return P.nearestOpen(P.idx(p.x, p.y)); }), habCell];
  const legs = [], stops = [], dropped = [];
  let from = habCell;
  S.route = S.route.filter((it, i) => {
    const r = P.findPath(from, cells[i + 1]);
    if (!r) { dropped.push(itemName(it)); return false; }
    legs.push(r.cells); from = cells[i + 1];
    stops.push({ name: itemName(it), kind: it.type, workMin: it.type === 'stop' || it.sci ? undefined : 0, ref: it });
    return true;
  });
  if (S.route.length) {
    const back = P.findPath(from, habCell);
    if (back) { legs.push(back.cells); stops.push({ name: 'Habitat', kind: 'hab', workMin: 0 }); }
  }
  S.ev = legs.length ? P.evaluate(legs, stops) : null;
  if (S.ev) S.ev.stops = stops;
  S.t = Math.min(S.t, S.ev ? S.ev.time : 0);
  setStorm(false);
  S.scene.setRoute(S.ev ? S.ev.samples : null);
  updateMarkers(); renderRoute(); renderSummary(); renderStops(); drawProfile(); updateFollow();
  if (S.layer === 'walkback' || S.layer === 'trav' || S.layer === 'range') drawOverlay();
  savePlan();
  if (dropped.length) toast(`No safe path to: ${dropped.join(', ')} – removed from the route.`);
}

function updateMarkers() {
  const m = [{ x: S.hab.x, y: S.hab.y, text: 'Habitat', color: '#ffffff', kind: 'hab' }];
  const order = new Map(S.route.map((it, i) => [it.type === 'stop' ? it.id : it, i + 1]));
  for (const s of S.sites) {
    const o = order.get(s.id);
    m.push({ x: s.x, y: s.y, text: o ? `${o} · ${s.label} ${s.name}` : s.label, color: o ? '#4fc3ff' : '#aab4c4', kind: 'stop', dim: !o });
  }
  for (const it of S.route) if (it.type === 'wp') m.push({ x: it.x, y: it.y, text: `${order.get(it)} · ${it.name}`, color: it.sci ? '#b58cff' : '#ff8a4c', kind: 'wp' });
  S.scene.setMarkers(m);
}

function toggleStop(id) {
  const i = S.route.findIndex((it) => it.type === 'stop' && it.id === id);
  if (i >= 0) S.route.splice(i, 1); else S.route.push({ type: 'stop', id });
  recompute();
}

function optimizeOrder() {
  const pts = S.route.map(itemPos), n = pts.length;
  if (n < 3) return;
  const P = S.planner, hab = P.habCell;
  // true walking times between all points (A*), then exhaustive search (n <= 7) or nearest neighbour
  const cellsOf = [hab, ...pts.map((p) => P.nearestOpen(P.idx(p.x, p.y)))];
  const T = cellsOf.map((a) => cellsOf.map((b) => (a === b ? 0 : (P.findPath(a, b)?.time ?? 1e9))));
  let best = null, bt = Infinity;
  const perm = (arr, k = 0) => {
    if (k === arr.length) {
      let t = T[0][arr[0]]; for (let i = 1; i < arr.length; i++) t += T[arr[i - 1]][arr[i]]; t += T[arr[arr.length - 1]][0];
      if (t < bt) { bt = t; best = arr.slice(); }
      return;
    }
    for (let i = k; i < arr.length; i++) { [arr[k], arr[i]] = [arr[i], arr[k]]; perm(arr, k + 1); [arr[k], arr[i]] = [arr[i], arr[k]]; }
  };
  if (n <= 7) perm(pts.map((_, i) => i + 1));
  else { best = []; const left = new Set(pts.map((_, i) => i + 1)); let cur = 0; while (left.size) { let b = -1; for (const c of left) if (b < 0 || T[cur][c] < T[cur][b]) b = c; best.push(b); left.delete(b); cur = b; } }
  S.route = best.map((i) => S.route[i - 1]);
  recompute();
}

// ------------------------------------------------------------------ overlays
const ramp = (stops) => (t) => {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [t0, a] = stops[i - 1], [t1, b] = stops[i], f = (t - t0) / (t1 - t0 || 1);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  return stops[stops.length - 1][1];
};
const R_HAZ = ramp([[0, [40, 190, 100]], [0.25, [250, 220, 50]], [0.5, [240, 60, 50]], [1, [150, 40, 200]]]);
const R_THERM = ramp([[0, [40, 80, 220]], [0.5, [240, 240, 235]], [1, [225, 60, 40]]]);
const R_ELEV = ramp([[0, [50, 30, 110]], [0.25, [40, 110, 180]], [0.5, [60, 180, 140]], [0.75, [220, 220, 90]], [1, [250, 250, 240]]]);
const R_RANGE = ramp([[0, [235, 60, 50]], [0.33, [250, 205, 50]], [1, [40, 185, 100]]]);
const R_TIME = ramp([[0, [70, 220, 255]], [0.4, [90, 230, 120]], [0.7, [255, 215, 60]], [1, [235, 70, 160]]]);
const css = (c) => `rgb(${c.map(Math.round).join(',')})`;
const gradCss = (r) => `linear-gradient(90deg, ${Array.from({ length: 11 }, (_, i) => css(r(i / 10))).join(',')})`;

function drawOverlay() {
  const P = S.planner, n = P.n, id = S.layer;
  if (id === 'none') { S.scene.setOverlay(null, 0); renderLegend(); return; }
  S.rangeT = S.t;
  const usableS = (P.params.evaLimitH * 60 - P.params.reserveMin) * 60, leakS = P.params.reserveMin * 60;
  if ((id === 'walkback' || id === 'range') && !P.walkback) P.computeWalkback(P.nearestOpen(P.idx(S.hab.x, S.hab.y)));
  const ctx = S.overlay.getContext('2d'), im = ctx.createImageData(n, n), d = im.data;
  const { elev_min: e0, elev_max: e1 } = S.meta;
  const CLS = [[53, 224, 138, 105], [255, 194, 26, 215], [235, 50, 50, 235]];
  const M = S.min, mr = n / M.n, sel = M.info.findIndex((m) => m.id === S.mineral);
  for (let k = 0, o = 0; k < n * n; k++, o += 4) {
    let c, a = 255;
    if (id === 'slope') c = R_HAZ(P.slope[k] / 40);
    else if (id === 'rough') c = R_HAZ(P.rough[k] / 1.0);
    else if (id === 'thermal') c = R_THERM(P.thermal[k]);
    else if (id === 'trav') { c = CLS[P.cls[k]]; a = c[3]; }
    else if (id === 'mineral') {
      // colour = mineral, opacity = signal strength; with "all", the strongest mineral of the cell wins
      const mk = Math.floor(Math.floor(k / n) / mr) * M.n + Math.floor((k % n) / mr);
      let li = sel, t = sel >= 0 ? M.layers[sel][mk] / 255 : 0;
      if (sel < 0) for (let q = 0; q < M.layers.length; q++) { const v = M.layers[q][mk] / 255; if (v > t) { t = v; li = q; } }
      c = li >= 0 ? M.info[li].color : [0, 0, 0];
      a = t < 0.2 ? 0 : 255 * Math.min(1, 0.25 + t * 1.1);
    }
    else if (id === 'elev') {
      c = R_ELEV((P.dem[k] - e0) / (e1 - e0));
      const z = Math.floor(P.dem[k] / 10);
      if ((k % n < n - 1 && Math.floor(P.dem[k + 1] / 10) !== z) || (k < n * n - n && Math.floor(P.dem[k + n] / 10) !== z)) c = [20, 20, 30];
    } else if (id === 'range') {
      // margin = suit time left after walking home from this cell at the current mission time, reserve untouched
      const wb = P.walkback[k], wbE = P.walkback[k + 1] ?? wb, wbS = P.walkback[k + n] ?? wb;
      if (!isFinite(wb)) { c = [60, 10, 10]; a = 235; }
      else if ((wb <= leakS) !== (wbE <= leakS) || (wb <= leakS) !== (wbS <= leakS)) c = [255, 255, 255];
      else {
        const m = (usableS - S.t - wb) / 60;
        if (m < 0) { c = [120, 15, 15]; a = 240; }
        else { c = R_RANGE(m / 180); if (Math.floor(m / 30) !== Math.floor((usableS - S.t - wbE) / 1800)) c = [15, 20, 30]; }
      }
    } else if (id === 'walkback') {
      const m = P.walkback[k] / 60;
      if (!isFinite(m)) { c = [60, 10, 10]; a = 235; }
      else { c = R_TIME(m / 60); if (Math.floor(m / 5) !== Math.floor((P.walkback[k + 1] ?? P.walkback[k]) / 300)) c = [15, 20, 30]; }
    }
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = a;
  }
  ctx.putImageData(im, 0, 0);
  S.scene.setOverlay(S.overlay, S.alpha);
  renderLegend();
}

function renderLegend() {
  const P = S.planner.params, L = $('#legend'), M = S.min;
  $('#mineralRow').hidden = S.layer !== 'mineral';
  const grad = (r, a, b) => `<div class="grad" style="background:${gradCss(r)}"></div><div class="ends"><span>${a}</span><span>${b}</span></div>`;
  const sw = (c, t) => `<span class="sw"><i style="background:${c}"></i>${t}</span>`;
  L.innerHTML = {
    none: '',
    mineral: M.info.filter((m) => S.mineral === 'all' || m.id === S.mineral).map((m) => sw(css(m.color), `${m.name}${m.check_r < 0.3 ? '*' : ''}`)).join('')
      + `<br>Stronger colour = stronger signal. ${S.mineral === 'all' ? '' : `${M.info.find((m) => m.id === S.mineral).desc}. `}Mean of two CRISM scenes (${M.scenes.join(', ')}), smoothed to about 50 m. A hint where to sample, not proof.`
      + (M.info.some((m) => m.check_r < 0.3 && (S.mineral === 'all' || m.id === S.mineral)) ? '<br>* weak here and not confirmed by the second scene' : ''),
    trav: sw('#35e08a', 'go') + sw('#ffc21a', `caution (&gt;${P.cautionSlope}° / ${P.cautionStep} m)`) + '<br>' + sw('#eb3232', `no-go (&gt;${P.maxSlope}° / ${P.maxStep} m)`),
    slope: grad(R_HAZ, '0°', '40°+'),
    rough: grad(R_HAZ, '0 m', '1 m+'),
    thermal: grad(R_THERM, 'cold at night – dust, sand', 'warm – bedrock'),
    elev: grad(R_ELEV, `${Math.round(S.meta.elev_min)} m`, `${Math.round(S.meta.elev_max)} m`),
    range: grad(R_RANGE, '0 min', '3 h or more') + `Time you could still stay at a place and get home with the reserve, at mission time ${fmtT(S.t)} h. Lines every 30 min · dark red = too far to return · inside the white line a suit leak is survivable (walk-back shorter than the reserve).`,
    walkback: grad(R_TIME, '0 min', '60 min+') + 'Lines every 5 min · dark = not reachable on foot',
  }[S.layer];
}

// ------------------------------------------------------------------ panels
function buildUI() {
  const m = S.meta;
  $('#siteName').textContent = `${m.name} · ${Math.abs(m.lat_n + m.lat_s) / 2 | 0}.${String(Math.round((Math.abs(m.lat_n + m.lat_s) / 2 % 1) * 100)).padStart(2, '0')}°S ${((m.lon_w + m.lon_e) / 2).toFixed(2)}°E · ${m.size_m / 1000 | 0} × ${m.size_m / 1000 | 0} km`;
  $('#solRange').textContent = `${S.traverse[0].sol}–${S.traverse[S.traverse.length - 1].sol}`;
  S.scene.setTraverse(S.traverse, true);

  for (const l of LAYERS) {
    const lab = el('label', { className: l.id === S.layer ? 'on' : '' }, `<input type="radio" name="layer" value="${l.id}" ${l.id === S.layer ? 'checked' : ''}><span><b>${l.name}</b><small>${l.sub}</small></span>`);
    lab.querySelector('input').onchange = () => { S.layer = l.id; document.querySelectorAll('#layers label').forEach((x) => x.classList.toggle('on', x === lab)); drawOverlay(); };
    $('#layers').append(lab);
  }
  const ms = $('#mineralSel');
  ms.innerHTML = '<option value="all">All – strongest per place</option>' + S.min.info.map((m) => `<option value="${m.id}">${m.name} (${m.param})</option>`).join('');
  ms.onchange = () => { S.mineral = ms.value; drawOverlay(); };
  const st = $('#sunTime'); st.min = S.sunSite.sunrise - 45; st.max = S.sunSite.sunset + 45;
  st.oninput = () => { S.sunFollow = false; $('#sunFollow').checked = false; S.sunMin = +st.value; S.sunNow = null; updateSun(true); updateHud(stateAt(S.t)); };
  $('#sunFollow').onchange = (e) => { S.sunFollow = e.target.checked; updateSun(true); };
  renderLegend();
  $('#alpha').oninput = (e) => { S.alpha = +e.target.value; if (S.layer !== 'none') S.scene.setOverlay(S.overlay, S.alpha); };
  $('#showTraverse').onchange = (e) => S.scene.setTraverse(S.traverse, e.target.checked);
  $('#exag').onchange = (e) => { S.scene.setExaggeration(+e.target.value); updateFollow(); };

  for (const [key, name, min, max, step, fmt] of PARAM_UI) {
    const p = el('div', { className: 'p' }, `<div><span>${name}</span><b>${fmt(S.planner.params[key])}</b></div><input type="range" min="${min}" max="${max}" step="${step}" value="${S.planner.params[key]}">`);
    const inp = p.querySelector('input');
    inp.oninput = () => { p.querySelector('b').textContent = fmt(+inp.value); };
    inp.onchange = () => {
      const v = +inp.value, upd = { [key]: v };
      if (key === 'maxSlope') upd.cautionSlope = v / 2;
      if (key === 'maxStep') upd.cautionStep = v / 2;
      S.planner.setParams(upd); recompute(true); drawOverlay();
    };
    $('#params').append(p);
  }

  renderWeather();

  document.querySelectorAll('#modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $('#toolWp').onclick = () => setTool(S.tool === 'wp' ? null : 'wp');
  $('#toolSci').onclick = () => setTool(S.tool === 'sci' ? null : 'sci');
  $('#cuffBtn').onclick = showCuff;
  $('#cuffPrint').onclick = () => { if (!printCuff($('#cuffBody').innerHTML, 'Marswalk cuff checklist')) toast('Allow pop-ups for this page to print the checklist.'); };
  $('#toolHab').onclick = () => setTool(S.tool === 'hab' ? null : 'hab');
  $('#optimize').onclick = optimizeOrder;
  $('#clear').onclick = () => { S.route = []; recompute(); };
  $('#startTime').onchange = () => { renderSummary(); updateSun(true); savePlan(); };
  $('#play').onclick = () => setPlaying(!S.playing);
  $('#scrub').oninput = (e) => { if (S.ev) { S.t = e.target.value / 1000 * S.ev.time; setStorm(false); updateFollow(); } };
  $('#storm').onclick = () => setStorm(!S.storm);
  $('#drillSel').onchange = () => { if (S.storm) setStorm(true); };
  $('#exampleBtn').onclick = () => { exampleMission(); recompute(true); };
  $('#guideBtn').onclick = () => $('#intro').showModal();
  $('#intro').addEventListener('close', () => { try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* storage blocked */ } });
  $('#cardClose').onclick = () => ($('#card').hidden = true);
  $('#aboutBtn').onclick = () => { renderAbout(); $('#about').showModal(); };

  // terrain interaction
  const cv = $('#gl');
  let down = null;
  cv.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  cv.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || S.mode !== 'orbit') return;
    const p = S.scene.pick(e.clientX, e.clientY); if (!p) return;
    if (S.tool === 'hab') {
      const k = S.planner.nearestOpen(S.planner.idx(p.x, p.y)); const [x, y] = S.planner.xy(k);
      S.hab = { x, y }; setTool(null); recompute(true);
    } else if (S.tool === 'wp') {
      S.route.push({ type: 'wp', x: p.x, y: p.y, name: `Waypoint ${++S.wpCount}` }); recompute();
    } else if (S.tool === 'sci') {
      const top = mineralSignals(p.x, p.y)[0];
      S.route.push({ type: 'wp', sci: true, x: p.x, y: p.y, name: `Sample ${++S.sciCount}${top ? ` (${top.name.toLowerCase()})` : ''}`,
        task: `Crew-chosen sample site. Orbital signal here: ${mineralText(p.x, p.y)}. Take a rock chip and a context photo to check it on the ground.` });
      recompute();
    } else {
      let best = null, bd = 45;
      for (const s of S.sites) { const d = Math.hypot(s.x - p.x, s.y - p.y); if (d < bd) { bd = d; best = s; } }
      if (best) showCard(best);
    }
  });
  let last = 0;
  cv.addEventListener('pointermove', (e) => {
    const now = performance.now(); if (now - last < 60 || S.mode !== 'orbit') return; last = now;
    const p = S.scene.pick(e.clientX, e.clientY);
    if (!p) { $('#readout').textContent = 'Move the cursor over the terrain'; return; }
    const P = S.planner, k = P.idx(p.x, p.y), R = 3396190;
    const lon = (m.x0 + p.x) / R * 180 / Math.PI, lat = (m.y_top - p.y) / R * 180 / Math.PI;
    const wb = P.walkback ? P.walkback[k] : NaN;
    const extra = { mineral: () => ` · ${mineralText(p.x, p.y)}`, rough: () => ` · step ${P.rough[k].toFixed(2)} m`, elev: () => ` · ${Math.abs(lat).toFixed(4)}°S ${lon.toFixed(4)}°E` }[S.layer];
    $('#readout').innerHTML = `<b class="${['ok', 'warnc', 'bad'][P.cls[k]]}">${['GO', 'CAUTION', 'NO-GO'][P.cls[k]]}</b> · ${P.dem[k].toFixed(0)} m · slope ${P.slope[k].toFixed(0)}° · walk-back ${isFinite(wb) ? fmtMin(wb) : 'n/a'}${extra ? extra() : ''}`;
  });

  const pc = $('#profile');
  const scrubProfile = (e) => {
    if (!S.ev || !pc._x) return;
    const r = pc.getBoundingClientRect(), dist = pc._x.inv(e.clientX - r.left), sm = S.ev.samples;
    let i = 0; while (i < sm.dist.length - 1 && sm.dist[i] < dist) i++;
    S.t = sm.time[i]; setStorm(false); updateFollow();
  };
  pc.addEventListener('pointerdown', (e) => { pc._drag = true; scrubProfile(e); });
  pc.addEventListener('pointermove', (e) => pc._drag && scrubProfile(e));
  window.addEventListener('pointerup', () => (pc._drag = false));
  new ResizeObserver(drawProfile).observe(pc);
  requestAnimationFrame(tick);
}

function setTool(t) {
  S.tool = t;
  $('#toolWp').classList.toggle('on', t === 'wp'); $('#toolHab').classList.toggle('on', t === 'hab'); $('#toolSci').classList.toggle('on', t === 'sci');
  const h = $('#toolHint'); h.hidden = !t;
  h.textContent = t === 'wp' ? 'Click the terrain to add waypoints. Click “Add waypoint” again to finish.' : t === 'hab' ? 'Click the terrain to place the habitat' : t === 'sci' ? 'Click the terrain to add your own science stops. Click “Add sample site” again to finish.' : '';
}

function renderRoute() {
  const ol = $('#routeList'); ol.innerHTML = '';
  const row = (cls, n, title, sub, btns = '') => el('li', { className: cls }, `<span class="n">${n}</span><span class="t">${title}</span><small>${sub}</small>${btns}`);
  ol.append(row('hab', 'H', 'Habitat', 'start'));
  const ev = S.ev;
  S.route.forEach((it, i) => {
    const e = ev?.events[i];
    const li = row(it.sci ? 'wp sci' : it.type, i + 1, itemName(it), e ? fmtT(e.arrive) : '', '<button data-a="up" title="Earlier">↑</button><button data-a="rm" title="Remove">✕</button>');
    li.querySelector('[data-a=up]').onclick = (x) => { x.stopPropagation(); if (i > 0) { [S.route[i - 1], S.route[i]] = [S.route[i], S.route[i - 1]]; recompute(); } };
    li.querySelector('[data-a=rm]').onclick = (x) => { x.stopPropagation(); S.route.splice(i, 1); recompute(); };
    if (it.type === 'stop') li.querySelector('.t').onclick = () => showCard(itemPos(it));
    ol.append(li);
  });
  if (S.route.length) ol.append(row('hab', 'H', 'Habitat', ev ? fmtT(ev.time) : ''));
  else ol.append(el('li', {}, '<small>Add science stops from the list below.</small>'));
}

function renderSummary() {
  const ev = S.ev, P = S.planner.params, w = S.weather.sols[0];
  const sum = $('#summary'), checks = $('#checks'), pill = $('#status');
  if (!ev) { sum.innerHTML = '<span>No route yet</span><b></b>'; checks.innerHTML = ''; $('#checksOk').innerHTML = ''; $('#summaryMore').innerHTML = ''; $('#checksOkSum').textContent = 'Details'; pill.textContent = 'NO ROUTE'; pill.className = 'pill'; return; }
  const start = hm($('#startTime').value), end = start + ev.time / 60, sunset = hm(w.sunset), sunrise = hm(w.sunrise);
  const kv = (rows) => rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  sum.innerHTML = kv([
    ['Total EVA', `${fmtT(ev.time)} h`],
    ['Distance', `${(ev.dist / 1000).toFixed(2)} km`],
    ['Back at habitat', clock(end)],
  ]);
  $('#summaryMore').innerHTML = kv([
    ['Walking / science time', `${fmtT(ev.walk)} / ${fmtT(ev.work)} h`],
    ['Climb / descent', `+${ev.up.toFixed(0)} / −${ev.down.toFixed(0)} m`],
    ['Sunset', w.sunset],
    ['Radiation dose (GCR)', `${ev.dose.toFixed(3)} mSv`],
  ]);
  const usable = ev.limit - ev.reserve;
  shadeStats(); hazardStats();
  const c = [
    [ev.time <= usable ? '' : 'bad', `EVA ${fmtT(ev.time)} h of ${fmtT(usable)} h usable (${P.evaLimitH} h suit − ${P.reserveMin} min reserve)`],
    [ev.minMargin >= 0 ? '' : 'bad', ev.minMargin >= 0 ? `Walk-back always possible – tightest margin ${fmtMin(ev.minMargin)}, farthest point ${fmtMin(ev.maxWalkback)} from the habitat` : `Walk-back NOT covered: ${fmtMin(-ev.minMargin)} short at the worst point`],
    [start >= sunrise + 60 && end <= sunset - 30 ? '' : 'bad', end <= sunset - 30 ? (start >= sunrise + 60 ? `Daylight: back ${Math.round(sunset - end)} min before sunset` : 'Start is less than 1 h after sunrise (cold, low sun)') : 'Return after (or within 30 min of) sunset'],
    [ev.shadeSec > 600 || ev.sunLowest < 10 ? 'warnc' : '', ev.shadeSec > 60 ? `${fmtMin(ev.shadeSec)} of the EVA in terrain shadow (colder, low contrast) · sun at least ${Math.max(0, ev.sunLowest).toFixed(0)}° high` : `In sunlight the whole EVA · sun at least ${Math.max(0, ev.sunLowest).toFixed(0)}° high`],
    [ev.nearM > 0 ? 'warnc' : '', ev.nearM > 0 ? `${ev.nearM.toFixed(0)} m of the route pass within 4 m of no-go terrain` : 'Route keeps more than 4 m away from no-go terrain'],
    [ev.caution > 0 ? 'warnc' : '', ev.caution > 0 ? `${ev.caution.toFixed(0)} m of the route on caution terrain (yellow)` : 'Whole route on easy terrain'],
  ];
  // problems and cautions stay visible; passed checks fold away
  const li = ([k, t]) => `<li class="${k}">${t}</li>`, passed = c.filter(([k]) => !k);
  checks.innerHTML = c.filter(([k]) => k).map(li).join('');
  $('#checksOk').innerHTML = passed.map(li).join('');
  $('#checksOkSum').textContent = `${passed.length} of ${c.length} checks passed · details`;
  const go = !c.some(([k]) => k === 'bad');
  pill.textContent = go ? 'EVA: GO' : 'EVA: NO-GO'; pill.className = `pill ${go ? 'go' : 'nogo'}`;
}

function renderStops() {
  const box = $('#stops'); box.innerHTML = '';
  for (const s of S.sites) {
    const inRoute = S.route.some((it) => it.id === s.id);
    const d = el('div', { className: `stop${inRoute ? ' in' : ''}` },
      `${s.photo ? `<img loading="lazy" src="${s.photo.file}" alt="">` : '<span></span>'}<span><b>${s.label} · ${s.name}</b>${mineralChips(s.x, s.y) || '<small>no clear mineral signal</small>'}</span><button>${inRoute ? '−' : '+'}</button>`);
    d.onclick = () => showCard(s);
    d.querySelector('button').onclick = (e) => { e.stopPropagation(); toggleStop(s.id); };
    box.append(d);
  }
}

function showCard(s) {
  const inRoute = S.route.some((it) => it.id === s.id);
  $('#card').hidden = false;
  $('#cardImg').src = s.photo ? s.photo.file : '';
  $('#cardImg').style.display = s.photo ? '' : 'none';
  $('#cardTitle').textContent = `${s.label} · ${s.name}`;
  $('#cardTask').textContent = s.task;
  $('#cardMeta').innerHTML = (s.photo ? `View from this spot: Curiosity ${s.photo.instrument.startsWith('NAV') ? 'Navcam' : 'Mastcam'}, sol ${s.photo.sol} (${s.photo.date}). <a href="${s.photo.source}" target="_blank" rel="noopener">${s.photo.credit}</a><br>` : '')
    + `Mineral signal from orbit (CRISM): ${mineralText(s.x, s.y)}<br>`
    + `${Math.abs(s.lat).toFixed(5)}°S ${s.lon.toFixed(5)}°E · elevation ${s.elev.toFixed(0)} m · slope ${s.slope.toFixed(0)}° · walk-back ${S.planner.walkback ? fmtMin(S.planner.walkback[S.planner.nearestOpen(S.planner.idx(s.x, s.y))]) : 'n/a'}`;
  const b = $('#cardToggle'); b.textContent = inRoute ? 'Remove from route' : 'Add to route';
  b.onclick = () => { toggleStop(s.id); showCard(s); };
}

function renderWeather() {
  const sols = S.weather.sols, w = sols[0];
  $('#weather').innerHTML = [
    ['Latest REMS report', `sol ${w.sol} · ${w.date}`],
    ['Air temperature', `${w.air_min} … ${w.air_max} °C`],
    ['Ground temperature', `${w.ground_min} … ${w.ground_max} °C`],
    ['Pressure', `${w.pressure} Pa`],
    ['Sky / UV', `${w.opacity} / ${w.uv}`],
    ['Daylight', `${w.sunrise} – ${w.sunset}`],
    ['Season', `Ls ${w.ls}°${w.ls >= 180 ? ' · dust season' : ''}`],
  ].map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  $('#condSum').textContent = `${w.air_max} °C · sunset ${w.sunset}`;
  $('#weatherNote').textContent = `Daily air max/min over the last ${sols.length} reported sols (Curiosity REMS).`;
  const c = $('#spark'), ctx = c.getContext('2d'), W = c.width, H = c.height;
  const xs = sols.slice().reverse(), lo = Math.min(...xs.map((s) => s.air_min)), hi = Math.max(...xs.map((s) => s.air_max));
  const Y = (v) => H - 4 - (v - lo) / (hi - lo) * (H - 8), X = (i) => 2 + i / (xs.length - 1) * (W - 4);
  for (const [key, col] of [['air_max', '#a9411b'], ['air_min', '#2b5c8a']]) {
    ctx.beginPath(); xs.forEach((s, i) => (i ? ctx.lineTo(X(i), Y(s[key])) : ctx.moveTo(X(i), Y(s[key])))); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.fillStyle = '#6a665e'; ctx.font = '10px system-ui'; ctx.fillText(`${hi} °C`, 2, 10); ctx.fillText(`${lo} °C`, 2, H - 2);
  $('#radiation').innerHTML = [
    ['Surface dose rate (GCR)', '0.64 mSv / sol'],
    ['Source', 'MSL RAD mean'],
    ['Space weather', 'no live feed – use drill'],
  ].map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
}

function renderAbout() {
  const m = S.meta, P = S.planner.params;
  $('#aboutBody').innerHTML = `
  <p>All layers are cut to the same ${m.size_m} m box (${m.projection}) by <code>pipeline/build_data.py</code>.</p>
  <table><tr><th>Layer</th><th>Mission / instrument</th><th>Product</th></tr>
  <tr><td>Optical</td><td>MRO HiRISE</td><td><a href="${m.sources.ortho}">MSL Gale orthophoto mosaic</a>, 0.25 m/px, shown at 0.5 m/px (USGS Astrogeology)</td></tr>
  <tr><td>Topography, slope, step height</td><td>MRO HiRISE stereo</td><td><a href="${m.sources.dem}">MSL Gale DEM mosaic</a>, 1 m/px; analysed on a 2 m grid</td></tr>
  <tr><td>Thermal</td><td>Mars Odyssey THEMIS</td><td>Night-time IR controlled mosaic, 100 m/px, via NASA Mars Trek. Relative brightness only (not calibrated thermal inertia); much coarser than the terrain.</td></tr>
  <tr><td>Minerals (spectral)</td><td>MRO CRISM</td><td><a href="${m.sources.minerals}">Targeted spectral summary products</a> (MTRDR), 18 m/px, scenes ${S.min.scenes.join(' and ')} (PDS Geosciences Node). Shown: ${S.min.info.map((x) => `${x.name} = ${x.param}`).join(', ')} (Viviano-Beck et al. 2014). Each scene is stretched from its typical value to its 99.5th percentile, smoothed to about 50 m, and the two are averaged. Agreement of the two scenes inside the box: ${S.min.info.map((x) => `${x.param} r = ${x.check_r}`).join(', ')}. Signals are weak (band depths of 1–2 %), so treat the map as a hint for where to sample.</td></tr>
  <tr><td>Rover traverse &amp; stops</td><td>MSL Curiosity</td><td><a href="${m.sources.waypoints}">Localised waypoints</a> (NASA/JPL-Caltech)</td></tr>
  <tr><td>Ground photos</td><td>MSL Curiosity Navcam</td><td>Raw images, NASA/JPL-Caltech – taken on the sol the rover stood at the stop</td></tr>
  <tr><td>Weather</td><td>MSL Curiosity REMS</td><td>Daily weather report (NASA/JPL-Caltech/CAB), outreach product</td></tr>
  <tr><td>Radiation</td><td>MSL Curiosity RAD</td><td>Mean surface GCR dose equivalent 0.64 mSv/day (Hassler et al., Science 2014) – a constant, not a live feed</td></tr></table>
  <h3>Assumptions (ours, adjustable)</h3>
  <ul>
   <li>No-go above ${P.maxSlope}° slope or ${P.maxStep} m step height; caution above half of that. These are planning values, not NASA suit requirements.</li>
   <li>Walking speed: Tobler’s hiking function scaled to ${P.flatSpeed} m/s on level ground, slowed by step height, cross-slope and cold (loose) ground.</li>
   <li>Walk-back: fastest walk to the habitat from every cell (Dijkstra). A route is GO only if consumables minus reserve cover the walk-back from every point.</li>
   <li>Drills are simulations: the solar storm uses a hypothetical ${STORM_FACTOR}× dose rate (no real space-weather data), the suit leak assumes only the reserve is left, the injured crew member halves the walking speed.</li>
   <li>Safe range: suit time minus reserve, minus the mission time so far, minus the walk home from each cell.</li>
   <li>Stop names and tasks are our mission design. They do not describe Curiosity results.</li>
   <li>Sun: declination from the season (Ls ${S.sunSite.ls}° in the latest REMS report) and Mars’ 25.19° axial tilt; the hour angle is scaled so the sun crosses the horizon at the REMS sunrise and sunset times. Shadows are cast by the 2 m elevation model inside the box only – hills outside it cast none, and no dust or sky brightness is modelled.</li>
   <li>Cuff checklist: headings are straight-line simplifications of the planned path; crew rules on the contingency card are ours.</li>
   <li>Not included yet: the USGS geologic map.</li>
   <li>AI use: the source code and the data pipeline of this app were written with an AI coding assistant (Claude, Anthropic). All maps, photos and measurements are NASA data; none of them is AI-generated.</li>
  </ul>`;
}

function showCuff() {
  if (!S.ev) { toast('Plan a route first – the checklist is built from it.'); return; }
  const ev = S.ev;
  if (!document.querySelector('#cuffCss')) document.head.append(el('style', { id: 'cuffCss', textContent: CUFF_CSS }));
  const stopInfo = ev.events.map((e, i) => {
    const ref = ev.stops[i].ref, p = ref ? itemPos(ref) : null;
    return { kind: e.kind, title: e.name, task: p?.task || '', minerals: p && (ref.type === 'stop' || ref.sci) ? mineralText(p.x, p.y) : '' };
  });
  $('#cuffBody').innerHTML = cuffCards({
    site: $('#siteName').textContent, go: $('#status').classList.contains('go'), startMin: startMin(),
    sunriseMin: S.sunSite.sunrise, sunsetMin: S.sunSite.sunset, params: S.planner.params, ev, stopInfo,
    sunAt: (min) => sunAt(min, S.sunSite), shaded: (x, y, min) => inShadow(S.shGrid, x, y, sunAt(min, S.sunSite)),
  });
  $('#cuffDlg').showModal();
}

let toastT;
function toast(msg) {
  const a = $('#alert'); a.hidden = false; a.innerHTML = msg;
  clearTimeout(toastT); toastT = setTimeout(() => { if (!S.storm) a.hidden = true; }, 5000);
}

// ------------------------------------------------------------------ profile chart
function drawProfile() {
  const c = $('#profile'), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (!r.width) return;
  c.width = r.width * dpr; c.height = r.height * dpr;
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
  const W = r.width, H = r.height, L = 52, Rm = 16, T = 22, B = 30;
  ctx.clearRect(0, 0, W, H); ctx.font = '11px system-ui'; ctx.fillStyle = '#6a665e';
  const ev = S.ev;
  if (!ev) { ctx.fillText('Elevation profile appears once a route exists.', L, H / 2); c._x = null; return; }
  const sm = ev.samples, n = sm.dist.length;
  let z0 = Infinity, z1 = -Infinity; for (const z of sm.z) { if (z < z0) z0 = z; if (z > z1) z1 = z; }
  const pad = Math.max(4, (z1 - z0) * 0.12); z0 -= pad; z1 += pad;
  const X = (d) => L + d / ev.dist * (W - L - Rm), Y = (z) => T + (1 - (z - z0) / (z1 - z0)) * (H - T - B);
  X.inv = (px) => Math.max(0, Math.min(ev.dist, (px - L) / (W - L - Rm) * ev.dist));
  c._x = X;
  ctx.strokeStyle = '#dcd9d0'; ctx.lineWidth = 1;
  const stepZ = (z1 - z0) > 80 ? 20 : 10;
  for (let z = Math.ceil(z0 / stepZ) * stepZ; z < z1; z += stepZ) { ctx.beginPath(); ctx.moveTo(L, Y(z)); ctx.lineTo(W - Rm, Y(z)); ctx.stroke(); ctx.fillText(`${z} m`, 6, Y(z) + 4); }
  const stepD = ev.dist > 3000 ? 500 : 250;
  for (let d = 0; d <= ev.dist; d += stepD) ctx.fillText(d >= 1000 ? `${d / 1000} km` : `${d} m`, X(d) - 10, H - B + 13);
  const COL = ['#2a9d5c', '#d99a00', '#c62828'];
  for (let i = 1; i < n; i++) {
    ctx.beginPath(); ctx.moveTo(X(sm.dist[i - 1]), Y(sm.z[i - 1])); ctx.lineTo(X(sm.dist[i]), Y(sm.z[i]));
    ctx.lineTo(X(sm.dist[i]), H - B); ctx.lineTo(X(sm.dist[i - 1]), H - B); ctx.closePath();
    ctx.fillStyle = COL[sm.cls[i]] + '33'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(X(sm.dist[i - 1]), Y(sm.z[i - 1])); ctx.lineTo(X(sm.dist[i]), Y(sm.z[i]));
    ctx.strokeStyle = COL[sm.cls[i]]; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.textAlign = 'center';
  ev.events.forEach((e, i) => {
    const x = X(e.dist), last = i === ev.events.length - 1;
    ctx.strokeStyle = '#8d897f'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, T - 4); ctx.lineTo(x, H - B); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#1c1b19'; ctx.textAlign = last ? 'right' : 'center';
    ctx.fillText(last ? 'Hab' : (e.kind === 'stop' ? e.name.split(' ')[0] : `W${i + 1}`), last ? x + 4 : x, T - 8);
  });
  ctx.textAlign = 'left';
  // time strip: walking vs science
  const tx = (t) => L + t / ev.time * (W - L - Rm), y = H - 11;
  ctx.fillStyle = '#b9b5aa'; ctx.fillRect(L, y, W - L - Rm, 6);
  ctx.fillStyle = '#6d4bb3'; for (const e of ev.events) if (e.work) ctx.fillRect(tx(e.arrive), y, tx(e.arrive + e.work) - tx(e.arrive), 6);
  ctx.fillStyle = '#6a665e'; ctx.fillText('time', 6, y + 7);
  // cursor
  const st = stateAt(S.t);
  if (st) {
    ctx.strokeStyle = '#1c1b19'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(st.dist), T - 2); ctx.lineTo(X(st.dist), H - B); ctx.stroke();
    ctx.fillStyle = '#1c1b19'; ctx.beginPath(); ctx.arc(X(st.dist), Y(st.z), 4, 0, 7); ctx.fill();
    ctx.fillRect(tx(S.t) - 1, y - 3, 2, 12);
  }
}

// ------------------------------------------------------------------ playback, HUD, storm drill
function stateAt(t) {
  const ev = S.ev; if (!ev) return null;
  const sm = ev.samples, n = sm.time.length;
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (sm.time[m] <= t) lo = m; else hi = m; }
  const span = sm.time[hi] - sm.time[lo], f = span > 0 ? Math.min(1, Math.max(0, (t - sm.time[lo]) / span)) : 0;
  const mix = (a) => a[lo] + (a[hi] - a[lo]) * f;
  // look-ahead point ~10 m further along (skipping the stationary science samples)
  let a = hi; while (a < n - 1 && Math.hypot(sm.x[a] - mix(sm.x), sm.y[a] - mix(sm.y)) < 10) a++;
  let ax = sm.x[a], ay = sm.y[a];
  if (a === n - 1 && Math.hypot(ax - mix(sm.x), ay - mix(sm.y)) < 2) { const b = Math.max(0, lo - 6); ax = 2 * mix(sm.x) - sm.x[b]; ay = 2 * mix(sm.y) - sm.y[b]; }
  return { i: lo, x: mix(sm.x), y: mix(sm.y), z: mix(sm.z), dist: mix(sm.dist), wb: mix(sm.wb), slope: sm.slope[hi], cls: sm.cls[hi], ax, ay };
}

function updateFollow() {
  const st = stateAt(S.t);
  S.scene.setFollow(st ? { x: st.x, y: st.y, ax: st.ax, ay: st.ay } : null);
  if (S.ev) { $('#scrub').value = S.t / S.ev.time * 1000; $('#clock').textContent = `${fmtT(S.t)} / ${fmtT(S.ev.time)} h`; }
  else $('#clock').textContent = '—';
  updateSun(); drawProfile(); updateHud(st);
  if (S.layer === 'range' && Math.abs(S.t - (S.rangeT ?? -1e9)) > 120) drawOverlay();
}

function setMode(mode) {
  S.mode = mode;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  document.body.classList.toggle('immersive', mode === 'hud');
  $('#hud').hidden = mode !== 'hud'; $('#readout').hidden = mode !== 'orbit';
  if (mode !== 'orbit') { setTool(null); $('#card').hidden = true; }
  S.scene.setMode(mode); updateFollow();
  if (mode === 'fly' && S.ev && !S.playing) { if (S.t >= S.ev.time - 1) S.t = 0; setPlaying(true); }
}

function setPlaying(p) { if (p && S.storm) setStorm(false); S.playing = p && !!S.ev; $('#play').textContent = S.playing ? '❚❚' : '▶'; if (S.playing && S.t >= S.ev.time - 1) S.t = 0; }

let lastTick = 0;
function tick(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  if (S.playing && S.ev) {
    // whole EVA in ~80 s; science stops are fast-forwarded
    const st = S.ev.events.find((e) => S.t >= e.arrive && S.t < e.arrive + e.work);
    S.t += dt * (S.ev.walk / 70) * (st ? 4 : 1);
    if (S.t >= S.ev.time) { S.t = S.ev.time; setPlaying(false); }
    updateFollow();
  }
  requestAnimationFrame(tick);
}

function updateHud(st) {
  if (S.mode !== 'hud' || !S.ev || !st) return;
  const ev = S.ev, P = S.planner.params;
  const brg = (Math.atan2(st.ax - st.x, -(st.ay - st.y)) * 180 / Math.PI + 360) % 360;
  // compass tape: 4 px per degree
  const tape = $('#tape'); let html = '';
  for (let d = -60; d <= 60; d += 5) {
    const a = Math.round((brg + d) / 5) * 5, off = (a - brg) * 3.5 + 210, aa = (a + 360) % 360;
    const lab = aa % 90 === 0 ? ['N', 'E', 'S', 'W'][aa / 90] : (aa % 15 === 0 ? String(aa).padStart(3, '0') : '·');
    html += `<span style="left:${off}px;${aa % 90 === 0 ? 'font-weight:700' : 'opacity:.8'}">${lab}</span>`;
  }
  tape.innerHTML = html;
  $('#hElapsed').textContent = fmtT(S.t);
  const left = ev.limit - S.t; $('#hBar').style.width = `${Math.max(0, left / ev.limit * 100)}%`;
  $('#hLeft').textContent = `${fmtT(left)} h of suit time left`;
  const working = ev.events.find((e) => e.work && S.t >= e.arrive && S.t < e.arrive + e.work);
  const next = ev.events.find((e) => e.arrive > S.t);
  const ph = $('#hPhoto');
  if (working) {
    $('#hNextLbl').textContent = 'ON SITE'; $('#hNext').textContent = working.name;
    $('#hNextInfo').textContent = `science time left ${fmtMin(working.arrive + working.work - S.t)}`;
    const site = ev.stops[ev.events.indexOf(working)]?.ref; const s = site && site.type === 'stop' ? itemPos(site) : null;
    if (s?.photo) { ph.hidden = false; ph.querySelector('img').src = s.photo.file; ph.querySelector('span').textContent = `Reference view · Curiosity sol ${s.photo.sol}`; } else ph.hidden = true;
  } else if (next) {
    ph.hidden = true;
    $('#hNextLbl').textContent = 'NEXT'; $('#hNext').textContent = next.name;
    $('#hNextInfo').textContent = `${Math.round(next.dist - st.dist)} m · ETA ${fmtMin(next.arrive - S.t)}`;
  } else { ph.hidden = true; $('#hNextLbl').textContent = 'STATUS'; $('#hNext').textContent = 'At habitat'; $('#hNextInfo').textContent = 'EVA complete'; }
  const sun = S.sunNow, sunDeg = sun ? sun.el * 180 / Math.PI : 0;
  $('#hTerrain').innerHTML = `<span class="${['ok', 'warnc', 'bad'][st.cls]}">${['GO', 'CAUTION', 'NO-GO'][st.cls]}</span> · slope ${st.slope.toFixed(0)}°<br><span class="small">${sunDeg <= 0 ? 'SUN DOWN' : `SUN ${sunDeg.toFixed(0)}° · ${sun && inShadow(S.shGrid, st.x, st.y, sun) ? 'IN SHADE' : 'LIT'}`}${ev.near && ev.near[st.i] ? ' · <span class="warnc">NO-GO CLOSE</span>' : ''}</span>`;
  const stormDose = S.storm && S.storm.type === 'storm' ? (S.storm.wb / 3600) * P.doseRate * STORM_FACTOR : 0;
  $('#hDose').textContent = `dose ${(S.t / 3600 * P.doseRate + stormDose).toFixed(3)} mSv`;
  $('#hWb').textContent = isFinite(st.wb) ? fmtMin(st.wb) : 'n/a';
  const margin = ev.limit - ev.reserve - S.t - st.wb;
  $('#hMargin').innerHTML = `<span class="${margin > 1800 ? 'ok' : margin > 0 ? 'warnc' : 'bad'}">${margin >= 0 ? fmtT(margin) + ' h' : 'NEGATIVE'}</span>`;
}

function setStorm(on) {
  const btn = $('#storm'), a = $('#alert');
  if (!on || !S.ev) { S.storm = null; btn.classList.remove('on'); a.hidden = true; S.scene?.setEscape(null); return; }
  const st = stateAt(S.t), P = S.planner;
  const k = P.nearestOpen(P.idx(st.x, st.y)), path = P.pathToHab(k);
  if (!path) return;
  setPlaying(false);
  let d = 0; for (let i = 1; i < path.length; i++) { const [x0, y0] = P.xy(path[i - 1]), [x1, y1] = P.xy(path[i]); d += Math.hypot(x1 - x0, y1 - y0); }
  const wb = P.walkback[k];
  const type = $('#drillSel').value, Pm = P.params, ev = S.ev;
  S.storm = { wb, d, type }; btn.classList.add('on');
  S.scene.setEscape(path, (c) => P.xy(c));
  const way = `habitat ${Math.round(d)} m away`;
  let head, body;
  if (type === 'leak') {
    // assumption of the drill: the main supply is lost, only the reserve remains
    const spare = Pm.reserveMin * 60 - wb;
    head = `DRILL · SUIT LEAK — only the ${Pm.reserveMin} min reserve is left · ${way} · ${fmtMin(wb)} on foot`;
    body = spare >= 0 ? `You reach the hatch with ${fmtMin(spare)} to spare. Fastest safe way back is shown in red.`
      : `NOT survivable from here: the walk back is ${fmtMin(-spare)} longer than the reserve. Plan inside the white line of the “Safe range” layer, or raise the reserve.`;
  } else if (type === 'injury') {
    // assumption of the drill: an injured crew member halves the walking speed
    const spare = ev.limit - S.t - 2 * wb;
    head = `DRILL · INJURED CREW MEMBER — half walking speed · ${way} · ${fmtMin(2 * wb)} on foot`;
    body = spare >= 0 ? `Suit time left at the hatch: ${fmtT(spare)} h${spare < ev.reserve ? ' – this eats into the reserve' : ''}. Fastest safe way back is shown in red.`
      : `NOT enough suit time: ${fmtMin(-spare)} short even with the reserve. Turn back earlier on this route.`;
  } else {
    const dose = wb / 3600 * Pm.doseRate * STORM_FACTOR, stay = (ev.time - S.t) / 3600 * Pm.doseRate * STORM_FACTOR;
    head = `DRILL · SIMULATED SOLAR PARTICLE EVENT — abort to habitat · ${way} · ${fmtMin(wb)} on foot`;
    body = `Fastest safe way back is shown in red. Hypothetical ${STORM_FACTOR}× dose rate: ${dose.toFixed(3)} mSv on the way back instead of ${stay.toFixed(3)} mSv if the EVA continued.`;
  }
  a.hidden = false;
  a.innerHTML = `${head}<small>${body}</small>`;
  updateHud(st);
}

load().catch((e) => { console.error(e); $('#loading').textContent = `Could not load data: ${e.message}. Serve the web/ folder over HTTP (see README).`; });
