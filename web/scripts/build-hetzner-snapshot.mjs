// build-hetzner-snapshot.mjs — Build a PRE-BAKED Hetzner snapshot for the VPS hub
// (Phase 4). The snapshot has Docker installed+enabled and the relay image already
// pulled, so a hub boots from it in seconds — cloud-init then only `docker run`s with
// the box's per-server env (see lib/cloud-init.ts prebaked path). Without a snapshot,
// hubs fall back to apt-install + docker-pull on every cold boot (~30–90s).
//
// What it does:
//   1. Reads the live catalog, picks the cheapest x86 EU server type (network_zone
//      eu-central — matches the EU-only hub policy; snapshots are project-wide so they
//      boot in any EU location regardless of where they're built).
//   2. Creates a throwaway "builder" box whose cloud-init installs Docker, logs into
//      ghcr, pulls SLIMCAST_RELAY_IMAGE, then powers itself off (power_state).
//   3. Waits for it to power off, then creates a snapshot image from it.
//   4. Destroys the builder box + releases its primary IP (same discipline as
//      test-hetzner.mjs — the IP bills ~€0.50/mo if leaked).
//   5. Prints the snapshot id → set HETZNER_SNAPSHOT_ID in Vercel + redeploy.
//      (Optionally deletes older slimcast relay snapshots so they don't accumulate.)
//
// REBUILD THIS whenever the relay image changes (the snapshot bakes a specific image).
//
// Cost: a few cents for the builder box (destroyed in minutes) + ~€0.011/GB·mo for the
// snapshot it leaves behind (the relay image is ~0.23GB → trivial).
//
// Run:  node web/scripts/build-hetzner-snapshot.mjs            (build + prune old)
//       node web/scripts/build-hetzner-snapshot.mjs --keep-old (build, keep old snapshots)
//       node web/scripts/build-hetzner-snapshot.mjs --list     (list slimcast snapshots)
//       node web/scripts/build-hetzner-snapshot.mjs --cleanup  (delete ALL slimcast snapshots)
//
// Reads HETZNER_API_TOKEN, SLIMCAST_RELAY_IMAGE, VAST_IMAGE_LOGIN from web/.env.local.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function fromEnvFile(key) {
  if (process.env[key]) return process.env[key]
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    return env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '')
  } catch { return undefined }
}

const TOKEN = fromEnvFile('HETZNER_API_TOKEN')
if (!TOKEN) {
  console.error('No HETZNER_API_TOKEN (set it in web/.env.local or the environment).')
  process.exit(1)
}
const RELAY_IMAGE = fromEnvFile('SLIMCAST_RELAY_IMAGE') || 'ghcr.io/oxlynum/multistream-relay:latest'
const IMAGE_LOGIN_RAW = fromEnvFile('VAST_IMAGE_LOGIN') // "-u USER -p TOKEN SERVER"

const args = new Set(process.argv.slice(2))
const MODE = args.has('--list') ? 'list' : args.has('--cleanup') ? 'cleanup' : 'build'
const KEEP_OLD = args.has('--keep-old')

const BASE = 'https://api.hetzner.cloud/v1'
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const hz = (p, init) => fetch(`${BASE}${p}`, { ...init, headers: { ...H, ...(init?.headers || {}) }, signal: AbortSignal.timeout(15000) })

const SNAP_LABEL = 'managed-by=slimcast'   // shared with servers; kind distinguishes snapshots
const SNAP_KIND = 'relay-snapshot'

// ── snapshot list / cleanup helpers ────────────────────────────────────────────
async function listSnapshots() {
  // Snapshots are images of type 'snapshot'; filter to ours by label.
  const r = await hz(`/images?type=snapshot&label_selector=${encodeURIComponent(SNAP_LABEL)}`)
  if (!r.ok) { console.error(`list images → HTTP ${r.status}`); return [] }
  const imgs = (await r.json()).images ?? []
  return imgs.filter(i => (i.labels ?? {}).kind === SNAP_KIND)
}

async function deleteSnapshot(id) {
  const r = await hz(`/images/${id}`, { method: 'DELETE' })
  return r.ok || r.status === 404
}

if (MODE === 'list' || MODE === 'cleanup') {
  const snaps = await listSnapshots()
  if (snaps.length === 0) { console.log('No slimcast relay snapshots found.'); process.exit(0) }
  console.log(`Slimcast relay snapshots (${snaps.length}):`)
  for (const s of snaps) {
    console.log(`  id=${s.id}  ${s.description ?? '(no description)'}  ${(s.image_size ?? '?')}GB  created=${s.created}`)
  }
  if (MODE === 'cleanup') {
    for (const s of snaps) {
      const ok = await deleteSnapshot(s.id)
      console.log(`  DELETE image ${s.id} → ${ok ? '✅' : '⚠️ failed'}`)
    }
  }
  process.exit(0)
}

// ── build ──────────────────────────────────────────────────────────────────────
// Parse the ghcr login so the builder can pull the private relay image.
let login = null
if (IMAGE_LOGIN_RAW) {
  const m = IMAGE_LOGIN_RAW.match(/-u\s+(\S+)\s+-p\s+(\S+)\s+(\S+)/)
  if (m) login = { username: m[1], password: m[2], server: m[3] }
}
if (!login) {
  console.warn('⚠️  No VAST_IMAGE_LOGIN parsed — assuming the relay image is PUBLIC. A private')
  console.warn('    ghcr image will fail to pull and the snapshot will not contain it.')
}

const sq = v => String(v).replace(/'/g, `'\\''`)

console.log('Fetching live server-type catalog + locations...')
const [stRes, locRes] = await Promise.all([hz('/server_types?per_page=50'), hz('/locations')])
if (!stRes.ok || !locRes.ok) {
  console.error(`catalog fetch failed: server_types ${stRes.status}, locations ${locRes.status}`)
  process.exit(1)
}
const serverTypes = (await stRes.json()).server_types ?? []
const locations = (await locRes.json()).locations ?? []
// EU only (eu-central network zone) — matches the hub region policy; snapshots are
// project-wide so building in EU is fine no matter where hubs ultimately boot.
const euLoc = new Set(locations.filter(l => l.network_zone === 'eu-central').map(l => l.name))
if (euLoc.size === 0) { console.error('no eu-central locations found'); process.exit(1) }

// Cheapest x86 non-deprecated type that prices in an EU location.
const rows = []
for (const st of serverTypes) {
  if (st.deprecation) continue
  if ((st.architecture ?? 'x86') !== 'x86') continue
  const pr = (st.prices ?? []).find(p => euLoc.has(p.location))
  if (!pr) continue
  const hourly = pr.price_hourly?.gross ? parseFloat(pr.price_hourly.gross) : NaN
  if (!Number.isFinite(hourly)) continue
  rows.push({ st, location: pr.location, hourly })
}
rows.sort((a, b) => a.hourly - b.hourly)
if (rows.length === 0) { console.error('no priced x86 EU server type found'); process.exit(1) }
const pick = rows[0]
console.log(`Builder box: ${pick.st.name} @ ${pick.location}  ($${pick.hourly.toFixed(4)}/hr, EU)`)
console.log(`Baking relay image: ${RELAY_IMAGE}`)

// Builder cloud-init: install Docker, login, pull the relay image, logout, power off.
// (We DON'T start the container — the snapshot only needs the image present; the hub's
//  own cloud-init runs it with per-server env.) power_state waits for runcmd to finish.
const loginCmd = login
  ? `docker login ${sq(login.server)} -u '${sq(login.username)}' -p '${sq(login.password)}'`
  : `: # public image, no login`
const builderCloudInit = [
  '#cloud-config',
  'package_update: true',
  'packages:',
  '  - docker.io',
  'runcmd:',
  '  - systemctl enable --now docker',
  `  - ${loginCmd}`,
  `  - docker pull ${sq(RELAY_IMAGE)}`,
  '  - docker logout ghcr.io 2>/dev/null || true',
  'power_state:',
  '  mode: poweroff',
  '  timeout: 60',
  '  condition: true',
  '',
].join('\n')

const name = `slimcast-snapbuild-${Date.now()}`
console.log('\nCreating builder server (POST /servers)...')
const cr = await hz('/servers', {
  method: 'POST',
  body: JSON.stringify({
    name,
    server_type: pick.st.name,
    location: pick.location,
    image: 'ubuntu-22.04',
    start_after_create: true,
    public_net: { enable_ipv4: true, enable_ipv6: false },
    labels: { 'managed-by': 'slimcast', purpose: 'snapshot-build' },
    user_data: builderCloudInit,
  }),
})
const cj = await cr.json().catch(() => ({}))
if (!cr.ok || !cj.server?.id) {
  console.error(`create failed (HTTP ${cr.status}):`, JSON.stringify(cj.error ?? cj).slice(0, 300))
  process.exit(1)
}
const serverId = cj.server.id
const primaryIpId = cj.server.public_net?.ipv4?.id ?? null
console.log(`  server id = ${serverId}  ip = ${cj.server.public_net?.ipv4?.ip}  (primary-ip id ${primaryIpId})`)

let snapshotId = null
try {
  // Wait for cloud-init to finish + the box to power itself off (install + pull + poweroff).
  console.log('\nWaiting for the builder to install Docker, pull the image, and power off...')
  let off = false
  for (let i = 0; i < 120; i++) {   // up to ~10 min
    await sleep(5000)
    const sr = await hz(`/servers/${serverId}`)
    const srv = (await sr.json()).server ?? {}
    if (i % 3 === 0 || srv.status === 'off') console.log(`  [${(i + 1) * 5}s] status=${srv.status}`)
    if (srv.status === 'off') { off = true; break }
  }
  if (!off) {
    console.error('⚠️  builder never powered off within 10 min — aborting (it may still be pulling).')
    console.error('    Inspect it in the Hetzner console, then re-run. Cleaning up the box now.')
    throw new Error('builder did not power off')
  }
  console.log('  ✅ builder powered off — image is baked.')

  // Create the snapshot from the powered-off box.
  console.log('\nCreating snapshot (POST /servers/{id}/actions/create_image)...')
  const ir = await hz(`/servers/${serverId}/actions/create_image`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'snapshot',
      description: `slimcast relay snapshot — ${RELAY_IMAGE}`,
      labels: { 'managed-by': 'slimcast', kind: SNAP_KIND },
    }),
  })
  const ij = await ir.json().catch(() => ({}))
  if (!ir.ok || !ij.image?.id || !ij.action?.id) {
    console.error(`create_image failed (HTTP ${ir.status}):`, JSON.stringify(ij.error ?? ij).slice(0, 300))
    throw new Error('create_image failed')
  }
  snapshotId = ij.image.id
  const actionId = ij.action.id
  console.log(`  snapshot image id = ${snapshotId} (action ${actionId}) — waiting for it to finalize...`)
  let finalized = false
  for (let i = 0; i < 120; i++) {   // snapshotting can take a few minutes
    await sleep(5000)
    const ar = await hz(`/actions/${actionId}`)
    const act = (await ar.json()).action ?? {}
    if (i % 3 === 0 || act.status !== 'running') console.log(`  [${(i + 1) * 5}s] snapshot action=${act.status} (${act.progress ?? 0}%)`)
    if (act.status === 'success') { finalized = true; break }
    if (act.status === 'error') { console.error('  ⚠️ snapshot action errored:', JSON.stringify(act.error)); throw new Error('snapshot action error') }
  }
  // Fail LOUDLY on timeout (symmetric with the power-off guard): throwing here skips
  // the prune + "Done" block (so good snapshots are retained and no half-baked id is
  // printed) while the finally below still cleans up the builder. exits non-zero.
  if (!finalized) throw new Error('snapshot did not finalize within 10 min — left as-is; rerun or check the Hetzner console')
} finally {
  // Teardown: delete builder server FIRST, then release the primary IP (mirrors
  // hetzner.ts destroy() — the IP survives server deletion and bills if leaked).
  console.log(`\nDeleting builder server ${serverId}...`)
  // Guarded: if the DELETE fetch itself rejects (network/timeout), still fall through
  // to the primary-IP release loop below (the documented leak guard) instead of
  // skipping it. Mirrors hetzner.ts destroy().
  try {
    const dr = await hz(`/servers/${serverId}`, { method: 'DELETE' })
    console.log(`  DELETE server → HTTP ${dr.status} ${dr.ok || dr.status === 404 ? '✅' : '⚠️ remove it manually!'}`)
  } catch (err) {
    console.error(`  ⚠️ DELETE server ${serverId} threw (${err instanceof Error ? err.message : err}) — remove it manually! Continuing to primary-IP release.`)
  }
  if (primaryIpId) {
    let released = false
    for (let i = 0; i < 15; i++) {   // up to ~75s (auto_delete is async)
      await sleep(5000)
      const gr = await hz(`/primary_ips/${primaryIpId}`)
      if (gr.status === 404) { released = true; break }
      const ip = (await gr.json()).primary_ip ?? {}
      if (ip.assignee_id == null) {
        await hz(`/primary_ips/${primaryIpId}`, { method: 'DELETE' })
        const vr = await hz(`/primary_ips/${primaryIpId}`)
        released = vr.status === 404
        break
      }
    }
    console.log(`  primary IP ${primaryIpId}: ${released ? '✅ released' : '⚠️ NOT confirmed — check console (bills ~€0.50/mo)'}`)
  }
}

if (!snapshotId) {
  console.error('\n❌ Snapshot was not created. See errors above.')
  process.exit(1)
}

// Prune older slimcast snapshots so they don't accumulate (keep only the new one).
if (!KEEP_OLD) {
  const snaps = await listSnapshots()
  const old = snaps.filter(s => String(s.id) !== String(snapshotId))
  if (old.length) {
    console.log(`\nPruning ${old.length} older slimcast snapshot(s) (pass --keep-old to retain):`)
    for (const s of old) {
      const ok = await deleteSnapshot(s.id)
      console.log(`  DELETE image ${s.id} → ${ok ? '✅' : '⚠️ failed'}`)
    }
  }
}

console.log('\n── Done ──────────────────────────────────────')
console.log(`Snapshot image id: ${snapshotId}`)
console.log('\nNext steps:')
console.log(`  1. vercel env add HETZNER_SNAPSHOT_ID   → enter: ${snapshotId}   (Production)`)
console.log('  2. Redeploy (vercel --prod) so the broker boots hubs from the snapshot.')
console.log('  3. Re-run this script after any relay image change (it bakes a specific image).')
