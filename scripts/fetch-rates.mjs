/**
 * Refresh the lender rate database.
 *
 * Reads the public MCLR disclosure that banks file with BSE India and nudges
 * the stored rate ranges to match. MCLR is the benchmark most floating-rate
 * loans are priced off, so a move there is a real signal — but it is a
 * *benchmark*, not a retail offer, so this only shifts the ranges by the
 * observed delta rather than overwriting them.
 *
 * Deliberately conservative:
 *   - It never scrapes individual bank websites. Those change constantly and
 *     their terms usually prohibit automated access.
 *   - If the source is unreachable or its shape has changed, it exits 0 having
 *     changed nothing. A stale rate is a mild annoyance; a corrupted rate file
 *     would be worse, and the figures are editable in the app anyway.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LENDERS_PATH = join(HERE, '..', 'src', 'data', 'lenders.json');

const SOURCE = 'https://www.bseindia.com/markets/MarketInfo/DispNoticesCirculars.aspx';
const TIMEOUT_MS = 20_000;

/** Bank names as they appear in disclosures, mapped to our lender names. */
const NAME_ALIASES = {
  'STATE BANK OF INDIA': 'State Bank of India',
  SBI: 'State Bank of India',
  'HDFC BANK': 'HDFC Bank',
  'ICICI BANK': 'ICICI Bank',
  'AXIS BANK': 'Axis Bank',
  'KOTAK MAHINDRA BANK': 'Kotak Mahindra Bank',
  'BANK OF BARODA': 'Bank of Baroda',
  'PUNJAB NATIONAL BANK': 'Punjab National Bank',
  'UNION BANK OF INDIA': 'Union Bank of India',
  'CANARA BANK': 'Canara Bank',
  'BANK OF MAHARASHTRA': 'Bank of Maharashtra',
  'IDFC FIRST BANK': 'IDFC FIRST Bank',
};

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Identify ourselves honestly rather than impersonating a browser.
        'User-Agent': 'PaisaTrack-RateRefresh/1.0 (+https://github.com/topics/paisatrack)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull "<BANK NAME> ... <rate>%" pairs out of the disclosure HTML.
 * Returns a Map of canonical lender name -> MCLR percentage.
 */
function parseMclr(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const found = new Map();

  for (const [alias, canonical] of Object.entries(NAME_ALIASES)) {
    const pattern = new RegExp(`${alias}[^%]{0,160}?(\\d{1,2}\\.\\d{1,2})\\s*%`, 'i');
    const match = text.match(pattern);
    if (!match) continue;

    const rate = Number.parseFloat(match[1]);
    // MCLR has sat between roughly 7% and 12% for years. Anything outside that
    // is a parse artefact, not a rate.
    if (Number.isFinite(rate) && rate >= 6 && rate <= 13) found.set(canonical, rate);
  }

  return found;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const db = JSON.parse(readFileSync(LENDERS_PATH, 'utf8'));

  let html;
  try {
    html = await fetchWithTimeout(SOURCE);
  } catch (e) {
    console.log(`Could not reach the MCLR source (${e.message}). Keeping existing rates.`);
    return;
  }

  const observed = parseMclr(html);
  if (observed.size === 0) {
    console.log('No MCLR figures recognised — the page shape has probably changed. Keeping existing rates.');
    return;
  }

  console.log(`Parsed MCLR for ${observed.size} lender(s):`);
  for (const [name, rate] of observed) console.log(`  ${name}: ${rate}%`);

  // Home loans track MCLR most directly, so that category anchors the delta.
  const anchors = db.home.filter((l) => observed.has(l.name));
  if (anchors.length === 0) {
    console.log('None of the parsed lenders are in the home-loan list. Nothing to do.');
    return;
  }

  const deltas = anchors.map((l) => observed.get(l.name) - l.rateMin);
  const medianDelta = deltas.sort((a, b) => a - b)[Math.floor(deltas.length / 2)];

  // A move of more than 1.5 percentage points in a month is not a rate change,
  // it is a bad parse.
  if (!Number.isFinite(medianDelta) || Math.abs(medianDelta) > 1.5) {
    console.log(`Implausible median delta (${medianDelta}). Keeping existing rates.`);
    return;
  }

  if (Math.abs(medianDelta) < 0.01) {
    console.log('Rates are unchanged. Updating the timestamp only.');
  } else {
    console.log(`Shifting all rate ranges by ${medianDelta > 0 ? '+' : ''}${medianDelta.toFixed(2)}pp.`);
  }

  const round = (n) => Number(n.toFixed(2));
  for (const key of ['home', 'personal', 'car', 'education', 'gold', 'lap']) {
    db[key] = db[key].map((l) => ({
      ...l,
      rateMin: round(Math.max(1, l.rateMin + medianDelta)),
      rateMax: round(Math.max(1.5, l.rateMax + medianDelta)),
      ...(observed.has(l.name) ? { source: 'BSE MCLR disclosure' } : {}),
    }));
  }

  db.lastUpdated = todayISO();
  writeFileSync(LENDERS_PATH, `${JSON.stringify(db, null, 2)}\n`);
  console.log(`Wrote ${LENDERS_PATH} (lastUpdated ${db.lastUpdated}).`);
}

main().catch((e) => {
  // Never fail the workflow over a rate refresh — the app has usable defaults.
  console.log(`Rate refresh failed: ${e.message}. Keeping existing rates.`);
});
