// test-dc-pin.mjs — Does RunPod honor a SINGLE-datacenter pin?
//
// This is a faithful prototype of the proposed broker redesign:
//   1. figure out the user's location (geolocate this machine's public IP)
//   2. rank the create-valid datacenters by distance — nearest first
//   3. walk nearest→farthest; in each DC try cheap community GPUs until one
//      CREATES, then read where it ACTUALLY landed (RunPod's reported DC + the
//      IP's real geolocation) and whether the pin was honored. Destroy it.
//
// Nothing here is hardcoded to a city — the target DC is derived from where you
// are, exactly like production (which uses Vercel geo headers instead of IP geo).
//
// Run:  node web/scripts/test-dc-pin.mjs
//       node web/scripts/test-dc-pin.mjs --latlon=27.99,-81.76   # force a location
// Reads RUNPOD_API_KEY from the environment, or from web/.env.local if present.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// --- key: env first, else parse web/.env.local -----------------------------
let KEY = process.env.RUNPOD_API_KEY
if (!KEY) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    const m = env.match(/^RUNPOD_API_KEY=(.*)$/m)
    KEY = m && m[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* no file */ }
}
if (!KEY) { console.error('No RUNPOD_API_KEY (env or web/.env.local).'); process.exit(1) }

// --- the 28 create-valid datacenters with coords (mirror of lib/datacenters.ts) ---
const DCS = [
  ['US-GA-1', 33.75, -84.39], ['US-GA-2', 33.75, -84.39], ['US-NC-1', 35.23, -80.84],
  ['US-DE-1', 39.16, -75.52], ['US-MD-1', 39.05, -76.64], ['US-IL-1', 41.88, -87.63],
  ['US-KS-2', 39.05, -95.70], ['US-KS-3', 39.05, -95.70], ['US-TX-1', 32.78, -96.80],
  ['US-TX-3', 32.78, -96.80], ['US-TX-4', 32.78, -96.80], ['US-CA-2', 37.40, -122.10],
  ['US-WA-1', 47.61, -122.33], ['CA-MTL-1', 45.50, -73.57], ['CA-MTL-2', 45.50, -73.57],
  ['CA-MTL-3', 45.50, -73.57], ['EU-CZ-1', 50.08, 14.43], ['EU-FR-1', 48.85, 2.35],
  ['EU-NL-1', 52.37, 4.90], ['EU-RO-1', 44.43, 26.10], ['EU-SE-1', 59.33, 18.07],
  ['EUR-IS-1', 64.13, -21.93], ['EUR-IS-2', 64.13, -21.93], ['EUR-IS-3', 64.13, -21.93],
  ['EUR-NO-1', 59.91, 10.75], ['AP-IN-1', 19.08, 72.88], ['AP-JP-1', 35.68, 139.69],
  ['OC-AU-1', -33.87, 151.21],
]
const haversine = (aLat, aLon, bLat, bLon) => {
  const R = 6371, p = Math.PI / 180
  const dLat = (bLat - aLat) * p, dLon = (bLon - aLon) * p
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(aLat * p) * Math.cos(bLat * p)
  return 2 * R * Math.asin(Math.sqrt(h))
}

const REST = 'https://rest.runpod.io/v1'
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function rest(method, p, body) {
  const res = await fetch(`${REST}${p}`, {
    method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}
async function gql(query) {
  const res = await fetch(`https://api.runpod.io/graphql?api_key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  })
  return (await res.json()).data
}
async function geoOf(ip = '') {
  const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon`)
  return r.json()
}

// --- 1. where is the user? (IP geo, or --latlon override) -------------------
let lat, lon, label
const arg = process.argv.find(a => a.startsWith('--latlon='))
if (arg) {
  [lat, lon] = arg.split('=')[1].split(',').map(Number); label = 'forced'
} else {
  const me = await geoOf()
  lat = me.lat; lon = me.lon; label = `${me.city}, ${me.regionName}, ${me.country}`
}
console.log(`Your location: ${label}  (${lat}, ${lon})`)

// --- 2. rank datacenters by distance, nearest first -------------------------
const ranked = DCS.map(([id, la, lo]) => ({ id, lat: la, lon: lo, km: Math.round(haversine(lat, lon, la, lo)) }))
  .sort((a, b) => a.km - b.km)
console.log(`Nearest datacenters: ${ranked.slice(0, 6).map(d => `${d.id}(${d.km}km)`).join('  ')}\n`)

// --- 3. walk nearest→farthest; pin a SINGLE DC; first create wins -----------
// Cloud tier is selectable: --cloud=COMMUNITY (default) or --cloud=SECURE.
// Community is proven to ignore the pin (lands globally); SECURE uses RunPod's
// own datacenters and should honor it — this flag lets us verify that + confirm
// the account can even launch secure on-demand.
const CLOUD = (process.argv.find(a => a.startsWith('--cloud=')) || '--cloud=COMMUNITY').split('=')[1].toUpperCase()
const GPUS = ['NVIDIA L4', 'NVIDIA RTX A4000', 'NVIDIA A40', 'NVIDIA RTX A5000', 'NVIDIA GeForce RTX 3090']
const NEAREST_TO_TRY = 5   // don't churn the whole globe — just confirm the nearby behavior

async function attempt(dc, gpu) {
  let podId
  try {
    const pod = await rest('POST', '/pods', {
      name: 'slimcast-dctest', imageName: 'runpod/base:0.6.2-cuda12.4.1',
      gpuTypeIds: [gpu], cloudType: CLOUD, dataCenterIds: [dc.id],
      containerDiskInGb: 10, ports: ['22/tcp'],
    })
    podId = pod.id
  } catch (e) {
    console.log(`   ${dc.id} / ${gpu}  → no capacity (${String(e.message).split(':').slice(-1)[0].trim().slice(0, 40)})`)
    return false
  }
  console.log(`   ${dc.id} / ${gpu}  → CREATED pod ${podId}, polling placement...`)
  try {
    let reportedDc = null, ip = null
    for (let i = 0; i < 18; i++) {
      await sleep(5000)
      const d = await gql(`query { pod(input:{podId:"${podId}"}) { desiredStatus machine { dataCenterId } runtime { ports { ip isIpPublic } } } }`)
      reportedDc = d?.pod?.machine?.dataCenterId ?? null
      ip = (d?.pod?.runtime?.ports || []).find(x => x.isIpPublic)?.ip ?? null
      if (ip) break
    }
    const g = ip ? await geoOf(ip) : null
    const ipKmFromUser = g ? Math.round(haversine(lat, lon, g.lat, g.lon)) : null
    console.log(`   ┌─ RESULT ───────────────────────────────────`)
    console.log(`   │ pinned DC      : ${dc.id}  (${dc.km} km from you)`)
    console.log(`   │ RunPod says DC : ${reportedDc ?? 'null (community host — no DC reported)'}`)
    console.log(`   │ actual IP loc  : ${g ? `${g.city}, ${g.country}  (${ipKmFromUser} km from you)` : 'no public IP yet'}`)
    const honored = reportedDc === dc.id || (ipKmFromUser != null && ipKmFromUser < 1500)
    console.log(`   │ PIN HONORED?   : ${honored ? 'YES ✅' : 'NO ❌ — RunPod placed it elsewhere'}`)
    console.log(`   └─────────────────────────────────────────────`)
    return true
  } finally {
    try { await rest('DELETE', `/pods/${podId}`); console.log(`   destroyed ${podId}`) }
    catch (e) { console.log(`   ⚠️  FAILED TO DESTROY ${podId} — remove it manually! ${e.message}`) }
  }
}

console.log(`Walking nearest datacenters, pinning ONE at a time  [cloud=${CLOUD}]:`)
let done = false
for (const dc of ranked.slice(0, NEAREST_TO_TRY)) {
  for (const gpu of GPUS) {
    if (await attempt(dc, gpu)) { done = true; break }
  }
  if (done) break
}
if (!done) console.log('\nNo community capacity in your nearest datacenters right now (try again later).')
console.log('\nDone.')
