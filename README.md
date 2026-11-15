# Marswalk Planner

A 3D planning and navigation tool for a crewed surface excursion ("Marswalk") in the
boxwork region on Mount Sharp, Gale crater. Built for the NASA Space Apps Challenge.

It layers data from several NASA missions over a 2 × 2 km box at walking scale, finds a
safe route on foot between science stops, and checks the excursion against suit
endurance, walk-back time, daylight and radiation dose.

## Run it

The app is static. Serve the `web/` folder over HTTP and open it in a browser:

```
cd web
python -m http.server 8137
# open http://localhost:8137
```

No build step, no internet needed at runtime (three.js is vendored in `web/vendor/`).
To publish, upload the contents of `web/` to any static host (GitHub Pages, Netlify).

## What it does

- **3D terrain** from the HiRISE stereo DEM, textured with the HiRISE orthophoto.
- **Data layers**: traversability (go / caution / no-go), slope, step height, THEMIS
  night-time infrared, CRISM mineral signals, elevation contours, walk-back time to the
  habitat.
- **Mineral map**: where sulfates, monohydrated sulfate, bound water, clay and pyroxene
  show from orbit. Every stop lists its signal, and "Add sample site" adds your own
  science stop on a signal you want to check on the ground.
- **Sun and shadows**: the sun moves with the EVA clock (or a time slider); the terrain
  casts shadows, and the budget reports how long the crew walks in shade.
- **Cuff checklist**: the plan as printable wrist cards, one per leg, with headings,
  distances, arrival times, tasks, walk-back and the latest safe departure ("bingo").
- **Route planner**: A* on a 2 m grid. Walking time uses Tobler's hiking function scaled
  to a suited pace; steep or blocky cells are closed.
- **EVA budget**: distance, climb, walking and science time, return time vs. sunset,
  radiation dose, and a GO / NO-GO verdict.
- **Walk-back safety**: fastest way home from every cell; the route is GO only if
  consumables minus reserve cover the walk-back from every point.
- **Science stops with real ground photos**: each stop is a place Curiosity stood, shown
  with a Navcam image from that sol.
- **Fly-over** and **Helmet view** modes along the planned route.
- **Storm drill**: simulated solar particle event, shows the fastest safe way back.

## Data

| Layer | Mission / instrument | Product |
| --- | --- | --- |
| Optical | MRO HiRISE | MSL Gale orthophoto mosaic, 0.25 m/px (USGS Astrogeology) |
| Topography | MRO HiRISE stereo | MSL Gale DEM mosaic, 1 m/px (USGS Astrogeology) |
| Thermal | Mars Odyssey THEMIS | Night IR controlled mosaic, 100 m/px (NASA Mars Trek WMTS) |
| Minerals | MRO CRISM | Targeted spectral summary products (MTRDR), 18 m/px, scenes FRT0000B6F1 and FRT000058A3 (PDS Geosciences Node) |
| Rover positions | MSL Curiosity | Localised waypoints (NASA/JPL-Caltech) |
| Ground photos | MSL Curiosity Navcam | Raw images (NASA/JPL-Caltech) |
| Weather | MSL Curiosity REMS | Daily weather report (NASA/JPL-Caltech/CAB) |
| Radiation | MSL Curiosity RAD | Mean surface GCR dose, 0.64 mSv/day (Hassler et al., Science 2014) |

Exact source URLs are written to `web/data/meta.json` and shown in the app under
"Data & assumptions".

## Rebuild the data

```
python -m venv .venv
.venv/Scripts/python -m pip install -r pipeline/requirements.txt   # Windows
.venv/Scripts/python pipeline/build_data.py
node pipeline/test_planner.mjs        # optional: planner sanity test
```

`pipeline/build_data.py` reads only the needed window of the large USGS mosaics over
HTTP, derives slope and step height, downloads two CRISM scenes (about 270 MB, cached in
`pipeline/raw/`), fetches THEMIS tiles, rover waypoints, photos and
weather, and writes everything to `web/data/`. Change `X0`, `Y_TOP` at the top of the
script to move the box anywhere inside the Gale mosaics.

## Limits and assumptions

- Slope, step-height, speed and endurance limits are our planning assumptions, not NASA
  suit requirements. All are adjustable in the app.
- THEMIS is shown as relative night-time brightness, not calibrated thermal inertia, and
  is 50× coarser than the terrain grid.
- The radiation figure is a published mean, not a live feed. The storm drill uses a
  hypothetical 5× dose rate and no real space-weather data.
- Stop names and crew tasks are mission design. They do not describe Curiosity results.
- CRISM signals in this box are weak (band depths of 1–2 %). The app shows the mean of
  two scenes, smoothed to about 50 m. The two scenes agree moderately for sulfates
  (r = 0.48) and monohydrated sulfate (r = 0.57); bound water, clay and pyroxene are not
  confirmed by the second scene and are marked with * in the legend. Treat the map as a
  hint for where to sample, not as a mineral identification.
- Sun position: declination from the season (Ls of the latest REMS report), hour angle
  scaled to the REMS sunrise and sunset times. Shadows come from the 2 m elevation model
  inside the box only; terrain outside it casts none.
- The cuff checklist's contingency rules are ours, not NASA flight rules.
- Not included yet: the USGS geologic map.

## Use of AI

The source code, the data pipeline and this README were written with the help of an AI coding
assistant (Claude, Anthropic) and reviewed by the team. All maps, images and measurements
shown in the app are NASA data products; no image, map or measurement is AI-generated.

## Third-party code

- [three.js](https://threejs.org) r160 and its OrbitControls (MIT licence), vendored in
  `web/vendor/`.
