/**
 * A deliberately-simplified schematic of Aotearoa New Zealand's major bedrock
 * domains, used as a map overlay that explains why seismic shaking spreads so
 * unevenly across the country.
 *
 * This is NOT a geological survey map. The provinces are coarse, hand-drawn
 * outlines (a handful of vertices each, in [lon, lat]) grouped into three
 * teaching categories that map onto how the ground responds to a passing wave:
 *
 *  - `basement`  hard greywacke / schist / granite. Waves travel fast and far,
 *                and shaking is comparatively brief.
 *  - `basin`     soft sedimentary basins and lowlands. Waves slow down, and the
 *                soft layers trap and amplify the shaking so it is stronger and
 *                lasts longer — this is where the worst damage tends to happen.
 *  - `volcanic`  hot, fractured volcanic crust (the Taupō Volcanic Zone and the
 *                Taranaki / Egmont volcano). It absorbs (attenuates) wave energy.
 *
 * The outlines are intentionally generous; the renderer clips them to the
 * coastline so overspill into the sea never shows. Because they are a schematic,
 * small gaps between provinces are fine — they simply read as "mixed" ground.
 */

export type GeologyCategory = 'basement' | 'basin' | 'volcanic';

/** Presentation + teaching metadata for one bedrock category. */
export interface GeologyCategoryInfo {
  /** Stable key, matches {@link GeologyRegion.category}. */
  key: GeologyCategory;
  /** Short legend label. */
  label: string;
  /** Fill colour (opaque form; the renderer applies its own alpha). */
  color: string;
  /** One-line, kid-friendly explanation of how waves behave here. */
  blurb: string;
}

export const GEOLOGY_CATEGORIES: readonly GeologyCategoryInfo[] = [
  {
    key: 'basement',
    label: 'Hard basement rock',
    color: '#5b8dd9',
    blurb:
      'Solid greywacke, schist and granite — waves race through, shaking is brief.',
  },
  {
    key: 'basin',
    label: 'Soft sedimentary basins',
    color: '#e0a33e',
    blurb:
      'Soft ground traps and amplifies the waves — shaking is stronger and lasts longer.',
  },
  {
    key: 'volcanic',
    label: 'Volcanic zone',
    color: '#d1495b',
    blurb: 'Hot, cracked volcanic crust soaks up (dampens) wave energy.',
  },
];

/** Look up a category's presentation info by key. */
export function geologyCategory(key: GeologyCategory): GeologyCategoryInfo {
  const found = GEOLOGY_CATEGORIES.find(c => c.key === key);
  if (!found) throw new Error(`Unknown geology category: ${key}`);
  return found;
}

/** One province: a single outline ring in [lon, lat], plus a map label. */
export interface GeologyRegion {
  category: GeologyCategory;
  /** Short name drawn on the map (empty string = no label). */
  label: string;
  /** Outline as [lon, lat] pairs (GeoNet-style; longitudes may be negative). */
  ring: Array<[number, number]>;
}

/**
 * The schematic provinces. Coordinates are approximate and chosen so each blob
 * sits over the right part of the country once projected and clipped to land.
 */
export const GEOLOGY_REGIONS: readonly GeologyRegion[] = [
  // ---------------- North Island ----------------
  {
    category: 'basin',
    label: 'Northland',
    ring: [
      [172.7, -34.5],
      [173.5, -34.7],
      [174.6, -35.6],
      [175.1, -36.5],
      [175.2, -37.05],
      [174.7, -37.2],
      [174.2, -36.7],
      [173.4, -35.5],
      [172.9, -34.9],
    ],
  },
  {
    category: 'basin',
    label: 'Waikato',
    ring: [
      [174.5, -37.15],
      [175.5, -37.3],
      [175.85, -38.0],
      [175.3, -38.55],
      [174.5, -38.35],
      [174.25, -37.7],
    ],
  },
  {
    category: 'volcanic',
    label: 'Taupō Volcanic Zone',
    ring: [
      [175.35, -39.45],
      [176.15, -38.75],
      [177.0, -37.9],
      [177.45, -37.35],
      [177.0, -37.2],
      [176.35, -37.9],
      [175.55, -38.85],
      [174.95, -39.3],
    ],
  },
  {
    category: 'volcanic',
    label: 'Taranaki',
    ring: [
      [174.06, -38.95],
      [174.47, -39.3],
      [174.06, -39.66],
      [173.66, -39.3],
    ],
  },
  {
    category: 'basement',
    label: 'Axial ranges',
    ring: [
      [174.85, -41.3],
      [175.5, -40.6],
      [176.15, -39.8],
      [176.9, -38.9],
      [177.6, -38.0],
      [178.2, -37.55],
      [178.4, -37.8],
      [177.6, -38.55],
      [176.8, -39.45],
      [176.1, -40.15],
      [175.35, -40.95],
    ],
  },
  {
    category: 'basin',
    label: "Hawke's Bay & East Coast",
    ring: [
      [175.5, -41.4],
      [176.3, -40.35],
      [177.0, -39.5],
      [177.7, -38.7],
      [178.45, -38.0],
      [178.75, -38.4],
      [178.05, -39.3],
      [177.45, -40.0],
      [176.55, -41.0],
      [175.8, -41.5],
    ],
  },
  {
    category: 'basin',
    label: 'Whanganui–Manawatū',
    ring: [
      [174.55, -39.55],
      [175.4, -39.75],
      [175.75, -40.35],
      [175.3, -41.0],
      [174.8, -40.8],
      [174.35, -40.0],
    ],
  },
  // ---------------- South Island ----------------
  {
    category: 'basement',
    label: 'Marlborough & Kaikōura ranges',
    ring: [
      [172.5, -41.45],
      [173.6, -41.35],
      [174.35, -41.95],
      [173.95, -42.65],
      [173.3, -42.55],
      [172.45, -42.0],
    ],
  },
  {
    category: 'basement',
    label: 'Southern Alps',
    ring: [
      [172.25, -42.3],
      [171.4, -42.9],
      [170.5, -43.4],
      [169.6, -43.9],
      [168.65, -44.3],
      [169.2, -44.6],
      [170.2, -43.9],
      [171.1, -43.3],
      [172.0, -42.8],
      [172.75, -42.4],
    ],
  },
  {
    category: 'basin',
    label: 'Canterbury Plains',
    ring: [
      [171.55, -42.9],
      [172.85, -43.2],
      [173.25, -43.7],
      [172.5, -44.4],
      [171.4, -44.4],
      [170.95, -43.6],
    ],
  },
  {
    category: 'basement',
    label: 'Otago schist',
    ring: [
      [168.5, -44.6],
      [170.0, -44.8],
      [170.85, -45.5],
      [170.4, -46.25],
      [169.2, -46.2],
      [168.35, -45.4],
    ],
  },
  {
    category: 'basement',
    label: 'Fiordland',
    ring: [
      [166.45, -44.6],
      [167.6, -44.7],
      [168.2, -45.4],
      [167.9, -46.1],
      [167.0, -46.0],
      [166.35, -45.3],
    ],
  },
  {
    category: 'basin',
    label: 'Southland',
    ring: [
      [167.55, -45.85],
      [168.8, -45.9],
      [169.45, -46.35],
      [169.0, -46.75],
      [168.0, -46.75],
      [167.35, -46.3],
    ],
  },
];
