/**
 * Diagnostic: discover the real miniSEED key layout in the geonet-open-data
 * bucket, so scripts/fetch-data.ts can build the right paths.
 *
 *   npx tsx scripts/probe-bucket.ts
 *
 * Run it on a machine that can reach ap-southeast-2 and paste the output back.
 * It walks down from waveforms/miniseed/2016/ toward the Kaikoura day (2016.318)
 * and the KHZ station, printing the directory names at each level and the first
 * few actual object keys it finds — that tells us the exact template to use.
 */
const BASE = 'https://geonet-open-data.s3-ap-southeast-2.amazonaws.com';

interface Listing {
  status: number;
  error?: string;
  dirs: string[];
  keys: string[];
}

async function list(prefix: string, delimiter = '/'): Promise<Listing> {
  const url = new URL(BASE + '/');
  url.searchParams.set('list-type', '2');
  if (prefix) url.searchParams.set('prefix', prefix);
  if (delimiter) url.searchParams.set('delimiter', delimiter);
  url.searchParams.set('max-keys', '40');
  const res = await fetch(url);
  const xml = await res.text();
  return {
    status: res.status,
    error: /<Error>[\s\S]*?<\/Error>/.exec(xml)?.[0],
    dirs: [...xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)]
      .map(m => m[1])
      .filter(p => p !== prefix),
    keys: [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]),
  };
}

/** Pick the sub-prefix most likely to lead toward KHZ's Kaikoura-day data. */
function pickNext(dirs: string[]): string | undefined {
  return (
    dirs.find(p => p.includes('2016.318')) ??
    dirs.find(p => /KHZ/i.test(p)) ??
    dirs.find(p => /(^|\/)NZ($|[./])/.test(p)) ??
    dirs.find(p => /\/2016\.\d+\/$/.test(p)) ??
    dirs[0]
  );
}

async function walk(prefix: string, depth: number): Promise<void> {
  const r = await list(prefix);
  console.log(`\n[HTTP ${r.status}] prefix="${prefix}"`);
  if (r.error) console.log('  ERROR:', r.error);
  if (r.dirs.length) console.log('  dirs :', r.dirs.slice(0, 25));
  if (r.keys.length) console.log('  files:', r.keys.slice(0, 6));
  if (depth > 0 && r.keys.length === 0 && r.dirs.length) {
    const next = pickNext(r.dirs);
    if (next) await walk(next, depth - 1);
  }
}

async function main(): Promise<void> {
  console.log('=== bucket root ===');
  await walk('', 1);
  console.log('\n=== drilling toward KHZ / 2016.318 ===');
  await walk('waveforms/miniseed/2016/', 6);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
