# GeoNet ShakeMap

A static, self-contained web visualisation of **real GeoNet seismic waveforms
propagating across Aotearoa New Zealand**. It plots real sensor locations on a
black-and-white map (mainland **and the Chatham Islands**) and animates the
ground motion recorded at each site, so you can watch the wavefront of an
earthquake spread outward in slow motion.

Rendering convention:

| Ground motion at a sensor | Circle |
| --- | --- |
| moving **up** (positive amplitude) | **solid** disc, radius ∝ shaking |
| moving **down** (negative amplitude) | **hollow** ring, radius ∝ shaking |
| epicentre | crosshair marker |

The checked-in demo is the **2016 Kaikōura M7.8** earthquake.

![Snapshot at +150 s](docs/snapshot.svg)

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

Build the static site and serve it:

```bash
npm run build        # → dist/  (type-checked, everything bundled, no CDNs)
npm run preview      # serve dist/ locally
```

The build is fully self-contained: the coastline is inlined into the JS bundle
and the dataset is a plain `dist/data/event.json`. Serve `dist/` with any static
file server.

## Controls

- **Play / pause** (or the spacebar).
- **Timeline** scrubber.
- **Speed** presets from real-time (`1×`) down to **`0.05×`** slow motion.
- **Loop** toggle (on by default).
- **Normalise**: `per station` (default — every site shows a clear pulse as its
  wave arrives, best for seeing propagation) or `uniform` (one global scale, so
  near-field intensity dominates — true relative amplitude).

## The data

Two datasets, identical JSON shape ([`src/data/types.ts`](src/data/types.ts) →
`ShakeDataset`):

### 1. The checked-in sample (real, ships with the repo)

`public/data/event.json` holds **real recorded waveforms** for 9 of the 11 NZ
backbone broadband stations (mirrored by [EarthScope](https://www.earthscope.org/),
including `KHZ` right by the epicentre and `CTZ` on the Chatham Islands as a
located site). It's small, works offline, and is what the app loads out of the
box. Rebuild it from the raw miniSEED with:

```bash
npm run build-sample     # data-raw/kaikoura_hhz.mseed → public/data/event.json
```

### 2. The full dense dataset (GeoNet AWS Open Data)

For the *dense* network (hundreds of strong-motion + broadband sensors), run the
pipeline against GeoNet's public [AWS Open Data bucket](https://registry.opendata.aws/geonet/):

```bash
npm run fetch-data       # → overwrites public/data/event.json
```

[`scripts/fetch-data.ts`](scripts/fetch-data.ts):

1. Reads the GeoNet station catalogue (`data-raw/delta_stations.csv`), keeps
   stations active on the event date and inside the NZ region, and **thins them
   to one representative per grid cell** (the data-layer twin of the map's
   on-screen decimation) so it doesn't download the entire archive.
2. For each station, GETs the day's miniSEED straight from the public S3 bucket
   (no credentials, plain HTTPS), decodes it with our own Steim reader, windows
   it to the event, and resamples onto the common grid.
3. Writes the same `event.json` the app already understands.

Configure the event, time window, channels (strong-motion `HNZ` is preferred
over broadband `HHZ`), region, and thinning density in the `CONFIG` block at the
top of the script.

> **Note — why there are two datasets.** GeoNet's AWS bucket, FDSN service, and
> data API are all hosted in AWS `ap-southeast-2` (Sydney). This repo was built
> in a sandbox that can't reach that region, so the pipeline can't run here — but
> it runs fine from a normal machine (e.g. anywhere in NZ). The EarthScope
> sample is the real-data stand-in that works everywhere.

### Regenerating the raw inputs

The `data-raw/` inputs are git-ignored (reproducible). To refetch:

```bash
mkdir -p data-raw
# GeoNet station catalogue (mainland + Chathams)
curl -sSL https://raw.githubusercontent.com/GeoNet/delta/main/network/stations.csv \
  -o data-raw/delta_stations.csv
# Natural Earth coastline (mainland + Chathams), then simplify + bundle it
curl -sSL https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson \
  -o data-raw/ne_50m_land.geojson
npm run build-coastline   # → src/geo/nz-coastline.json
# Real sample waveforms (Kaikōura, EarthScope mirror)
curl -sSL "https://service.earthscope.org/fdsnws/dataselect/1/query?net=NZ&sta=BFZ,BKZ,CTZ,HIZ,KHZ,ODZ,OUZ,QRZ,RPZ,URZ,WPVZ&cha=HHZ&start=2016-11-13T11:02:00&end=2016-11-13T11:10:00" \
  -o data-raw/kaikoura_hhz.mseed
npm run build-sample      # → public/data/event.json
```

## Testing

```bash
npm test                 # vitest, 72 tests
npm run coverage
```

Per the brief, tests **concentrate on the data-transformation algorithms** — the
parts that can actually be wrong — rather than the DOM/canvas glue:

| Module | What's tested |
| --- | --- |
| [`geo/projection`](src/geo/projection.ts) | lon-wrapping (Chatham east of the mainland), bounds, fit-to-canvas, north-up, aspect |
| [`geo/simplify`](src/geo/simplify.ts) | Douglas–Peucker perpendicular distance & polyline reduction |
| [`data/miniseed`](src/data/miniseed.ts) | miniSEED framing, BTIME, sample-rate, **Steim-1/2 decoding** (synthetic INT32 record + a real Kaikōura Steim-2 record with its built-in integrity check) |
| [`data/decimate`](src/data/decimate.ts) | grid decimation → representative-per-cell, priority & determinism |
| [`data/amplitude`](src/data/amplitude.ts) | trace interpolation, robust normalisation scale, amplitude → radius/fill |
| [`data/resample`](src/data/resample.ts) | anti-aliased box resample + DC-baseline removal |
| [`playback/clock`](src/playback/clock.ts) | speed scaling, looping/wrap, clamp-and-stop, seek |

Lint/format with Google's style ([gts](https://github.com/google/gts)):

```bash
npm run lint
npm run fix
```

## Project layout

```
src/
  geo/        projection (incl. Chatham), coastline simplify, bundled nz-coastline.json
  data/       types, miniSEED/Steim decoder, decimation, amplitude, resample
  playback/   playback clock (slow-mo + loop)
  render/     black-and-white canvas renderer
  main.ts     glue: load → project → decimate → animate → controls
scripts/
  build-coastline.ts   Natural Earth land → bundled NZ coastline
  build-sample.ts      raw miniSEED → checked-in sample event.json
  fetch-data.ts        GeoNet AWS Open Data → full dense event.json
  render-snapshot.ts   static SVG preview at a chosen time
```

## Tech

Vite + TypeScript, gts (Google TypeScript style), Vitest. **Zero runtime
dependencies** — the projection, miniSEED/Steim decoder, decimation and renderer
are all first-party and bundled; nothing is fetched from a CDN.

## Data attribution

Waveforms and station metadata: **GeoNet** (GNS Science / Toka Tū Ake EQC),
CC BY 3.0 NZ, via the GeoNet AWS Open Data Registry and the EarthScope FDSN
mirror. Coastline: **Natural Earth** (public domain).
