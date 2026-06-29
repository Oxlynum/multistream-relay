// Provider-universality unit tests (termination-system-plan Phase 2). No test framework
// in this repo — run with:
//   cd web && npx tsx scripts/test-provider-universality.ts
// Exits non-zero on any failure. Verifies:
//   * managed-identity name builders ↔ owner parsers round-trip (the orphan reconcile's
//     only identity), incl. the pod/hub prefix collision guard.
//   * the strict resolver: a blank/unknown/wrong-kind provider THROWS (no silent Vast
//     fallback → no leak), a known one resolves.
//   * the ACTIVE_* sets are correctly DERIVED from the single registry.

import assert from 'node:assert/strict'
import {
  podName, hubName, ownerOfPodName, ownerOfHubName, MANAGED_BY, POD_PREFIX, HUB_PREFIX,
} from '../lib/managed-identity'
import {
  getProvider, getVpsProvider, resolveProvider,
  ACTIVE_PROVIDERS, ACTIVE_BACKEND_PROVIDERS, ACTIVE_VPS_PROVIDERS,
} from '../lib/providers'

let passed = 0
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`); process.exitCode = 1 }
}

console.log('managed-identity:')

check('pod name round-trips to owner id', () => {
  const uid = 'abcdef12-3456-7890-aaaa-bbbbbbbbbbbb'
  const name = podName(uid)
  assert.equal(name, `${POD_PREFIX}abcdef12`)
  assert.equal(ownerOfPodName(name), 'abcdef12')
})

check('hub name round-trips to hub-id tail', () => {
  const hid = 'deadbeef-1111-2222-3333-444444444444'
  const name = hubName('fsn1', hid)
  assert.equal(name, `${HUB_PREFIX}fsn1-deadbeef`)
  assert.equal(ownerOfHubName(name), 'deadbeef')
})

check('a hub name is NOT parsed as a pod name (prefix collision guard)', () => {
  // Both start with 'slimcast-'; ownerOfPodName must reject hub names or the GPU reaper
  // pass would strip 'slimcast-' off a hub and mis-handle it.
  const name = hubName('nbg1', 'feedface-...')
  assert.equal(ownerOfPodName(name), null)
})

check('GPU listInstances filter (ownerOfPodName != null) is hub-EXCLUSIVE', () => {
  // This is the exact predicate vast.ts/runpod.ts listInstances filter on. It must keep
  // pods and drop hubs + non-slimcast — otherwise a hub surfacing in the GPU reaper pass
  // gets ownerId=null and is destroyed (adversarial-review finding, 2026-06-28).
  const isPod = (n: string) => ownerOfPodName(n) != null
  assert.equal(isPod(podName('abcdef12-...')), true)        // pod kept
  assert.equal(isPod(hubName('fsn1', 'deadbeef-...')), false) // hub dropped
  assert.equal(isPod('nginx-prod'), false)                  // foreign box dropped
})

check('non-managed names parse to null', () => {
  assert.equal(ownerOfPodName('some-other-box'), null)
  assert.equal(ownerOfPodName(''), null)
  assert.equal(ownerOfPodName(null), null)
  assert.equal(ownerOfHubName('slimcast-notahub'), null)
})

check('MANAGED_BY is the shared root of both prefixes', () => {
  assert.equal(POD_PREFIX, `${MANAGED_BY}-`)
  assert.ok(HUB_PREFIX.startsWith(POD_PREFIX))
})

console.log('strict resolver (no blank = vast):')

check('getProvider resolves a known GPU provider', () => {
  assert.equal(getProvider('vast').name, 'vast')
  assert.equal(getProvider('runpod').name, 'runpod')
})

check('getProvider THROWS on empty string (the old leak)', () => {
  assert.throws(() => getProvider(''), /Unknown gpu provider/)
})

check('getProvider THROWS on null/undefined', () => {
  assert.throws(() => getProvider(null), /Unknown gpu provider/)
  assert.throws(() => getProvider(undefined), /Unknown gpu provider/)
})

check('getProvider THROWS on an unknown name', () => {
  assert.throws(() => getProvider('lambda'), /Unknown gpu provider/)
})

check('getProvider THROWS on a VPS name (wrong kind)', () => {
  assert.throws(() => getProvider('hetzner'), /Unknown gpu provider/)
})

check('getVpsProvider resolves hetzner, THROWS on blank / wrong kind', () => {
  assert.equal(getVpsProvider('hetzner').name, 'hetzner')
  assert.throws(() => getVpsProvider(''), /Unknown vps provider/)
  assert.throws(() => getVpsProvider('vast'), /Unknown vps provider/)
})

check('resolveProvider dispatches by kind', () => {
  assert.equal(resolveProvider('gpu', 'vast').name, 'vast')
  assert.equal(resolveProvider('vps', 'hetzner').name, 'hetzner')
  assert.throws(() => resolveProvider('gpu', 'hetzner'))
  assert.throws(() => resolveProvider('vps', 'vast'))
})

console.log('registry-derived ACTIVE sets:')

check('ACTIVE_PROVIDERS (all-in-one) = [vast]', () => {
  assert.deepEqual(ACTIVE_PROVIDERS.map(p => p.name), ['vast'])
})

check('ACTIVE_BACKEND_PROVIDERS = [vast, runpod]', () => {
  assert.deepEqual(ACTIVE_BACKEND_PROVIDERS.map(p => p.name).sort(), ['runpod', 'vast'])
})

check('ACTIVE_VPS_PROVIDERS = [hetzner]', () => {
  assert.deepEqual(ACTIVE_VPS_PROVIDERS.map(p => p.name), ['hetzner'])
})

check('hetzner implements releaseAux (aux-resource sweep)', () => {
  assert.equal(typeof ACTIVE_VPS_PROVIDERS[0].releaseAux, 'function')
})

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`)
