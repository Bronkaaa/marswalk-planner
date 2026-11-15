"""Marswalk Planner - data pipeline.

Cuts a 2048 m x 2048 m box out of NASA/USGS data products for the boxwork
region on Mount Sharp (Gale crater) and writes everything the static web app
needs into web/data/.

Sources (all public NASA / USGS):
  * MSL Gale DEM mosaic, 1 m/px (HiRISE stereo)        - USGS Astrogeology
  * MSL Gale orthophoto mosaic, 0.25 m/px (HiRISE)     - USGS Astrogeology
  * THEMIS night-time IR controlled mosaic, 100 m/px   - NASA Mars Trek WMTS
  * CRISM targeted spectral summary products, 18 m/px  - PDS Geosciences Node
  * Curiosity waypoints (position per sol)             - NASA/JPL MMGIS
  * Curiosity raw images                               - NASA/JPL raw image API
  * REMS weather reports                               - NASA/JPL/CAB feed

Run:  .venv/Scripts/python pipeline/build_data.py
Raw downloads are cached in pipeline/raw/, so re-runs are fast.
"""
from __future__ import annotations

import io
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("VSI_CACHE_SIZE", "200000000")
os.environ.setdefault("CPL_VSIL_CURL_CHUNK_SIZE", "1048576")

import rasterio  # noqa: E402
from rasterio.enums import Resampling  # noqa: E402
from rasterio.windows import from_bounds  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "pipeline" / "raw"
OUT = ROOT / "web" / "data"
RAW.mkdir(parents=True, exist_ok=True)
(OUT / "photos").mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- study box
R_MARS = 3396190.0            # sphere radius of the map projection (m)
SIZE_M = 2048                 # box edge length (m)
X0, Y_TOP = 8142376.0, -284076.0   # north-west corner, equirectangular metres
X1, Y_BOT = X0 + SIZE_M, Y_TOP - SIZE_M
GRID = 1024                   # analysis grid (2 m cells)
CELL = SIZE_M / GRID
ORTHO_PX = 4096               # texture size (0.5 m/px)

S3 = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/"
DEM_URL = S3 + "MSL_Gale_DEM_Mosaic_1m_v3.tif"
ORTHO_URL = S3 + "MSL_Gale_Orthophoto_Mosaic_25cm_v3.tif"
THEMIS = ("https://trek.nasa.gov/tiles/Mars/EQ/"
          "THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018/1.0.0/default/default028mm")
WAYPOINTS_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"
WEATHER_URL = "https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json"
RAW_API = "https://mars.nasa.gov/api/v1/raw_image_items/"

# CRISM map-projected targeted products (MTRDR), "SR" = refined spectral summary parameters.
# Two independent observations of the same ground; the app shows the mean of both.
CRISM_BASE = ("https://pds-geosciences.wustl.edu/mro/mro-m-crism-5-rdr-mptargeted-v1/"
              "mrocr_4001/mtrdr/")
CRISM_SCENES = ["2008/2008_191/frt0000b6f1/frt0000b6f1_07_sr165j_mtr3",
                "2007/2007_112/frt000058a3/frt000058a3_07_sr165j_mtr3"]
MIN_GRID = 512                # mineral layers are stored on a 4 m grid (CRISM pixels are 18 m)
# (id, CRISM parameter, name, what a high value points to, colour)  - Viviano-Beck et al. 2014
MINERALS = [
    ("sulf", "SINDEX2", "Sulfates", "hydrated sulfate minerals of any kind", [255, 214, 64]),
    ("mono", "BD2100_2", "Monohydrated sulfate", "kieserite-like sulfate with one water per formula unit", [255, 128, 48]),
    ("hyd", "BD1900_2", "Bound water", "water-bearing minerals: polyhydrated sulfate, clay, hydrated silica", [70, 170, 255]),
    ("clay", "D2300", "Fe/Mg clay", "iron-magnesium clay minerals (smectite)", [70, 230, 130]),
    ("pyx", "HCPINDEX2", "Pyroxene", "unaltered basaltic material such as dark sand", [200, 110, 255]),
]

UA = {"User-Agent": "marswalk-planner-pipeline/1.0"}


def log(*a):
    print(*a, flush=True)


def fetch(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def lonlat(x: float, y: float) -> tuple[float, float]:
    return math.degrees(x / R_MARS), math.degrees(y / R_MARS)


# ---------------------------------------------------------------- terrain
def load_dem() -> np.ndarray:
    cache = RAW / "dem_1m.npy"
    if cache.exists():
        return np.load(cache)
    log("reading DEM window (1 m/px) ...")
    with rasterio.open("/vsicurl/" + DEM_URL) as ds:
        win = from_bounds(X0, Y_BOT, X1, Y_TOP, ds.transform)
        a = ds.read(1, window=win).astype(np.float32)
        nodata = ds.nodata
    assert a.shape == (SIZE_M, SIZE_M), a.shape
    if nodata is not None:
        a[a == nodata] = np.nan
    np.save(cache, a)
    return a


def load_ortho() -> np.ndarray:
    cache = RAW / "ortho.npy"
    if cache.exists():
        return np.load(cache)
    log("reading orthophoto window (0.25 m/px -> 0.5 m/px), this takes a while ...")
    with rasterio.open("/vsicurl/" + ORTHO_URL) as ds:
        win = from_bounds(X0, Y_BOT, X1, Y_TOP, ds.transform)
        a = ds.read(1, window=win, out_shape=(ORTHO_PX, ORTHO_PX),
                    resampling=Resampling.average)
    np.save(cache, a)
    return a


def box_mean(a: np.ndarray, k: int) -> np.ndarray:
    """k x k moving average with edge replication (integral image)."""
    p = k // 2
    ap = np.pad(a.astype(np.float64), p, mode="edge")
    c = np.cumsum(np.cumsum(ap, axis=0), axis=1)
    c = np.pad(c, ((1, 0), (1, 0)))
    h, w = a.shape
    s = c[k:k + h, k:k + w] - c[:h, k:k + w] - c[k:k + h, :w] + c[:h, :w]
    return (s / (k * k)).astype(np.float32)


def fill_nan(a: np.ndarray) -> np.ndarray:
    if not np.isnan(a).any():
        return a
    log("  filling", int(np.isnan(a).sum()), "no-data cells")
    a = a.copy()
    for _ in range(200):
        m = np.isnan(a)
        if not m.any():
            break
        ap = np.pad(a, 1, mode="edge")
        stack = np.stack([ap[:-2, 1:-1], ap[2:, 1:-1], ap[1:-1, :-2], ap[1:-1, 2:]])
        a[m] = np.nanmean(stack, axis=0)[m]
    return np.nan_to_num(a, nan=float(np.nanmean(a)))


def terrain_products(dem1: np.ndarray):
    dem1 = fill_nan(dem1)
    f = SIZE_M // GRID
    dem2 = dem1.reshape(GRID, f, GRID, f).mean(axis=(1, 3)).astype(np.float32)

    # slope (Horn, 3x3 on the 2 m grid)
    z = np.pad(dem2, 1, mode="edge")
    dzdx = ((z[:-2, 2:] + 2 * z[1:-1, 2:] + z[2:, 2:]) -
            (z[:-2, :-2] + 2 * z[1:-1, :-2] + z[2:, :-2])) / (8 * CELL)
    dzdy = ((z[2:, :-2] + 2 * z[2:, 1:-1] + z[2:, 2:]) -
            (z[:-2, :-2] + 2 * z[:-2, 1:-1] + z[:-2, 2:])) / (8 * CELL)
    slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy))).astype(np.float32)

    # roughness: largest deviation of the 1 m surface from its 5 m mean,
    # i.e. the step / block height an astronaut has to negotiate (metres)
    resid = np.abs(dem1 - box_mean(dem1, 5))
    rough = resid.reshape(GRID, f, GRID, f).max(axis=(1, 3)).astype(np.float32)
    return dem2, slope, rough


# ---------------------------------------------------------------- thermal
def themis_layer() -> np.ndarray:
    """THEMIS night IR (relative brightness temperature) resampled to the grid."""
    cache = RAW / "themis.npy"
    if cache.exists():
        return np.load(cache)
    log("fetching THEMIS night-IR tiles from Mars Trek ...")
    z = 9
    deg_per_tile = 180.0 / 2 ** z
    px_per_deg = 256 / deg_per_tile
    lon0, lat_t = lonlat(X0, Y_TOP)
    lon1, lat_b = lonlat(X1, Y_BOT)
    pad = 0.01
    c0 = int((lon0 - pad + 180) // deg_per_tile)
    c1 = int((lon1 + pad + 180) // deg_per_tile)
    r0 = int((90 - (lat_t + pad)) // deg_per_tile)
    r1 = int((90 - (lat_b - pad)) // deg_per_tile)
    mosaic = np.zeros(((r1 - r0 + 1) * 256, (c1 - c0 + 1) * 256), np.float32)
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            img = Image.open(io.BytesIO(fetch(f"{THEMIS}/{z}/{r}/{c}.png"))).convert("L")
            mosaic[(r - r0) * 256:(r - r0 + 1) * 256,
                   (c - c0) * 256:(c - c0 + 1) * 256] = np.asarray(img, np.float32)
    # bilinear sample at every grid cell centre
    xs = X0 + (np.arange(GRID) + 0.5) * CELL
    ys = Y_TOP - (np.arange(GRID) + 0.5) * CELL
    lon = np.degrees(xs / R_MARS)
    lat = np.degrees(ys / R_MARS)
    px = (lon + 180) * px_per_deg - c0 * 256 - 0.5
    py = (90 - lat) * px_per_deg - r0 * 256 - 0.5
    PX, PY = np.meshgrid(px, py)
    x0i = np.floor(PX).astype(int)
    y0i = np.floor(PY).astype(int)
    fx, fy = PX - x0i, PY - y0i
    g = lambda yy, xx: mosaic[np.clip(yy, 0, mosaic.shape[0] - 1),
                              np.clip(xx, 0, mosaic.shape[1] - 1)]
    out = (g(y0i, x0i) * (1 - fx) * (1 - fy) + g(y0i, x0i + 1) * fx * (1 - fy) +
           g(y0i + 1, x0i) * (1 - fx) * fy + g(y0i + 1, x0i + 1) * fx * fy)
    out = out.astype(np.float32)
    np.save(cache, out)
    return out


# ---------------------------------------------------------------- minerals
def crism_layers():
    """CRISM spectral summary parameters resampled to the box.

    Returns (uint8 array [layer, MIN_GRID, MIN_GRID], metadata list). Each scene is stretched
    from max(0, scene median) to its 99.5th percentile, so 0 means "no more than typical for
    this scene" and 1 "among the strongest signals in the scene"; the two scenes are averaged.
    """
    import re

    def scene(path: str):
        name = path.rsplit("/", 1)[1]
        for ext in (".lbl", ".img"):
            f = RAW / (name + ext)
            if not f.exists():
                log("downloading", name + ext, "...")
                f.write_bytes(fetch(CRISM_BASE + path + ext, timeout=600))
        lbl = (RAW / (name + ".lbl")).read_text(encoding="latin1")
        bands = re.findall(r'"([A-Z0-9_]+)"', lbl[lbl.index("BAND_NAME"):])
        return rasterio.open(RAW / (name + ".lbl")), bands

    def median3(a):
        ap = np.pad(a, 1, mode="edge")
        h, w = a.shape
        return np.nanmedian(np.stack([ap[i:i + h, j:j + w] for i in range(3) for j in range(3)]), axis=0)

    def sample(ds, a):
        """bilinear sample of a full CRISM band at the centres of the MIN_GRID cells"""
        step = SIZE_M / MIN_GRID
        xs = X0 + (np.arange(MIN_GRID) + 0.5) * step
        ys = Y_TOP - (np.arange(MIN_GRID) + 0.5) * step
        t = ds.transform
        PX, PY = np.meshgrid((xs - t.c) / t.a - 0.5, (ys - t.f) / t.e - 0.5)
        x0i, y0i = np.floor(PX).astype(int), np.floor(PY).astype(int)
        fx, fy = PX - x0i, PY - y0i
        g = lambda yy, xx: a[np.clip(yy, 0, a.shape[0] - 1), np.clip(xx, 0, a.shape[1] - 1)]
        return (g(y0i, x0i) * (1 - fx) * (1 - fy) + g(y0i, x0i + 1) * fx * (1 - fy) +
                g(y0i + 1, x0i) * (1 - fx) * fy + g(y0i + 1, x0i + 1) * fx * fy)

    def layer(ds, bands, param):
        """one parameter of one scene: de-speckled, stretched to 0..1 within the scene, cut to the box"""
        a = ds.read(bands.index(param) + 1).astype(np.float64)
        a[(a > 1e4) | (a < -1e4)] = np.nan
        lo = max(0.0, float(np.nanmedian(a)))
        hi = float(np.nanpercentile(a, 99.5))
        a = np.nan_to_num(a, nan=lo)
        a = median3(a)
        for _ in range(3):              # three 3x3 box blurs ~ Gaussian, sigma about 25 m
            a = box_mean(a, 3)
        if hi - lo < 0.003:             # parameter never rises above noise in this scene
            return np.zeros((MIN_GRID, MIN_GRID)), lo, hi
        return np.clip((sample(ds, a) - lo) / (hi - lo), 0, 1), lo, hi

    scenes = [scene(pth) for pth in CRISM_SCENES]
    out, info = [], []
    for mid, param, name, desc, color in MINERALS:
        (ta, lo, hi), (tb, _, _) = (layer(ds, bands, param) for ds, bands in scenes)
        r = float(np.corrcoef(ta.ravel(), tb.ravel())[0, 1]) if ta.std() > 0 and tb.std() > 0 else 0.0
        t = (ta + tb) / 2               # mean of the two observations
        log(f"  CRISM {param:10s} stretch {lo:.4f}..{hi:.4f}  box mean {t.mean():.2f}  "
            f"strong(>0.5) {100 * (t > 0.5).mean():.0f}%  agreement of the two scenes r = {r:.2f}")
        out.append((t * 255).astype(np.uint8))
        info.append({"id": mid, "param": param, "name": name, "desc": desc, "color": color,
                     "lo": round(lo, 5), "hi": round(hi, 5), "check_r": round(r, 2)})
    return np.stack(out), info


# ---------------------------------------------------------------- rover data
def load_waypoints() -> list[dict]:
    cache = RAW / "MSL_waypoints.json"
    if not cache.exists():
        cache.write_bytes(fetch(WAYPOINTS_URL))
    feats = json.loads(cache.read_text())["features"]
    pts = []
    for f in feats:
        p = f["properties"]
        x, y = p["easting"], p["northing"]
        if X0 <= x <= X1 and Y_BOT <= y <= Y_TOP:
            pts.append({"sol": int(p["sol"]), "x": round(x - X0, 1),
                        "y": round(Y_TOP - y, 1), "elev": round(p["elev_geoid"], 1),
                        "lon": p["lon"], "lat": p["lat"]})
    pts.sort(key=lambda q: q["sol"])
    return pts


INSTR_PREF = ["NAV_LEFT_B", "NAV_RIGHT_B", "NAV_LEFT_A", "NAV_RIGHT_A",
              "MAST_LEFT", "MAST_RIGHT", "FHAZ_LEFT_B", "FHAZ_RIGHT_B"]


def raw_images(sol_from: int, sol_to: int) -> list[dict]:
    q = {
        "order": "sol asc,instrument_sort asc,sample_type_sort asc,date_taken asc",
        "per_page": "200", "page": "0",
        "condition_1": "msl:mission",
        "condition_2": f"{sol_from}:sol:gte",
        "condition_3": f"{sol_to}:sol:lte",
        "search": "", "extended": "thumbnail::sample_type::noteq",
    }
    items, page = [], 0
    while page < 6:
        q["page"] = str(page)
        d = json.loads(fetch(RAW_API + "?" + urllib.parse.urlencode(q)))
        items += d.get("items", [])
        if not d.get("more"):
            break
        page += 1
    return items


def pick_photo(site_id: str, sol: int) -> dict | None:
    """Best wide ground-level image taken at (or right after arriving at) a stop."""
    meta_cache = RAW / f"photo_{site_id}.json"
    out = OUT / "photos" / f"{site_id}.jpg"
    if meta_cache.exists() and out.exists():
        return json.loads(meta_cache.read_text())
    try:
        items = raw_images(sol, sol + 1)
    except Exception as e:  # network hiccup: app still works without a photo
        log("  raw image query failed:", e)
        return None
    best = None
    for it in items:
        ins = it.get("instrument", "")
        if ins not in INSTR_PREF:
            continue
        if (it.get("extended") or {}).get("sample_type") != "full":
            continue
        rank = (INSTR_PREF.index(ins), it["sol"])
        if best is None or rank < best[0]:
            best = (rank, it)
    if best is None:
        return None
    it = best[1]
    try:
        img = Image.open(io.BytesIO(fetch(it["https_url"]))).convert("RGB")
    except Exception as e:
        log("  image download failed:", e)
        return None
    img.thumbnail((1024, 1024))
    img.save(out, quality=85)
    meta = {"file": f"data/photos/{site_id}.jpg", "sol": it["sol"],
            "instrument": it["instrument"], "date": it["date_taken"][:10],
            "credit": it.get("image_credit", "NASA/JPL-Caltech"),
            "source": "https://mars.nasa.gov" + it["link"], "imageid": it["imageid"]}
    meta_cache.write_text(json.dumps(meta))
    return meta


def weather() -> dict:
    cache = RAW / "rems_weather.json"
    if not cache.exists():
        cache.write_bytes(fetch(WEATHER_URL))
    soles = json.loads(cache.read_text())["soles"]

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    recs = []
    for s in soles[:90]:
        recs.append({
            "sol": int(s["sol"]), "date": s["terrestrial_date"], "ls": num(s["ls"]),
            "air_min": num(s["min_temp"]), "air_max": num(s["max_temp"]),
            "ground_min": num(s["min_gts_temp"]), "ground_max": num(s["max_gts_temp"]),
            "pressure": num(s["pressure"]), "opacity": s["atmo_opacity"],
            "uv": s["local_uv_irradiance_index"],
            "sunrise": s["sunrise"], "sunset": s["sunset"],
        })
    recs = [r for r in recs if r["air_max"] is not None]
    return {"source": "REMS weather report, NASA/JPL-Caltech/CAB(CSIC-INTA)",
            "note": "Outreach product measured at the rover; latest sols available at build time.",
            "sols": recs}


# ---------------------------------------------------------------- main
def main():
    dem1 = load_dem()
    log("DEM", dem1.shape, "elev", float(np.nanmin(dem1)), float(np.nanmax(dem1)),
        "nodata", int(np.isnan(dem1).sum()))
    dem2, slope, rough = terrain_products(dem1)
    log("slope deg  p50/p90/p99:", *np.percentile(slope, [50, 90, 99]).round(1))
    log("rough m    p50/p90/p99:", *np.percentile(rough, [50, 90, 99]).round(2))

    dem2.astype("<f4").tofile(OUT / "dem.bin")
    np.clip(slope * 4, 0, 255).astype(np.uint8).tofile(OUT / "slope.bin")     # 0.25 deg
    np.clip(rough * 100, 0, 255).astype(np.uint8).tofile(OUT / "rough.bin")   # cm

    th = themis_layer()
    lo, hi = np.percentile(th, [1, 99])
    thn = np.clip((th - lo) / max(hi - lo, 1e-6), 0, 1)
    (thn * 255).astype(np.uint8).tofile(OUT / "thermal.bin")
    log("THEMIS DN range in box:", float(th.min()), float(th.max()))

    log("CRISM mineral layers ...")
    minerals, mineral_info = crism_layers()
    minerals.tofile(OUT / "minerals.bin")

    ortho = load_ortho()
    lo, hi = np.percentile(ortho[ortho > 0], [0.5, 99.5])
    o8 = (np.clip((ortho.astype(np.float32) - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)
    Image.fromarray(o8, "L").save(OUT / "ortho.jpg", quality=88)
    log("ortho written", o8.shape)

    wps = load_waypoints()
    log("rover waypoints in box:", len(wps), "sols", wps[0]["sol"], "-", wps[-1]["sol"])
    (OUT / "traverse.json").write_text(json.dumps(wps))

    # Science stops: rover positions spread along the traverse (>= 230 m apart),
    # so every stop has ground-level imagery from that very place.
    stops, last = [], None
    for w in wps:
        if last is None or math.hypot(w["x"] - last["x"], w["y"] - last["y"]) >= 230:
            stops.append(w)
            last = w
    sites = []
    for i, w in enumerate(stops):
        sid = f"s{i + 1:02d}"
        ix = min(GRID - 1, int(w["x"] / CELL))
        iy = min(GRID - 1, int(w["y"] / CELL))
        photo = pick_photo(sid, w["sol"])
        log(f"  stop {sid} sol {w['sol']} photo:", photo["instrument"] if photo else None)
        sites.append({"id": sid, "x": w["x"], "y": w["y"], "sol": w["sol"],
                      "lon": w["lon"], "lat": w["lat"],
                      "elev": round(float(dem2[iy, ix]), 1),
                      "slope": round(float(slope[iy, ix]), 1), "photo": photo})
    (OUT / "sites.json").write_text(json.dumps(sites, indent=1))

    (OUT / "weather.json").write_text(json.dumps(weather(), indent=1))

    lon0, lat_t = lonlat(X0, Y_TOP)
    lon1, lat_b = lonlat(X1, Y_BOT)
    meta = {
        "name": "Boxwork region, Mount Sharp (Aeolis Mons), Gale crater",
        "grid": GRID, "cell_m": CELL, "size_m": SIZE_M,
        "projection": "Equirectangular, sphere R=3396190 m",
        "x0": X0, "y_top": Y_TOP,
        "lon_w": lon0, "lon_e": lon1, "lat_n": lat_t, "lat_s": lat_b,
        "elev_min": float(dem2.min()), "elev_max": float(dem2.max()),
        "encoding": {"dem": "float32 LE metres", "slope": "uint8, 0.25 deg/unit",
                     "rough": "uint8, cm", "thermal": "uint8, relative night IR (1-99 pct stretch)"},
        "minerals": {
            "grid": MIN_GRID, "pixel_m": 18, "layers": mineral_info,
            "scenes": [c.rsplit("/", 1)[1].split("_")[0].upper() for c in CRISM_SCENES],
            "encoding": "uint8 per layer, mean of both scenes; 0 = scene-typical or below, 255 = 99.5th percentile"},
        "sources": {
            "dem": DEM_URL, "ortho": ORTHO_URL, "thermal": THEMIS,
            "minerals": CRISM_BASE + CRISM_SCENES[0] + ".lbl",
            "waypoints": WAYPOINTS_URL, "weather": WEATHER_URL, "raw_images": RAW_API},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    log("done ->", OUT)


if __name__ == "__main__":
    sys.exit(main())
