# GeoNet ShakeMap

A static, self-contained web visualisation of **real GeoNet seismic waveforms
propagating across Aotearoa New Zealand**. Real sensor sites are plotted on a
monochrome map (mainland **and the Chatham Islands**) and the ground motion
recorded at each one is animated, so you can watch an earthquake's wavefront
spread outward in slow motion.

Amplitudes are **response-corrected to ground acceleration (m/s²)**, so disc
size is comparable between stations rather than reflecting each sensor's gain.

| On the map | Mark |
| --- | --- |
| shaking at a sensor | **solid** disc, radius ∝ ground acceleration |
| epicentre | ring + crosshair |
| expanding P / S wavefront | dashed / solid ring |
| bedrock type (optional) | translucent colour fill |

(Signed polarity — ground moving up vs down — lives in the bottom timeline
seismogram, so the map stays readable across a dense network.)

Pick from several real historical NZ earthquakes in the header dropdown
(Kaikōura 2016, Christchurch 2011, Darfield 2010, Dusky Sound 2009). The strip
along the bottom is the **real seismogram of the station nearest the epicentre**
— a single trace centred on zero, positive up / negative down, with the playhead
and origin marked; click or drag to scrub.

![Snapshot at +150 s](docs/snapshot.svg)

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173

npm run build        # → dist/  (type-checked, everything bundled, no CDNs)
npm run preview      # serve dist/ locally
```

The build is fully self-contained: the coastline is inlined into the JS bundle
and the data is plain `dist/data/catalog.json` + `dist/data/events/<id>.json`.
Serve `dist/` with any static file server.

## Controls

- **Earthquake picker** (header) — switch events. **How it works** and
  **Credits** buttons open info dialogs; the top-right panel describes the
  selected quake.
- **Play / pause** (or spacebar).
- **Timeline** (bottom) — the nearest-station seismogram; **click or drag to
  scrub**, or focus it and use ←/→ (Shift for bigger steps), Home/End.
- **Speed** — real-time (`1×`) down to `0.05×` slow motion.
- **Loop** — on by default.
- **Amplitude** — `envelope` (default: disc radius follows a smoothed
  fast-attack/slow-decay envelope, so a dense network reads as calm swells
  instead of strobing) or `waveform` (the raw rectified value).
- **P/S waves** (on) — schematic wavefronts from the epicentre: a dashed outer P
  front (~6.0 km/s) and a solid inner S front (~3.5 km/s), stopping past the
  farthest detector. Representative crustal velocities, not a travel-time model.
- **Faults** (off) — major active faults (GEM/GNS database); hover for the fault
  name, style and slip rate.
- **Bedrock** (on) — a simplified geology overlay (hard basement / soft basins /
  volcanic zones) that explains why shaking spreads unevenly.

## The data

The app loads `public/data/catalog.json` (the event list) plus one
`public/data/events/<id>.json` per event — all sharing one JSON shape
([`ShakeDataset`](src/data/types.ts)). **Adding an earthquake** = drop in another
events file and a catalog entry; both builders below do that for you.

The shipped datasets are **real GeoNet recordings across the dense network**
(hundreds of strong-motion + broadband sensors), response-corrected to m/s².

### Full pipeline — GeoNet AWS Open Data

```bash
npm run fetch-data       # → public/data/events/*.json (all events) + catalog.json
```

For each event in [`scripts/events.ts`](scripts/events.ts),
[`fetch-data.ts`](scripts/fetch-data.ts):

1. Reads the GeoNet station catalogue (`data-raw/delta_stations.csv`), keeps
   stations active **on that event's date** and in region, and **thins them to
   one per grid cell** so it doesn't download the whole archive.
2. GETs each station's miniSEED for the day straight from the public S3 bucket
   (no credentials) and decodes it with our own Steim reader.
3. Fetches each channel's overall sensitivity from the **FDSN station service**
   and converts counts → **ground acceleration (m/s²)** — dividing by the
   sensitivity and differentiating velocity (broadband) channels. Stations with
   no resolvable response are dropped rather than left in incomparable counts.
4. Crops to a **hybrid window** — the later of the near-epicentre significant
   duration and the S-wave reaching a coverage radius (~400 km) — and writes the
   `events/<id>.json` + `catalog.json` entry.

Downloaded day files and metadata are **cached** under `data-raw/aws-cache/`
(git-ignored), so re-running costs no bandwidth. Tune channels (strong-motion
`HNZ`/`BNZ` preferred over broadband `HHZ`), region, window and thinning in the
`CONFIG` block at the top of the script.

> GeoNet's AWS bucket and FDSN services live in AWS `ap-southeast-2` (Sydney), so
> the pipeline can't run from a sandbox that can't reach that region — but it
> runs fine from a normal machine.

### Lightweight offline stand-in

```bash
npm run build-sample     # data-raw/<id>_hhz.mseed → public/data/events/*.json + catalog.json
```

Builds the same JSON shape from a small set of EarthScope broadband miniSEED
files (uncorrected velocity counts), for when the GeoNet endpoints aren't
reachable. Covers the same events as the full pipeline.

### Regenerating the raw inputs

`data-raw/` is git-ignored. To refetch:

```bash
mkdir -p data-raw
# GeoNet station catalogue (mainland + Chathams)
curl -sSL https://raw.githubusercontent.com/GeoNet/delta/main/network/stations.csv \
  -o data-raw/delta_stations.csv
# Natural Earth coastline, then simplify + bundle it
curl -sSL https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson \
  -o data-raw/ne_50m_land.geojson
npm run build-coastline   # → src/geo/nz-coastline.json
# Real sample waveforms per event (EarthScope mirror), e.g. Kaikōura:
S="BFZ,BKZ,CTZ,HIZ,KHZ,ODZ,OUZ,QRZ,RPZ,URZ,WPVZ"
curl -sSL "https://service.earthscope.org/fdsnws/dataselect/1/query?net=NZ&sta=$S&cha=HHZ&start=2016-11-13T11:02:00&end=2016-11-13T11:10:00" \
  -o data-raw/kaikoura_hhz.mseed
npm run build-sample      # → public/data/events/*.json + catalog.json
```

## Testing

```bash
npm test                 # vitest, 125 tests
npm run coverage
```

Tests **concentrate on the data-transformation algorithms** — the parts that can
actually be wrong — rather than the DOM/canvas glue:

| Module | What's tested |
| --- | --- |
| [`geo/projection`](src/geo/projection.ts) | lon-wrapping (Chatham east of the mainland), bounds, fit-to-canvas, aspect |
| [`geo/simplify`](src/geo/simplify.ts) | Douglas–Peucker distance & polyline reduction |
| [`geo/distance`](src/geo/distance.ts) | haversine, nearest-station, wavefront rings (antimeridian-safe) |
| [`data/miniseed`](src/data/miniseed.ts) | miniSEED framing, BTIME, sample-rate, **Steim-1/2 decoding** |
| [`data/response`](src/data/response.ts) | FDSN sensitivity parsing, counts → m/s² correction |
| [`data/decimate`](src/data/decimate.ts) | grid decimation, priority & determinism |
| [`data/amplitude`](src/data/amplitude.ts) | interpolation, robust scale, amplitude → radius/fill |
| [`data/resample`](src/data/resample.ts) | anti-aliased box resample + DC-baseline removal |
| [`data/window`](src/data/window.ts) | significant-duration (Arias 5–95%) window detection |
| [`data/envelope`](src/data/envelope.ts) | fast-attack/slow-decay shaking-envelope follower |
| [`data/waveform`](src/data/waveform.ts) | signed peak-preserving decimation for the timeline |
| [`playback/clock`](src/playback/clock.ts) | speed scaling, looping/wrap, clamp-and-stop, seek |

Lint/format with [gts](https://github.com/google/gts): `npm run lint`, `npm run fix`.

## Project layout

```
src/
  geo/        projection (incl. Chatham), distance/nearest, simplify, geology + coastline data
  data/       types, miniSEED/Steim decoder, response correction, decimate, amplitude, resample, waveform
  playback/   playback clock (slow-mo + loop)
  render/     monochrome map renderer + bottom trace-strip renderer
  main.ts     glue: catalogue → load event → project → decimate → animate → controls
scripts/
  build-coastline.ts   Natural Earth land → bundled NZ coastline
  build-faults.ts      GEM active faults → bundled fault traces
  build-sample.ts      raw miniSEED → offline sample datasets
  fetch-data.ts        GeoNet AWS + FDSN → full dense datasets (response-corrected)
  render-snapshot.ts   static SVG preview at a chosen time
```

## Tech

Vite + TypeScript, gts, Vitest. **Zero runtime dependencies** — the projection,
miniSEED/Steim decoder, response correction, decimation and renderer are all
first-party and bundled; nothing is fetched from a CDN.

## Data attribution

- **Waveforms & station metadata:** GeoNet (GNS Science / Toka Tū Ake), CC BY
  3.0 NZ, via the GeoNet AWS Open Data Registry, FDSN station service, and the
  EarthScope FDSN mirror.
- **Active faults:** GEM Global Active Faults Database (GNS-derived), CC BY-SA 4.0.
- **Coastline:** Natural Earth (public domain).

An educational visualisation, not an official hazard product; not affiliated
with or endorsed by GeoNet or GNS Science.
