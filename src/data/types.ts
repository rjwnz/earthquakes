/**
 * Shared domain types for the GeoNet shake-map visualisation.
 *
 * The bundled dataset produced by the preprocessing pipeline
 * (`scripts/fetch-data.ts` for the full AWS dataset, `scripts/build-sample.ts`
 * for the checked-in sample) conforms to {@link ShakeDataset}.
 */

/** A seismic sensor's fixed metadata. */
export interface SensorLocation {
  /** GeoNet station code, e.g. "KHZ". */
  code: string;
  /** Human-readable site name, e.g. "Kahutara". */
  name: string;
  /** Latitude in decimal degrees (WGS84), negative south. */
  lat: number;
  /**
   * Longitude in decimal degrees (WGS84). GeoNet longitudes east of the
   * antimeridian (the Chatham Islands) are stored as negative values here,
   * exactly as published; the projection is responsible for wrapping them.
   */
  lon: number;
}

/**
 * One sensor's ground-motion trace, resampled onto the dataset's common time
 * grid. `samples[i]` is the amplitude at `dataset.startMs + i * (1000 /
 * dataset.sampleRateHz)`. Sensors with no recovered waveform have
 * `hasData === false` and an empty `samples` array (they still plot on the
 * map, they just never move).
 */
export interface SensorTrace extends SensorLocation {
  /** Amplitudes on the common grid (see {@link ShakeDataset.sampleRateHz}). */
  samples: number[];
  /** Whether a waveform was recovered for this sensor. */
  hasData: boolean;
  /**
   * This sensor's own robust amplitude scale (see {@link robustMaxAbs}). Used
   * for per-station normalisation so a distant, gently-shaken site still shows
   * a clear pulse as the wavefront passes; 0 when there is no data.
   */
  scale: number;
}

/** The seismic event whose shaking is being visualised. */
export interface EventMeta {
  /** GeoNet/USGS event id or a slug. */
  id: string;
  /** Display name, e.g. "Kaikoura M7.8, 14 Nov 2016". */
  name: string;
  /** Origin (rupture) time as epoch milliseconds (UTC). */
  originTimeMs: number;
  /** Epicentre latitude. */
  lat: number;
  /** Epicentre longitude. */
  lon: number;
  /** Hypocentre depth in km. */
  depthKm: number;
  /** Moment magnitude. */
  magnitude: number;
}

/**
 * The complete bundled dataset the front end animates. All traces share the
 * same time window (`startMs`..`endMs`) and `sampleRateHz`, so playback is a
 * single clock indexing every trace.
 */
export interface ShakeDataset {
  event: EventMeta;
  /** FDSN network code (always "NZ" for GeoNet). */
  network: string;
  /** Common window start, epoch milliseconds (UTC). */
  startMs: number;
  /** Common window end, epoch milliseconds (UTC). */
  endMs: number;
  /** Common sample rate of every trace, in Hz. */
  sampleRateHz: number;
  /** Physical units of the amplitude samples, e.g. "nm/s". */
  units: string;
  /**
   * A robust amplitude scale (see {@link robustMaxAbs}) across all traces,
   * used to normalise radii so one saturating near-field station does not
   * flatten the rest of the network.
   */
  amplitudeScale: number;
  sensors: SensorTrace[];
}

/** One entry in the earthquake catalogue (the event picker's data source). */
export interface CatalogEntry {
  /** Stable slug, also the dataset filename stem, e.g. "kaikoura-2016". */
  id: string;
  /** Display label, e.g. "Kaikōura M7.8 — 14 Nov 2016". */
  name: string;
  /** Human date (local), e.g. "14 Nov 2016". */
  date: string;
  magnitude: number;
  /** Short region label, e.g. "Kaikōura, Marlborough". */
  region: string;
  /** Path to the {@link ShakeDataset} JSON, relative to the data directory. */
  file: string;
}

/** The list of available earthquakes, loaded at startup to build the picker. */
export interface Catalog {
  events: CatalogEntry[];
}

/** A ring of [lon, lat] pairs (a coastline polygon outline). */
export type Ring = Array<[number, number]>;

/** Bundled, pre-simplified NZ coastline: a list of rings in [lon, lat]. */
export interface Coastline {
  rings: Ring[];
}
