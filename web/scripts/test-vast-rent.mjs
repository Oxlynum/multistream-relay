// test-vast-rent.mjs — Verify the Vast RENT → ports → destroy lifecycle for real,
// before we trust create()/getStatus()/destroy() in production. Same discipline
// as test-dc-pin.mjs: don't believe the API until a live round-trip proves it.
//
// Rents the cheapest usable offer with a TINY image (nginx:alpine — fast pull,
// stays running), waits for the host to map our RTMP/HLS ports + assign an IP,
// dumps exactly what Vast returns, then DESTROYS it (finally block). ~a few cents.
//
// Run:  node web/scripts/test-vast-rent.mjs   (reads VAST_API_KEY from .env.local)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let KEY = process.env.VAST_API_KEY
if (!KEY) {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
  KEY = env.match(/^VAST_API_KEY=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, '')
}
if (!KEY) { console.error('No VAST_API_KEY'); process.exit(1) }

const BASE = 'https://console.vast.ai/api/v0'
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 1. cheapest usable offer (Turing+, reliable, enough ports/bandwidth)
const q = {
  verified: { eq: true }, rentable: { eq: true }, rented: { eq: false }, num_gpus: { eq: 1 },
  compute_cap: { gte: 750 }, reliability2: { gte: 0.95 }, inet_up: { gte: 50 },
  direct_port_count: { gte: 2 }, dph_total: { lte: 1.0 }, type: 'on-demand',
  order: [['dph_total', 'asc']], limit: 1,
}
const sr = await fetch(`${BASE}/bundles?q=${encodeURIComponent(JSON.stringify(q))}`, { headers: H })
const offer = (await sr.json()).offers?.[0]
if (!offer) { console.error('no usable offer found'); process.exit(1) }
console.log(`Cheapest usable offer: id=${offer.id} ${offer.gpu_name} $${offer.dph_total.toFixed(3)}/hr  ${offer.geolocation}  cc=${offer.compute_cap}`)

// 2. rent it with a tiny image, exposing RTMP + HLS
console.log('\nRenting (PUT /asks/{id}/) with nginx:alpine + ports 1935,8888...')
const rentBody = {
  client_id: 'me', image: 'nginx:alpine', disk: 10, label: 'slimcast-vasttest',
  runtype: 'args', ports: '1935/tcp,8888/tcp',
}
const rr = await fetch(`${BASE}/asks/${offer.id}/`, { method: 'PUT', headers: H, body: JSON.stringify(rentBody) })
const rj = await rr.json().catch(() => ({}))
console.log('rent response:', JSON.stringify(rj))
const instId = rj.new_contract
if (!rr.ok || !instId) { console.error(`rent failed (HTTP ${rr.status})`); process.exit(1) }
console.log(`instance id = ${instId}`)

try {
  // 3. poll instance for status + IP + mapped ports
  let inst = null
  for (let i = 0; i < 24; i++) {
    await sleep(5000)
    const lr = await fetch(`${BASE}/instances/`, { headers: H })
    inst = ((await lr.json()).instances ?? []).find(x => String(x.id) === String(instId))
    const ports = inst?.ports ? Object.keys(inst.ports).join(',') : 'none'
    console.log(`  [${(i + 1) * 5}s] status=${inst?.actual_status} ip=${inst?.public_ipaddr} mappedPorts=${ports}`)
    if (inst?.public_ipaddr && inst?.ports && Object.keys(inst.ports).length) break
  }
  console.log('\n┌─ what getStatus() will parse ───────────────')
  console.log('│ public_ipaddr :', inst?.public_ipaddr)
  console.log('│ ports (raw)   :', JSON.stringify(inst?.ports))
  console.log('│ 1935 mapping  :', JSON.stringify(inst?.ports?.['1935/tcp']))
  console.log('│ 8888 mapping  :', JSON.stringify(inst?.ports?.['8888/tcp']))
  console.log('│ actual_status :', inst?.actual_status)
  console.log('└─────────────────────────────────────────────')
  console.log('\nFull instance keys:', inst ? Object.keys(inst).sort().join(', ') : '(none)')
} finally {
  console.log(`\nDestroying instance ${instId}...`)
  const dr = await fetch(`${BASE}/instances/${instId}/`, { method: 'DELETE', headers: H })
  console.log(`DELETE → HTTP ${dr.status}  ${dr.ok ? '✅ destroyed' : '⚠️ DESTROY FAILED — remove it manually in the Vast console!'}`)
}
