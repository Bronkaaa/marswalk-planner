// Sun position at the site and terrain shadow test.
// Pure logic, no DOM.

const RAD = Math.PI / 180;
export const MARS_OBLIQUITY = 25.19; // deg

/**
 * Sun elevation and azimuth for a local clock time.
 * site: {lat (deg, north positive), ls (deg, solar longitude = season), sunrise, sunset (minutes of the local day)}
 * Declination follows from the season (Ls). The hour angle is scaled so that the sun crosses the
 * horizon exactly at the sunrise / sunset times reported by the rover's weather station, which keeps
 * the picture consistent with the daylight check of the EVA budget.
 * Returns {el, az} in radians; az is clockwise from north.
 */
export function sunAt(min, site) {
  const phi = site.lat * RAD;
  const dec = Math.asin(Math.sin(MARS_OBLIQUITY * RAD) * Math.sin(site.ls * RAD));
  const h0 = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec))));
  const noon = (site.sunrise + site.sunset) / 2, half = (site.sunset - site.sunrise) / 2;
  const h = (min - noon) / half * h0;
  const up = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h);
  const east = -Math.cos(dec) * Math.sin(h);
  const north = Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(h);
  return { el: Math.asin(Math.max(-1, Math.min(1, up))), az: (Math.atan2(east, north) + 2 * Math.PI) % (2 * Math.PI) };
}

/**
 * Is the point (x east, y south, metres in the box) in terrain shadow?
 * Marches from 1.5 m above the ground towards the sun over the elevation grid.
 * grid: {n, cell, dem, elevMax}
 */
export function inShadow(grid, x, y, sun) {
  if (sun.el <= 0) return true;
  const { n, cell, dem } = grid;
  const dx = Math.sin(sun.az), dy = -Math.cos(sun.az), rise = Math.tan(sun.el);
  const at = (px, py) => {
    const i = Math.floor(px / cell), j = Math.floor(py / cell);
    return i < 0 || j < 0 || i >= n || j >= n ? null : dem[j * n + i];
  };
  const z0 = at(x, y);
  if (z0 === null) return false;
  for (let d = cell * 1.5; ; d += cell) {
    const h = z0 + 1.5 + d * rise;
    if (h > grid.elevMax) return false;
    const z = at(x + dx * d, y + dy * d);
    if (z === null) return false;
    if (z > h) return true;
  }
}
