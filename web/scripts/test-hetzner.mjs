// test-hetzner.mjs — Verify the Hetzner CREATE → status → destroy → RELEASE-IP
// lifecycle for real, before we trust hetzner.ts in production. Same discipline as
// test-vast-rent.mjs: don't believe the provider API until a live round-trip proves it.
//
// What it proves:
//   1. The real server-type catalog (settles the "cpx32 doesn't exist" finding —
//      prints the actual ids: cpx11/21/31/41/51, cx22/32/42, ccx13...).
//   2. create() returns a server id + a PRIMARY IPv4 id (public_net.ipv4.id).
//   3. The CRITICAL leak claim: does the primary IP SURVIVE server deletion?
//      It deletes the server, re-GETs the primary IP, and reports survived-or-not.
//   4. Our teardown order works: DELETE /primary_ips/{id} after the server is gone,
//      then confirms the IP is 404 (truly released — no ~€0.50/mo leak).
//
// Cost: a few cents (cheapest x86 type, destroyed within ~30s).
// Run:  node web/scripts/test-hetzner.mjs   (reads HETZNER_API_TOKEN from .env.local)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let TOKEN = process.env.HETZNER_API_TOKEN
if (!TOKEN) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    TOKEN = env.match(/^HETZNER_API_TOKEN=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* no .env.local */ }
}
if (!TOKEN) {
  console.error('No HETZNER_API_TOKEN (set it in web/.env.local or the environment).')
  process.exit(1)
}

const BASE = 'https://api.hetzner.cloud/v1'
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const hz = (p, init) => fetch(`${BASE}${p}`, { ...init, headers: { ...H, ...(init?.headers || {}) } })

// ── 1. live catalog ──────────────────────────────────────────────────────────
console.log('Fetching live server-type catalog + locations...')
const [stRes, locRes] = await Promise.all([hz('/server_types?per_page=50'), hz('/locations')])
if (!stRes.ok || !locRes.ok) {
  console.error(`catalog fetch failed: server_types ${stRes.status}, locations ${locRes.status}`)
  process.exit(1)
}
const serverTypes = (await stRes.json()).server_types ?? []
const locations = (await locRes.json()).locations ?? []
const locByName = new Map(locations.map(l => [l.name, l]))

console.log(`\nLocations (${locations.length}):`)
for (const l of locations) console.log(`  ${l.name.padEnd(6)} ${String(l.city ?? '').padEnd(14)} lat=${l.latitude} lon=${l.longitude}`)

console.log(`\nServer types (x86, non-deprecated):`)
const rows = []
for (const st of serverTypes) {
  if (st.deprecation) continue
  if ((st.architecture ?? 'x86') !== 'x86') continue
  const pr = (st.prices ?? [])[0]
  const hourly = pr?.price_hourly?.gross ? parseFloat(pr.price_hourly.gross) : NaN
  const inclTb = pr?.included_traffic ? (pr.included_traffic / 1e12).toFixed(0) : '?'
  rows.push({ st, hourly })
  console.log(`  ${st.name.padEnd(8)} ${st.cores}c / ${String(st.memory).padStart(3)}g  $${Number.isFinite(hourly) ? hourly.toFixed(4) : '?'}/hr  ${inclTb}TB incl  [${st.cpu_type}/${st.architecture}]`)
}

// cheapest viable x86 type for the throwaway lifecycle test
const viable = rows.filter(r => Number.isFinite(r.hourly)).sort((a, b) => a.hourly - b.hourly)
if (viable.length === 0) { console.error('no priced x86 server type found'); process.exit(1) }
const pick = viable[0].st
const pickLoc = (pick.prices ?? []).find(p => locByName.has(p.location))?.location
if (!pickLoc) { console.error('picked type has no usable location'); process.exit(1) }
console.log(`\nWill create cheapest: ${pick.name} @ ${pickLoc}  ($${viable[0].hourly.toFixed(4)}/hr)`)

// ── 2. create ────────────────────────────────────────────────────────────────
const name = `slimcast-hztest-${Date.now()}`
const createBody = {
  name,
  server_type: pick.name,
  location: pickLoc,
  image: 'ubuntu-22.04',
  start_after_create: true,
  public_net: { enable_ipv4: true, enable_ipv6: false },
  labels: { 'managed-by': 'slimcast', purpose: 'lifecycle-test' },
  // minimal cloud-init — we don't need Docker for a lifecycle probe
  user_data: '#cloud-config\nruncmd:\n  - echo slimcast-hztest > /root/hztest\n',
}
console.log('\nCreating server (POST /servers)...')
const cr = await hz('/servers', { method: 'POST', body: JSON.stringify(createBody) })
const cj = await cr.json().catch(() => ({}))
if (!cr.ok || !cj.server?.id) {
  console.error(`create failed (HTTP ${cr.status}):`, JSON.stringify(cj.error ?? cj).slice(0, 300))
  process.exit(1)
}
const serverId = cj.server.id
const primaryIp = cj.server.public_net?.ipv4 ?? null
const primaryIpId = primaryIp?.id ?? null
console.log(`  server id   = ${serverId}`)
console.log(`  primary IP  = ${primaryIp?.ip} (resource id ${primaryIpId})`)
if (!primaryIpId) console.log('  ⚠️  no primary IP id returned — destroy() IP-release path can only work via getStatus lookup')

let serverDeleted = false
let ipReleased = false
try {
  // ── 3. poll status briefly ─────────────────────────────────────────────────
  for (let i = 0; i < 6; i++) {
    await sleep(5000)
    const sr = await hz(`/servers/${serverId}`)
    const srv = (await sr.json()).server ?? {}
    console.log(`  [${(i + 1) * 5}s] status=${srv.status} ip=${srv.public_net?.ipv4?.ip} region=${srv.datacenter?.location?.name}`)
    if (srv.status === 'running') break
  }
} finally {
  // ── 4. teardown: delete server FIRST, then release the primary IP ───────────
  console.log(`\nDeleting server ${serverId} (DELETE /servers/${serverId})...`)
  const dr = await hz(`/servers/${serverId}`, { method: 'DELETE' })
  serverDeleted = dr.ok || dr.status === 404
  console.log(`  DELETE server → HTTP ${dr.status} ${serverDeleted ? '✅' : '⚠️ FAILED — remove it manually in the Hetzner console!'}`)

  if (primaryIpId) {
    // The auto-created IP defaults to auto_delete=true, but Hetzner releases it
    // ASYNCHRONOUSLY after the server teardown finishes (an assigned IP can't be
    // deleted — returns 422). So poll: success = it 404s (auto-released) OR becomes
    // UNASSIGNED, in which case we delete the orphan ourselves (mirrors destroy()).
    console.log(`  Waiting for primary IP ${primaryIpId} to release (auto_delete is async)...`)
    for (let i = 0; i < 15; i++) {   // up to ~75s
      await sleep(5000)
      const gr = await hz(`/primary_ips/${primaryIpId}`)
      if (gr.status === 404) {
        console.log(`  [${(i + 1) * 5}s] ✅ auto-released (404) — no separate delete needed.`)
        ipReleased = true
        break
      }
      const ip = (await gr.json()).primary_ip ?? {}
      if (ip.assignee_id == null) {
        console.log(`  [${(i + 1) * 5}s] now UNASSIGNED (auto_delete=${ip.auto_delete}) — deleting orphan...`)
        const ir = await hz(`/primary_ips/${primaryIpId}`, { method: 'DELETE' })
        const vr = await hz(`/primary_ips/${primaryIpId}`)
        ipReleased = (ir.ok || ir.status === 404) && vr.status === 404
        console.log(`  DELETE primary_ip → HTTP ${ir.status}; verify GET → HTTP ${vr.status} ${ipReleased ? '✅ released' : '⚠️ still present'}`)
        break
      }
      console.log(`  [${(i + 1) * 5}s] still assigned (assignee=${ip.assignee_id}, auto_delete=${ip.auto_delete}) — waiting...`)
    }
    if (!ipReleased) console.log(`  ⚠️ primary IP ${primaryIpId} NOT confirmed released — check the Hetzner console (it bills ~€0.50/mo).`)
  }
}

console.log('\n── Verdict ───────────────────────────────────')
console.log(`Catalog fetched:     ✅ ${serverTypes.length} server types, ${locations.length} locations`)
console.log(`Create/status/destroy: ${serverDeleted ? '✅' : '❌'}`)
console.log(`Primary-IP released:   ${primaryIpId ? (ipReleased ? '✅ confirmed gone' : '❌ NOT confirmed — check console') : '⚠️ no primary IP id to test'}`)
console.log('\nIf all green, hetzner.ts create()/getStatus()/destroy() shapes are confirmed against live.')
