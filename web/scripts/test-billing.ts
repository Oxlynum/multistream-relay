// Phase 3 billing-math unit tests. No test framework in this repo — run with:
//   cd web && npx tsx scripts/test-billing.ts
// Exits non-zero on any failure. Verifies the locked two-tier rates, the passthrough
// classification (incl. eligible-Twitch eRTMP), the 24/7-deterrent passthrough rate,
// and the computeBurnRate ↔ buildPricingBreakdown consistency invariant.

import assert from 'node:assert/strict'
import {
  buildBillingContext,
  billingLineItems,
  computeBurnRate,
  buildPricingBreakdown,
  spendableTokens,
  PASSTHROUGH_TOKENS_PER_HR,
  TOKEN_PRICE_USD,
  type BillingPlatformRow,
  type OutputSettingsMap,
  type Plan,
} from '../lib/billing'

let passed = 0
let failed = 0
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${(e as Error).message.split('\n')[0]}`) }
}

// Helper: build a platform row.
function row(platform: string, orientation: 'landscape' | 'portrait', extra: Partial<BillingPlatformRow> = {}): BillingPlatformRow {
  return { platform, orientation, enabled: true, ...extra }
}

// Helper: burn rate for a platform set + plan.
function burn(platforms: BillingPlatformRow[], plan: Plan, settings: OutputSettingsMap = {}, has2k = false): number {
  const ctx = buildBillingContext(platforms, settings, has2k, true)
  return computeBurnRate(ctx, true, plan)
}

console.log('billing-math tests:')

// ── Passthrough rates ────────────────────────────────────────────────────────
test('PAYG passthrough-only (YouTube) = 0.1/hr', () => {
  assert.equal(burn([row('youtube', 'landscape')], 'payg'), 0.1)
})
test('Subscriber passthrough-only (YouTube) = 0.05/hr (24/7 deterrent, not free)', () => {
  assert.equal(burn([row('youtube', 'landscape')], 'subscription'), 0.05)
})
test('Passthrough is a FLAT group charge, not per-platform (YT + eligible Twitch) PAYG = 0.1', () => {
  const platforms = [
    row('youtube', 'landscape'),
    row('twitch', 'landscape', { twitch_hevc_eligible: true, twitch_use_passthrough: true }),
  ]
  assert.equal(burn(platforms, 'payg'), 0.1)
})
test('Eligible-Twitch eRTMP bills as PASSTHROUGH (0.05 sub), not a 1.0 transcode', () => {
  const platforms = [row('twitch', 'landscape', { twitch_hevc_eligible: true, twitch_use_passthrough: true })]
  assert.equal(burn(platforms, 'subscription'), 0.05)
})
test('Non-eligible Twitch landscape bills as TRANSCODE base 1.0', () => {
  const platforms = [row('twitch', 'landscape', { twitch_hevc_eligible: false })]
  assert.equal(burn(platforms, 'payg'), 1.0)
})
test('Eligible Twitch but opted OUT of passthrough → transcode 1.0', () => {
  const platforms = [row('twitch', 'landscape', { twitch_hevc_eligible: true, twitch_use_passthrough: false })]
  assert.equal(burn(platforms, 'payg'), 1.0)
})

// ── Transcode base + adders ──────────────────────────────────────────────────
test('Single landscape transcode (Kick) = 1.0', () => {
  assert.equal(burn([row('kick', 'landscape')], 'payg'), 1.0)
})
test('Two landscape transcodes (Kick + non-eligible Twitch) = 1.2', () => {
  const platforms = [row('kick', 'landscape'), row('twitch', 'landscape', { twitch_hevc_eligible: false })]
  assert.equal(burn(platforms, 'payg'), 1.2)
})
test('PORTRAIT-ONLY single (TikTok) = 1.0 (regression: old code double-charged 1.2)', () => {
  assert.equal(burn([row('tiktok', 'portrait')], 'payg'), 1.0)
})
test('Landscape + separate-platform portrait (Kick + TikTok) = 1.2', () => {
  const platforms = [row('kick', 'landscape'), row('tiktok', 'portrait')]
  assert.equal(burn(platforms, 'payg'), 1.2)
})
test('Dual-format (Kick landscape + Kick portrait) = 1.0 + 0.1 = 1.1', () => {
  const platforms = [row('kick', 'landscape'), row('kick', 'portrait')]
  assert.equal(burn(platforms, 'payg'), 1.1)
})

// ── Combined passthrough + transcode ─────────────────────────────────────────
test('YouTube (pass) + Kick (transcode) PAYG = 1.0 + 0.1 = 1.1', () => {
  assert.equal(burn([row('youtube', 'landscape'), row('kick', 'landscape')], 'payg'), 1.1)
})
test('YouTube (pass) + Kick (transcode) SUB = 1.0 + 0.05 = 1.05', () => {
  assert.equal(burn([row('youtube', 'landscape'), row('kick', 'landscape')], 'subscription'), 1.05)
})

// ── 1440p + pro adders ───────────────────────────────────────────────────────
test('1440p adder (+0.5) only when has_2k_addon', () => {
  const platforms = [row('kick', 'landscape')]
  const settings: OutputSettingsMap = { kick: { resolution: '1440p' } }
  assert.equal(burn(platforms, 'payg', settings, false), 1.0) // no addon → no adder
  assert.equal(burn(platforms, 'payg', settings, true), 1.5)  // addon → +0.5
})
test('Pro adder (+0.5) when >3 distinct NVENC sessions', () => {
  // 4 landscape transcodes at distinct bitrates → 4 NVENC sessions → pro.
  const platforms = [
    row('kick', 'landscape'), row('twitch', 'landscape', { twitch_hevc_eligible: false }),
    row('a', 'landscape'), row('b', 'landscape'),
  ]
  const settings: OutputSettingsMap = {
    kick: { bitrate_kbps: 6000 }, twitch: { bitrate_kbps: 5000 },
    a: { bitrate_kbps: 4000 }, b: { bitrate_kbps: 3000 },
  }
  // base 1.0 + 3 extra landscape (0.6) + pro 0.5 = 2.1
  assert.equal(burn(platforms, 'payg', settings), 2.1)
})

// ── Not streaming ────────────────────────────────────────────────────────────
test('Not streaming → 0', () => {
  const ctx = buildBillingContext([row('kick', 'landscape')], {}, false, false)
  assert.equal(computeBurnRate(ctx, false, 'payg'), 0)
})

// ── Consistency invariant: computeBurnRate == sum(line items) == breakdown total ──
const configs: Array<{ name: string; platforms: BillingPlatformRow[]; plan: Plan; has2k?: boolean; settings?: OutputSettingsMap }> = [
  { name: 'yt-only', platforms: [row('youtube', 'landscape')], plan: 'payg' },
  { name: 'tiktok-only', platforms: [row('tiktok', 'portrait')], plan: 'subscription' },
  { name: 'kick+tiktok+yt', platforms: [row('kick', 'landscape'), row('tiktok', 'portrait'), row('youtube', 'landscape')], plan: 'payg' },
  { name: 'dual+2k', platforms: [row('kick', 'landscape'), row('kick', 'portrait')], plan: 'subscription', has2k: true, settings: { kick: { resolution: '1440p' } } },
]
for (const c of configs) {
  test(`consistency: computeBurnRate == breakdown total (${c.name})`, () => {
    const ctx = buildBillingContext(c.platforms, c.settings ?? {}, c.has2k ?? false, true)
    const rate = computeBurnRate(ctx, true, c.plan)
    const items = billingLineItems(ctx, c.plan)
    const itemSum = Math.round(items.reduce((s, i) => s + i.tokens_per_hr, 0) * 1000) / 1000
    const breakdown = buildPricingBreakdown(ctx, c.plan)
    assert.equal(rate, itemSum, 'computeBurnRate != sum(line items)')
    assert.equal(rate, breakdown.total_tokens_per_hr, 'computeBurnRate != breakdown.total_tokens_per_hr')
    assert.equal(breakdown.total_dollars_per_hr, Math.round(rate * TOKEN_PRICE_USD * 1000) / 1000, 'dollars != tokens * price')
  })
}

// ── spendableTokens ──────────────────────────────────────────────────────────
test('spendableTokens = allotment + purchased', () => {
  assert.equal(spendableTokens({ allotment_tokens: 12.5, streaming_credits: 3.25 }), 15.75)
  assert.equal(spendableTokens({ allotment_tokens: null, streaming_credits: '2.000' }), 2)
  assert.equal(spendableTokens(null), 0)
})

// ── Rate-constant sanity ─────────────────────────────────────────────────────
test('passthrough constants: sub 0.05 < payg 0.1', () => {
  assert.equal(PASSTHROUGH_TOKENS_PER_HR.subscription, 0.05)
  assert.equal(PASSTHROUGH_TOKENS_PER_HR.payg, 0.1)
  assert.ok(PASSTHROUGH_TOKENS_PER_HR.subscription < PASSTHROUGH_TOKENS_PER_HR.payg)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
