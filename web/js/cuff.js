// Cuff checklist: the planned EVA as small printable cards, in the spirit of the
// wrist-mounted checklists Apollo crews wore on the lunar surface.

const pad3 = (d) => String(Math.round(d) % 360).padStart(3, '0');
const clock = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.floor(min) % 60).padStart(2, '0')}`;
const dur = (s) => { const m = Math.max(0, Math.round(s / 60)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Douglas-Peucker: indices of the points to keep */
function simplify(xs, ys, tol) {
  const keep = new Uint8Array(xs.length); keep[0] = keep[xs.length - 1] = 1;
  const stack = [[0, xs.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const dx = xs[b] - xs[a], dy = ys[b] - ys[a], L = Math.hypot(dx, dy) || 1;
    let worst = -1, wd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((xs[i] - xs[a]) * dy - (ys[i] - ys[a]) * dx) / L;
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return Array.from(keep.keys()).filter((i) => keep[i]);
}

/** a leg as a short list of straight headings: [{hdg, dist, dz, caution}] */
function navSegments(sm, from, to, maxSeg = 6) {
  const xs = sm.x.slice(from, to + 1), ys = sm.y.slice(from, to + 1);
  if (xs.length < 2) return [];
  let idx, tol = 10;
  do { idx = simplify(xs, ys, tol); tol *= 1.5; } while (idx.length - 1 > maxSeg && tol < 400);
  const out = [];
  for (let k = 1; k < idx.length; k++) {
    const a = from + idx[k - 1], b = from + idx[k];
    let caution = 0; for (let i = a; i <= b; i++) if (sm.cls[i] === 1) caution++;
    out.push({
      hdg: (Math.atan2(sm.x[b] - sm.x[a], -(sm.y[b] - sm.y[a])) * 180 / Math.PI + 360) % 360,
      dist: sm.dist[b] - sm.dist[a], dz: sm.z[b] - sm.z[a], caution: caution / (b - a + 1) > 0.25,
    });
  }
  return out;
}

/**
 * d = {
 *   site, go (bool), startMin, sunriseMin, sunsetMin, params, ev,
 *   stopInfo[i] = {title, task, minerals, kind} for ev.events[i],
 *   sunAt(min) -> {el, az} (radians), shaded(x, y, min) -> bool, stormFactor
 * }
 * Returns the HTML of the cards.
 */
export function cuffCards(d) {
  const { ev, params: P } = d, sm = ev.samples, n = ev.events.length;
  const total = n + 2;
  const card = (i, title, body) => `<div class="cuffcard"><div class="rings"><i></i><i></i><i></i></div>
    <div class="hd"><b>${title}</b><span>EVA-1 · ${i}/${total}</span></div>${body}</div>`;
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  const usable = ev.limit - ev.reserve;
  const cards = [];

  cards.push(card(1, 'EVA OVERVIEW', `
    <p class="site">${d.site}</p>
    <table class="kv">
      ${row('EGRESS', `${clock(d.startMin)} local`)}
      ${row('INGRESS (PLAN)', `${clock(d.startMin + ev.time / 60)} · ${dur(ev.time)} h`)}
      ${row('SUNSET', clock(d.sunsetMin))}
      ${row('SUIT / RESERVE', `${P.evaLimitH} h / ${P.reserveMin} min`)}
      ${row('HARD LIMIT', `${clock(d.startMin + usable / 60)} at hatch`)}
      ${row('DISTANCE', `${(ev.dist / 1000).toFixed(2)} km · +${ev.up.toFixed(0)} / −${ev.down.toFixed(0)} m`)}
      ${row('FARTHEST POINT', `${Math.round(ev.maxWalkback / 60)} min walk-back`)}
      ${row('DOSE (PLAN)', `${ev.dose.toFixed(3)} mSv`)}
    </table>
    <p class="verdict ${d.go ? 'go' : 'nogo'}">${d.go ? 'PLAN IS GO' : 'PLAN IS NO-GO – REPLAN BEFORE EGRESS'}</p>
    <p class="rule">BINGO = latest time to leave a stop and still reach the hatch with the reserve untouched and 30 min before sunset.</p>
    <ol class="stops">${ev.events.map((e, i) => `<li>${d.stopInfo[i].title} <span>${clock(d.startMin + e.arrive / 60)}</span></li>`).join('')}</ol>`));

  let from = 0;
  ev.events.forEach((e, i) => {
    const info = d.stopInfo[i], to = e.sample;
    const segs = navSegments(sm, from, to);
    const arriveMin = d.startMin + e.arrive / 60, sun = d.sunAt(arriveMin);
    const wb = sm.wb[to];
    const bingo = Math.min(usable - wb, (d.sunsetMin - 30 - d.startMin) * 60 - wb);
    const depart = e.arrive + e.work;
    const nav = `<table class="nav"><tr><th>HDG</th><th></th><th>DIST</th><th>ΔH</th><th></th></tr>${segs.map((s) =>
      `<tr><td>${pad3(s.hdg)}°</td><td>${COMPASS[Math.round(s.hdg / 45) % 8]}</td><td>${Math.max(5, Math.round(s.dist / 5) * 5)} m</td><td>${s.dz >= 0 ? '+' : '−'}${Math.abs(s.dz).toFixed(0)} m</td><td>${s.caution ? 'CAUTION' : ''}</td></tr>`).join('')}</table>`;
    const legLine = `<p class="leg">${Math.round(e.dist - sm.dist[from])} m · ${Math.round((e.arrive - sm.time[from]) / 60)} min · ARRIVE <b>${clock(arriveMin)}</b> (${dur(e.arrive)})</p>`;
    const body = info.kind === 'hab'
      ? `${nav}${legLine}
         <ul class="todo"><li>Call "at hatch" to habitat</li><li>Dust off suit and sample bags</li><li>Ingress, repress, doff</li></ul>
         <p class="rule">Margin at hatch: ${dur(usable - ev.time)} h before the reserve is touched.</p>`
      : `${nav}${legLine}
         <div class="onsite"><b>ON SITE${e.work ? ` · ${Math.round(e.work / 60)} MIN` : ' · PASS THROUGH'}</b>
         ${info.task ? `<p>${info.task}</p>` : ''}
         ${info.minerals ? `<p class="min">ORBIT SAYS: ${info.minerals}</p>` : ''}
         ${e.work ? '<ul class="todo"><li>Panorama + scale photo</li><li>Sample, bag no. ____</li><li>Comm check, suit status</li></ul>' : ''}</div>
         <table class="kv tight">
           ${row('SUN', `${Math.round(sun.el * 180 / Math.PI)}° high, bearing ${pad3(sun.az * 180 / Math.PI)}°${d.shaded(sm.x[to], sm.y[to], arriveMin) ? ' · SITE IN SHADE' : ''}`)}
           ${row('WALK-BACK', `${Math.round(wb / 60)} min`)}
           ${row('DEPART (PLAN)', clock(d.startMin + depart / 60))}
           ${row('BINGO', `<b>${bingo > depart ? clock(d.startMin + bingo / 60) : 'NONE – DO NOT GO'}</b>`)}
         </table>`;
    cards.push(card(i + 2, `LEG ${i + 1} → ${info.title.toUpperCase()}`, body));
    from = Math.min(sm.x.length - 1, to + (e.work ? 1 : 0));
  });

  cards.push(card(total, 'CONTINGENCY', `
    <div class="onsite"><b>SOLAR STORM / RADIATION ALARM</b>
      <p>Stop work. Walk back by the fastest safe way (red line on the wrist map). Do not shortcut across red terrain.</p></div>
    <div class="onsite"><b>PAST BINGO</b>
      <p>Skip the remaining stops. Return directly. Call habitat.</p></div>
    <div class="onsite"><b>LOSS OF COMM &gt; 10 MIN</b>
      <p>Return to the last point with contact, then to the habitat.</p></div>
    <div class="onsite"><b>SUIT WARNING</b>
      <p>Buddy check. Abort to habitat. Farthest point of this plan is ${Math.round(ev.maxWalkback / 60)} min out; reserve is ${P.reserveMin} min.</p></div>
    <p class="rule">Crew rules above are planning assumptions of this tool, not NASA flight rules.</p>`));
  return cards.join('');
}

export const CUFF_CSS = `
.cuff { display: grid; grid-template-columns: repeat(auto-fill, 86mm); gap: 8mm; justify-content: center; }
.cuffcard { position: relative; width: 86mm; min-height: 118mm; background: #fbfaf5; color: #111; border: 1px solid #222; border-radius: 3mm;
  padding: 5mm 5mm 4mm 11mm; font: 8.6pt/1.3 "Consolas", "Courier New", monospace; break-inside: avoid; page-break-inside: avoid; }
.cuffcard .rings { position: absolute; left: 2.5mm; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: space-evenly; }
.cuffcard .rings i { width: 4mm; height: 4mm; border-radius: 50%; border: 1px solid #222; background: #d9d6cc; }
.cuffcard .hd { display: flex; justify-content: space-between; align-items: baseline; gap: 3mm; border-bottom: 2px solid #111; padding-bottom: 1mm; margin-bottom: 2mm; }
.cuffcard .hd b { font-size: 10pt; letter-spacing: .03em; } .cuffcard .hd span { font-size: 7pt; white-space: nowrap; }
.cuffcard p { margin: 1.2mm 0; } .cuffcard .site { font-size: 7.5pt; }
.cuffcard table { border-collapse: collapse; width: 100%; margin: 1.5mm 0; }
.cuffcard .kv td { padding: .5mm 0; border-bottom: 1px dotted #888; vertical-align: top; } .cuffcard .kv td:last-child { text-align: right; }
.cuffcard .kv td:first-child { font-size: 7.5pt; letter-spacing: .04em; white-space: nowrap; padding-right: 2mm; }
.cuffcard .nav th { text-align: left; font-size: 7pt; border-bottom: 1px solid #111; } .cuffcard .nav td { padding: .4mm 1mm .4mm 0; font-weight: 700; }
.cuffcard .nav td:last-child { font-size: 7pt; font-weight: 400; }
.cuffcard .leg { border-top: 1px solid #111; padding-top: 1mm; }
.cuffcard .onsite { border: 1px solid #111; border-radius: 1.5mm; padding: 1.2mm 2mm; margin: 2mm 0; } .cuffcard .onsite p { font-size: 8pt; }
.cuffcard .min { font-size: 7.5pt !important; }
.cuffcard .todo { list-style: none; margin: 1mm 0; padding: 0; } .cuffcard .todo li::before { content: "☐ "; }
.cuffcard .stops { margin: 1.5mm 0 0; padding-left: 5mm; font-size: 8pt; } .cuffcard .stops li span { float: right; }
.cuffcard .verdict { text-align: center; font-weight: 700; border: 2px solid #111; padding: 1mm; margin: 2mm 0; } .cuffcard .verdict.nogo { background: #111; color: #fff; }
.cuffcard .rule { font-size: 7pt; color: #333; }
`;

/** open the cards in their own window and start printing */
export function printCuff(html, title) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    @page { margin: 10mm; } body { margin: 0; background: #fff; } ${CUFF_CSS}
    .cuff { justify-content: start; gap: 6mm; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    </style></head><body><div class="cuff">${html}</div></body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
  return true;
}
