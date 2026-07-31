/**
 * The catalogue of earthquakes both build scripts produce.
 *
 * `scripts/build-sample.ts` builds the small checked-in sample for each event
 * from `data-raw/<sampleMseed>`; `scripts/fetch-data.ts` builds the full dense
 * version of each from the GeoNet AWS Open Data bucket. Both emit
 * `public/data/events/<id>.json` and a matching `catalog.json` entry, so this is
 * the single place to add or edit an event.
 */
import type {EventMeta} from '../src/data/types';

export interface EventConfig {
  /** Catalogue id and dataset filename stem, e.g. "kaikoura-2016". */
  id: string;
  /** Human date (local), e.g. "14 Nov 2016". */
  date: string;
  /** Short region label, e.g. "Kaikōura, Marlborough". */
  region: string;
  /** Raw miniSEED filename in data-raw/ used by the sample builder. */
  sampleMseed: string;
  event: EventMeta;
}

export const EVENTS: EventConfig[] = [
  {
    id: 'kaikoura-2016',
    date: '14 Nov 2016',
    region: 'Kaikōura, Marlborough',
    sampleMseed: 'kaikoura_hhz.mseed',
    event: {
      id: '2016p858000',
      name: 'Kaikōura M7.8 — 14 Nov 2016',
      originTimeMs: Date.parse('2016-11-13T11:02:56Z'),
      lat: -42.737,
      lon: 173.054,
      depthKm: 15,
      magnitude: 7.8,
    },
  },
  {
    id: 'christchurch-2011',
    date: '22 Feb 2011',
    region: 'Christchurch, Canterbury',
    sampleMseed: 'christchurch-2011_hhz.mseed',
    event: {
      id: '2011p079088',
      name: 'Christchurch M6.2 — 22 Feb 2011',
      originTimeMs: Date.parse('2011-02-21T23:51:42Z'),
      lat: -43.58,
      lon: 172.68,
      depthKm: 5,
      magnitude: 6.2,
    },
  },
  {
    id: 'darfield-2010',
    date: '4 Sep 2010',
    region: 'Darfield, Canterbury',
    sampleMseed: 'darfield-2010_hhz.mseed',
    event: {
      id: '3366146',
      name: 'Darfield M7.1 — 4 Sep 2010',
      originTimeMs: Date.parse('2010-09-03T16:35:46Z'),
      lat: -43.53,
      lon: 172.12,
      depthKm: 11,
      magnitude: 7.1,
    },
  },
  {
    id: 'dusky-sound-2009',
    date: '15 Jul 2009',
    region: 'Dusky Sound, Fiordland',
    sampleMseed: 'dusky-sound-2009_hhz.mseed',
    event: {
      id: '3124785',
      name: 'Dusky Sound M7.8 — 15 Jul 2009',
      originTimeMs: Date.parse('2009-07-15T09:22:29Z'),
      lat: -45.76,
      lon: 166.56,
      depthKm: 12,
      magnitude: 7.8,
    },
  },
];
