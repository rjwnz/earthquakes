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

/** A freely-licensed image shown in the event info panel, with attribution. */
export interface EventImage {
  /** Direct image URL (a Wikimedia Commons thumbnail). */
  src: string;
  /** Alt text describing the image. */
  alt: string;
  /** Author/source, shown as the photo credit. */
  credit: string;
  /** Licence short name, e.g. "CC BY-SA 4.0" or "Public domain". */
  license: string;
  /** Link to the image's description/licence page. */
  href: string;
}

/** A "learn more" link for an event. */
export interface EventLink {
  label: string;
  href: string;
}

/**
 * Editorial content about one catalogue event (description, image, links),
 * authored in `public/data/event-info.json` and keyed by {@link CatalogEntry.id}.
 * Kept separate from the large machine-generated {@link ShakeDataset} files.
 */
export interface EventInfo {
  /** Plain-language description of the earthquake and its effects. */
  summary: string;
  /** Short bullet facts (deaths, depth, notable effects). */
  quickFacts: string[];
  /** A representative freely-licensed image (optional). */
  image?: EventImage;
  /** Further-reading links. */
  links: EventLink[];
}

/** The keyed collection loaded from `event-info.json`. */
export type EventInfoMap = Record<string, EventInfo>;

/** A ring of [lon, lat] pairs (a coastline polygon outline). */
export type Ring = Array<[number, number]>;

/** Bundled, pre-simplified NZ coastline: a list of rings in [lon, lat]. */
export interface Coastline {
  rings: Ring[];
}

/** One major active fault: an open polyline in [lon, lat] plus its attributes. */
export interface Fault {
  /** Fault (segment) name as published, e.g. "Hope Conway". */
  name: string;
  /** Style of movement, e.g. "Dextral", "Subduction_Thrust". */
  slipType: string;
  /** Mean net slip rate in mm/yr. */
  slipRate: number;
  /** The trace as a [lon, lat] polyline. */
  coords: Ring;
}

/**
 * Bundled major active-fault traces. Built from the GEM Global Active Faults
 * Database (GNS-derived, CC BY-SA 4.0) by `scripts/build-faults.ts`, filtered
 * to the higher slip-rate faults so the optional overlay stays legible.
 */
export interface FaultNetwork {
  faults: Fault[];
}
