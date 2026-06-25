// test-vast.mjs — Probe the Vast.ai API to learn its REAL shape before we
// implement the provider. Same discipline that caught RunPod's surprises:
// verify the live response, don't code against assumptions.
//
// It does NOT create anything — read-only offer search. Prints the raw fields of
// a few cheap offers so we can see exactly how price / location / GPU name /
// bandwidth are reported, then map them into our GpuCandidate model.
//
// Run:  node web/scripts/test-vast.mjs
// Reads VAST_API_KEY from the environment or web/.env.local.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let KEY = process.env.VAST_API_KEY
if (!KEY) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    const m = env.match(/^VAST_API_KEY=(.*)$/m)
    KEY = m && m[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* none */ }
}
if (!KEY) { console.error('No VAST_API_KEY (env or web/.env.local). Add it and re-run.'); process.exit(1) }

// Offer search. Vast: GET /api/v0/bundles?q=<json>. We ask for cheap, verified,
// rentable, on-demand machines — broad, so we can inspect whatever comes back.
const query = {
  verified: { eq: true },
  rentable: { eq: true },
  rented: { eq: false },
  num_gpus: { eq: 1 },
  dph_total: { lte: 1.0 },
  type: 'on-demand',
  order: [['dph_total', 'asc']],
  limit: 12,
}

const url = `https://console.vast.ai/api/v0/bundles?q=${encodeURIComponent(JSON.stringify(query))}`
console.log('GET', url, '\n')

const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } })
console.log('HTTP', res.status, res.statusText)
const text = await res.text()
let body
try { body = JSON.parse(text) } catch { console.error('non-JSON response:\n', text.slice(0, 800)); process.exit(1) }

const offers = body.offers || body.bundles || []
console.log(`\nGot ${offers.length} offers. Fields we care about for the broker:\n`)

// The fields we expect to need — print them so we can confirm names/formats and
// see what's missing (especially: is there lat/lon, or only a geolocation string?).
const WANT = ['id', 'gpu_name', 'num_gpus', 'gpu_ram', 'dph_total', 'geolocation',
  'datacenter', 'country', 'reliability2', 'cuda_max_good', 'driver_version',
  'inet_up', 'inet_down', 'verification', 'rentable']
for (const o of offers.slice(0, 8)) {
  const row = {}
  for (const k of WANT) if (k in o) row[k] = o[k]
  console.log(JSON.stringify(row))
}

// Dump the FULL key set of the first offer so we discover fields we didn't anticipate.
if (offers[0]) {
  console.log('\nAll keys present on an offer (so we miss nothing):')
  console.log(Object.keys(offers[0]).sort().join(', '))
}
console.log('\nDone — paste this output and we map it into lib/providers/vast.ts.')
