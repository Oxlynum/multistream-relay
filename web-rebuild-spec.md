# SlimCast Front-End Rebuild Spec — "Creator Energy, Premium Grade"

**Project root (REAL):** `/Users/danielaltom/Desktop/claude/abstrascapes/slimcast/web`
(The brief's `…/projects/slimcast/web` no longer exists — the project moved. Every path below is the real one.)

**Stack (locked, verified):** `next@16.2.9` · `react@19.2.4` · `tailwindcss@^4` (`@tailwindcss/postcss`) · TypeScript 5 · App Router · path alias `@/* → ./*` · no `src/` dir. Add: `shadcn` (CLI v4, `radix` base) + `recharts@^3` + `hls.js@^1.6` (already installed).

**Mandate:** Full visual rebuild of marketing + auth + dashboard. **Backend untouched** — every API route, Supabase query, and Stripe flow is reused verbatim. The redesign is skin + structure + truthful copy only.

**Aesthetic north star:** bold creator energy — electric, alive, confident — but *premium and legible*, never garish. Think "broadcast control room meets a creator's brand kit": deep space-black canvas, one signature aurora gradient used sparingly as a hero/brand device, crisp grotesk display type, generous space, purposeful motion. Color is a spotlight, not wallpaper.

---

## 1. DESIGN SYSTEM

### 1.1 Color palette (concrete hex)

**Canvas & surfaces** (cool near-black with a faint violet undertone — reads richer than the old `#020617` navy):

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0A0A12` | page background (space-black, violet-tinted) |
| `bg-subtle` | `#0E0E18` | alt section bands |
| `surface` | `#14141F` | cards, panels |
| `surface-2` | `#1C1C2B` | elevated/hover, inputs |
| `surface-3` | `#262638` | popovers, active rows |
| `line` | `#262635` | hairline borders |
| `line-strong` | `#3A3A52` | stronger dividers, input borders |

**Brand accents** (creator-coded violet + electric cyan):

| Token | Hex | Use |
|---|---|---|
| `brand` | `#7C5CFC` | primary accent / primary buttons (electric violet) |
| `brand-strong` | `#6A45F0` | primary hover |
| `brand-soft` | `rgba(124,92,252,0.14)` | soft fills, chips |
| `brand-glow` | `rgba(124,92,252,0.45)` | button/halo glow |
| `cyan` | `#22D3EE` | secondary accent, "live energy", links-on-dark |
| `cyan-soft` | `rgba(34,211,238,0.14)` | secondary fills |
| `pink` | `#FF5DA2` | gradient mid-stop, playful highlights |

**Semantic / status:**

| Token | Hex | Meaning |
|---|---|---|
| `live` | `#FF3B6B` | LIVE indicator dot (hot pink-red, broadcast-coded) |
| `success` | `#34D399` | connected / healthy / running |
| `warning` | `#FBBF24` | low-balance, reconnecting, throttled |
| `danger` | `#FB4E5A` | errors, destructive |
| `info` | `#22D3EE` | informational (reuses cyan) |

**Text scale:**

| Token | Hex | Use |
|---|---|---|
| `ink` | `#F5F4FB` | primary text |
| `ink-muted` | `#A2A1B8` | secondary text |
| `ink-faint` | `#6A6982` | tertiary / disabled / axis labels |
| `ink-on-brand` | `#0A0A12` | text on bright accent fills (NOT white — dark for AA on violet/cyan) |

> **Status-color constants from the dashboard audit are PRESERVED verbatim** (they encode meaning, not theme): platform dots `#37d67a / #ffb020 / #ff5470 / #555e6e`; ping `#fbbf24 / #f87171 / #37d67a`; health-chart `#10b981 / #f59e0b / #f43f5e / #475569`; chart line `#3b82f6`. Keep these literal in the ported components — do **not** swap them for the new tokens, or the GPU-status semantics drift.

### 1.2 Signature gradient (the brand device)

One hero/brand gradient — a 3-stop violet→pink→cyan "aurora". Used on: hero headline accent, primary-CTA fill (subtle), logo mark, the live-state glow, big stat numbers. Use *sparingly* (one or two per viewport) to stay premium.

```css
/* The signature SlimCast aurora */
--gradient-brand: linear-gradient(115deg, #7C5CFC 0%, #C247E6 46%, #FF5DA2 78%, #22D3EE 100%);

/* Quieter 2-stop for fills/buttons (keeps text legible) */
--gradient-brand-quiet: linear-gradient(120deg, #7C5CFC 0%, #6A45F0 100%);

/* "Live energy" gradient for active/streaming UI */
--gradient-live: linear-gradient(120deg, #22D3EE 0%, #7C5CFC 100%);
```

**Gradient-text utility** (replaces the old `.text-gradient-accent`):

```css
.text-aurora {
  background: var(--gradient-brand);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  /* slow shimmer; respects reduced-motion via the @media block below */
  background-size: 200% 200%;
  animation: aurora-pan 8s ease-in-out infinite;
}
@keyframes aurora-pan {
  0%, 100% { background-position: 0% 50%; }
  50%      { background-position: 100% 50%; }
}
```

**Ambient aurora background** (replaces `.bg-grid` + blur-blobs): a single fixed, low-opacity, slowly drifting radial composite behind the hero / final-CTA only.

```css
.aurora-bg::before {
  content: ""; position: absolute; inset: -20% -10% auto -10%; height: 130%;
  background:
    radial-gradient(40% 50% at 20% 20%, rgba(124,92,252,0.22), transparent 70%),
    radial-gradient(38% 45% at 80% 15%, rgba(255,93,162,0.16), transparent 70%),
    radial-gradient(45% 55% at 60% 80%, rgba(34,211,238,0.14), transparent 70%);
  filter: blur(40px); pointer-events: none; z-index: 0;
  animation: aurora-drift 22s ease-in-out infinite alternate;
}
@keyframes aurora-drift { from { transform: translate3d(-2%, -1%, 0) scale(1); } to { transform: translate3d(3%, 2%, 0) scale(1.08); } }

@media (prefers-reduced-motion: reduce) {
  .text-aurora, .aurora-bg::before { animation: none !important; }
}
```

### 1.3 Typography

next/font/google pairing (bold geometric grotesk display + clean humanist body + mono for metrics/kickers):

- **Display:** **Space Grotesk** (`--font-display`) — bold geometric grotesk, broadcast-confident headlines.
- **Body:** **Inter** (`--font-sans`) — clean, neutral, hyper-legible at small sizes.
- **Mono:** **JetBrains Mono** (`--font-mono`) — kickers, stat numbers, token/burn readouts, code blocks (API keys), chart ticks.

```tsx
// app/layout.tsx (module scope)
import { Space_Grotesk, Inter, JetBrains_Mono } from 'next/font/google'
const display = Space_Grotesk({ subsets: ['latin'], variable: '--font-display', weight: ['500','600','700'] })
const sans    = Inter({ subsets: ['latin'], variable: '--font-sans' })
const mono    = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' })
// <html lang="en" className={`dark ${display.variable} ${sans.variable} ${mono.variable}`}>
```

**Type scale** (use `clamp()` for fluid display sizes):

| Role | Size | Font | Weight / tracking |
|---|---|---|---|
| `display-hero` | `clamp(2.75rem, 6vw, 4.75rem)` | display | 700 / -0.02em |
| `display-xl` | `clamp(2.25rem, 4.5vw, 3.5rem)` | display | 700 / -0.02em |
| `display-lg` | `clamp(1.875rem, 3vw, 2.75rem)` | display | 600 / -0.015em |
| `h1` | `2.25rem` | display | 600 |
| `h2` | `1.75rem` | display | 600 |
| `h3` | `1.375rem` | display | 600 |
| `body-lg` | `1.125rem` | sans | 400 / 1.6 line-height |
| `body` | `1rem` | sans | 400 / 1.6 |
| `sm` | `0.875rem` | sans | 400 |
| `xs` | `0.75rem` | sans | 500 |
| `kicker` | `0.75rem` | mono | 600 / 0.2em uppercase, `brand`/`cyan` colored |
| `stat` | `clamp(2rem,4vw,3rem)` | mono | 600, often `.text-aurora` |

**Kicker** (replaces old `.kicker`, now a real component — see §3): mono, uppercase, `tracking-[0.2em]`, brand-colored, optional leading `▍` bar or `//` glyph for creator energy.

### 1.4 Radius / spacing / shadow / motion

**Radius** — generous, modern (bold but not bubble):
```
--radius: 0.875rem;            /* 14px base for cards/buttons */
--radius-sm: 0.5rem;  --radius-md: 0.75rem;  --radius-lg: 1rem;  --radius-xl: 1.5rem;  --radius-2xl: 2rem;
--radius-pill: 9999px;         /* chips, status pills, platform badges */
```

**Spacing** — 4px grid. Section rhythm `py-24` mobile / `py-32` desktop. Content max widths: marketing `max-w-6xl`, prose `max-w-3xl`, dashboard `max-w-5xl`. Card padding `p-6`/`p-8`.

**Shadow / elevation language:**
```
--shadow-sm:   0 1px 2px rgba(0,0,0,.4);
--shadow-md:   0 8px 24px -8px rgba(0,0,0,.55);
--shadow-lg:   0 24px 60px -16px rgba(0,0,0,.6);
--shadow-glow: 0 0 0 1px rgba(124,92,252,.35), 0 10px 40px -10px rgba(124,92,252,.5);   /* primary CTA + featured cards */
--shadow-live: 0 0 0 1px rgba(255,59,107,.35), 0 0 32px -6px rgba(255,59,107,.45);       /* live-state card */
```
Cards: `bg-surface border border-line`, hover → `border-line-strong` + `shadow-md` + `-translate-y-0.5`. Featured/primary → `shadow-glow`. Glass is **gone** (replaced by solid `surface` + subtle border + selective glow — reads more premium than backdrop-blur soup; keep one `backdrop-blur-xl` only on the sticky nav).

**Motion / interaction principles:**
- **Purposeful, springy, brief.** Default transition `200ms cubic-bezier(.2,.8,.2,1)`. Hover lifts `≤2px`. No gratuitous parallax.
- **Signature motions:** aurora text shimmer (8s), aurora background drift (22s), platform-logo marquee (subtle, hero strip), live-pulse ping (the broadcast dot), number count-up on stat tiles entering viewport.
- **Entrance:** fade+rise (`opacity 0→1`, `translateY 12px→0`) on scroll-into-view, staggered 60ms. Use a tiny `IntersectionObserver` hook or CSS `@starting-style` (Next 16 / modern browsers support it; Safari 16.4+ baseline is fine).
- **Reduced motion:** every animation gated behind `@media (prefers-reduced-motion: reduce)` → static.
- **Focus:** always-visible `ring-2 ring-brand ring-offset-2 ring-offset-bg` (accessibility — the old system had weak focus states).

### 1.5 `app/globals.css` — full token block (Tailwind v4 `@theme` + shadcn `:root`)

This is the single file that replaces the old `globals.css` wholesale. It carries **both** mechanisms: shadcn's runtime `:root` vars + `@theme inline` (so `bg-primary`/`text-foreground` generate and dark-mode `var()` swaps work) **and** a plain `@theme` for brand tokens + runtime font vars. **Dark-only:** `:root` holds the dark palette and `<html class="dark">` satisfies shadcn's `.dark` variant.

```css
@import "tailwindcss";
@import "tw-animate-css";
@custom-variant dark (&:is(.dark *));

/* ── shadcn semantic tokens (raw vars; .dark mirrors :root since app is dark-only) ── */
:root {
  --radius: 0.875rem;

  --background:            #0A0A12;
  --foreground:            #F5F4FB;
  --card:                  #14141F;
  --card-foreground:       #F5F4FB;
  --popover:               #1C1C2B;
  --popover-foreground:    #F5F4FB;
  --primary:               #7C5CFC;   /* brand violet */
  --primary-foreground:    #0A0A12;   /* dark text on bright violet → AA */
  --secondary:             #1C1C2B;
  --secondary-foreground:  #F5F4FB;
  --muted:                 #14141F;
  --muted-foreground:      #A2A1B8;
  --accent:                #1C1C2B;   /* shadcn "accent" = a SURFACE, not the brand color (see landmine §5) */
  --accent-foreground:     #F5F4FB;
  --destructive:           #FB4E5A;
  --destructive-foreground:#0A0A12;
  --border:                #262635;
  --input:                 #3A3A52;
  --ring:                  #7C5CFC;

  --chart-1: #7C5CFC; --chart-2: #22D3EE; --chart-3: #FF5DA2; --chart-4: #34D399; --chart-5: #FBBF24;
}
.dark { /* identical — dark is the only theme; declared so the .dark variant resolves */
  --background:#0A0A12; --foreground:#F5F4FB; --card:#14141F; --card-foreground:#F5F4FB;
  --popover:#1C1C2B; --popover-foreground:#F5F4FB; --primary:#7C5CFC; --primary-foreground:#0A0A12;
  --secondary:#1C1C2B; --secondary-foreground:#F5F4FB; --muted:#14141F; --muted-foreground:#A2A1B8;
  --accent:#1C1C2B; --accent-foreground:#F5F4FB; --destructive:#FB4E5A; --destructive-foreground:#0A0A12;
  --border:#262635; --input:#3A3A52; --ring:#7C5CFC;
  --chart-1:#7C5CFC; --chart-2:#22D3EE; --chart-3:#FF5DA2; --chart-4:#34D399; --chart-5:#FBBF24;
}

/* ── Map shadcn vars into Tailwind theme namespace (inline = live var() ref → dark works) ── */
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1); --color-chart-2: var(--chart-2); --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4); --color-chart-5: var(--chart-5);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);

  /* ⚠ Fonts go in @theme inline ONLY as LITERAL family names (var() would resolve at build time → break).
     The next/font runtime vars are referenced indirectly: list the literal Geist/Inter family + the next/font var as a fallback chain is NOT used here — we point straight at the font's known family name. */
  --font-sans:    var(--font-sans-runtime, "Inter"), ui-sans-serif, system-ui, sans-serif;
  --font-display: var(--font-display-runtime, "Space Grotesk"), ui-sans-serif, system-ui, sans-serif;
  --font-mono:    var(--font-mono-runtime, "JetBrains Mono"), ui-monospace, monospace;
}
```

> **Font landmine note (see §5):** the safest pattern is to keep the font mappings in a **plain `@theme`** block (not `@theme inline`) so `var(--font-display)` resolves at *runtime* against the next/font className on `<html>`. If you must keep them in `@theme inline`, use **literal family names** (`"Space Grotesk"`, `"Inter"`, `"JetBrains Mono"`) — those families exist because next/font self-hosts them, and the className on `<html>` sets `font-family` anyway. Verify fonts render after init; do not ship the self-referential `--font-sans: var(--font-sans)` form.

```css
/* ── Brand tokens (plain @theme → generate bg-brand / text-cyan / etc., runtime-safe) ── */
@theme {
  --color-bg: #0A0A12;
  --color-bg-subtle: #0E0E18;
  --color-surface: #14141F;
  --color-surface-2: #1C1C2B;
  --color-surface-3: #262638;
  --color-line: #262635;
  --color-line-strong: #3A3A52;

  --color-brand: #7C5CFC;
  --color-brand-strong: #6A45F0;
  --color-cyan: #22D3EE;
  --color-pink: #FF5DA2;

  --color-live: #FF3B6B;
  --color-success: #34D399;
  --color-warning: #FBBF24;
  --color-danger: #FB4E5A;

  --color-ink: #F5F4FB;
  --color-ink-muted: #A2A1B8;
  --color-ink-faint: #6A6982;
}

/* gradients + ambient (defined in §1.2) live here too */
:root {
  --gradient-brand: linear-gradient(115deg,#7C5CFC 0%,#C247E6 46%,#FF5DA2 78%,#22D3EE 100%);
  --gradient-brand-quiet: linear-gradient(120deg,#7C5CFC 0%,#6A45F0 100%);
  --gradient-live: linear-gradient(120deg,#22D3EE 0%,#7C5CFC 100%);
  --shadow-glow: 0 0 0 1px rgba(124,92,252,.35), 0 10px 40px -10px rgba(124,92,252,.5);
  --shadow-live: 0 0 0 1px rgba(255,59,107,.35), 0 0 32px -6px rgba(255,59,107,.45);
}

@layer base {
  * { @apply border-border; }
  html { color-scheme: dark; }
  body { @apply bg-bg text-ink font-sans antialiased; }
  ::selection { background: rgba(124,92,252,.30); color: #fff; }  /* unified with brand (old teal mismatch fixed) */
  :focus-visible { @apply outline-none ring-2 ring-brand ring-offset-2; --tw-ring-offset-color: var(--color-bg); }
}

/* keep §1.2 utilities: .text-aurora, .aurora-bg, keyframes, reduced-motion guard */
```

This deletes every old throwaway class (`.glass`, `.bg-grid`, `.mask-fade`, `.glow-accent`, `.text-gradient*`, `.pulse-dot`/`pulse-ring`, `.animate-float*`, `.kicker`). Their replacements are components (§3) or the utilities above.

---

## 2. SITEMAP & PER-PAGE PLAN

**Truthful-copy law (applies to ALL marketing pages — from the Product-Truth audit):**
1. **FOUR platforms, never five.** Twitch · YouTube · Kick · TikTok. (Facebook dropped.)
2. **Kill "$2/hr, no subscription, credits never expire."** Real model = **token-based, two-tier**, and **billing is currently OFF** (`SLIMCAST_BILLING_ACTIVE` default off). Lead with **"Free during early access"** + a transparent preview of the real token pricing.
3. **Real pricing language:** 1 token = $2 = ~1 hr of *base* (single) transcode. Multi-platform burns ~1.5 tok/hr ≈ **$3/hr**. **$20/mo subscription** tier exists (15 tokens/mo, roll over capped at 30, half-price passthrough). **2 free tokens** on signup (not "2 free hours"). Stream auto-stops at zero with a 30-min warning.
4. **2K/1440p is a paid add-on**, 1080p60 is the standard (not the ceiling). Surface the **quality auto-adjust / budget throttle** and **Twitch HEVC eRTMP passthrough** as differentiators.
5. **Per-second** → say "metered while you stream, torn down on Stop — no idle billing."

**Chrome refactor:** lift `SiteNav` + `SiteFooter` into a marketing **route-group layout** `app/(marketing)/layout.tsx` (today every page mounts them individually). Move `/`, `/features`, `/pricing`, `/faq` into `app/(marketing)/`. Auth/dashboard stay outside the group.

**Fix the broken nav anchors (audit §B):** drop the dead `/#compare` item and the vestigial `Cell()/Cross()` code; repoint "FAQ" to the real `/faq` page. New `LINKS`: `How it works /#how` · `Features /features` · `Pricing /pricing` · `FAQ /faq`. Preserve landing anchors `#how` and `#trust`.

---

### 2.1 Landing — `app/(marketing)/page.tsx` (`/`)
**Server component.** No data. Inherits root metadata (add an `opengraph-image.tsx` — see §3/§5).

**Structure / bold treatment:**
1. **Hero** (`aurora-bg`): live status pill (broadcast `LiveDot` + "Streaming infrastructure for creators"). H1 = `display-hero`: "**One stream up.** <span class=text-aurora>Four platforms live.</span>" Subhead: one HEVC feed → Twitch, YouTube, Kick, TikTok — "no second PC, no config files, no terminal." CTAs: primary `Button` → `/signup` "**Start free — 2 free tokens**" (brand fill + `shadow-glow`); ghost `Button` `<a href="#how">` "See how it works". Microcopy: "Free during early access · account verification required." **Platform marquee** strip (4 logos, subtle auto-scroll). **Hero image slot preserved:** `next/image src="/dashboard-preview.jpg"` 1920×1080 `priority`, in a tilted glass-free `surface` frame with a soft aurora halo + a floating "LIVE" overlay chip.
2. **How it works** (`id="how"`): kicker "Setup" · H2 "Live in four steps." 4 `StepCard`s (01 Paste stream keys · 02 Install the OBS plugin · 03 Hit Start Streaming (~45s GPU spin-up) · 04 Stop when done — torn down instantly, no idle billing). Big aurora ghost numbers. **Preserve `#how`** (nav + footer + hero target).
3. **Core flow** band: kicker "Under the hood" · H2 "A broadcast GPU that only exists while you're live." 3-node flow OBS → SlimCast GPU (NVENC) → 4 platforms, rebuilt as glowing connected nodes (center node featured with `shadow-glow`).
4. **Features grid** (`max-w-6xl`): 6 `FeatureCard`s — HEVC uplink (≈40% less upstream) · Cloud GPU transcode (NVENC/NVDEC) · **Four platforms at once** · Per-platform tuning · **Quality auto-adjust, never face-plants** (new, truthful) · **Twitch HEVC passthrough if eligible** (new). 3-col.
5. **Trust / tech** (`id="trust"`): kicker "Enterprise-grade" · checklist (NVENC p7/hq, supervisor auto-reconnect + `onfail=ignore`, AES-256-GCM encrypted keys, SRT loopback preserves temporal HEVC). 2×2 `StatTile` grid: `1080p60` (standard, 2K add-on available) · `~45s` (cold start) · `4` (platforms) · `0` (idle-billing) — numbers in `.text-aurora` mono with count-up. **Second image slot preserved:** `next/image src="/obs-plugin-preview.jpg"` 1200×900 (hidden on mobile). **Preserve `#trust`** (footer target).
6. **Pricing teaser:** honest one-liner — "Free while we're in early access. When billing turns on: pay-as-you-go tokens or $20/mo." → `Button` `/pricing`.
7. **Final CTA** (`aurora-bg`): H2 `.text-aurora` "Go live everywhere tonight." Body: "Two free tokens are waiting." `Button` → `/signup` "Create your account".

**PRESERVED DATA CONTRACT:** none (static). Keep both `<Image>` slots (`/dashboard-preview.jpg`, `/obs-plugin-preview.jpg`), anchors `#how` + `#trust`, both `/signup` CTAs.

---

### 2.2 Features — `app/(marketing)/features/page.tsx` (`/features`)
**Server component.** Keep `export const metadata` (update copy: four platforms, token model, add throttle + eRTMP + 2K). No images.

**Structure:** hero (kicker "Features" · H1 "Everything you need to **stream everywhere**" aurora span) → **6 alternating two-column sections** rebuilt as `FeatureSplit` (left prose + right `surface` card w/ `Check` bullet list), zig-zag preserved but with aurora edge-glow on every other card. The six themes (copy corrected): **Uplink** (one HEVC feed, ≈40% less upstream) · **Transcode** (on-demand cloud GPU) · **Fan-out** (four platforms, each its own rules) · **Reliability** (auto-reconnect **+ quality auto-adjust** — add the throttle story) · **Billing** (token model: "Pay for the seconds you stream — tokens scale with platforms & quality; **2 free tokens** to start; **purchased tokens never expire**; $20/mo subscription option") · **Security** (encrypted keys). Add a 7th optional split or a callout: **Twitch HEVC eRTMP passthrough**. CTA band → `/signup` "Start free".

**PRESERVED DATA CONTRACT:** none (static). Keep `/features` route + metadata export + `/signup` CTA.

---

### 2.3 Pricing — `app/(marketing)/pricing/page.tsx` (`/pricing`)
**Server component.** Keep `export const metadata` — **rewrite** away from "$2/hour. No subscription."

**Structure (rebuilt around the REAL two-tier token model + early-access banner):**
1. **Early-access banner** (top, `surface-2` + cyan border): "**Free during early access.** Billing is off right now — stream all four platforms on the house. Here's what pricing will look like when it switches on:"
2. **Two `PricingCard`s side by side:**
   - **Pay-as-you-go** — "Tokens, $2 each." "1 token = ~1 hour of base (single-platform) transcode. Multi-platform streams use ~1.5 tokens/hr (~$3/hr). You only pay while you're live." `Badge` "2 free tokens on signup". `Button` → `/signup`.
   - **Subscription — $20/mo** (`shadow-glow`, "Best for regulars" `Badge`): "15 tokens/month, roll over up to 30. Half-price passthrough (0.05 vs 0.10 tok/hr). ≈10 hrs/mo of full multistream included." `Button` → `/signup`.
3. **What's included** (`INCLUDED`, corrected): all **four** platforms · 1080p60 standard (**2K/1440p add-on**) · HEVC uplink · cloud GPU transcode · per-platform tuning · auto-reconnect + quality auto-adjust · auto-launch / no idle billing · optional auto-refill · **purchased tokens never expire** (scope honestly — subscription allotment rolls over, capped at 30).
4. **Cost examples** (`EXAMPLES`, recomputed on the token model, with a "billing currently free" footnote): show ranges at ~1.0–1.5 tok/hr, not flat $2/hr. e.g. "Single-platform ≈ $2/hr · full four-platform ≈ $3/hr · +2K ≈ $4/hr."
5. **Billing FAQ** (`Accordion`): How am I billed? (per-heartbeat token deduction while live) · Do tokens expire? (purchased never; subscription allotment rolls over capped) · Is there a subscription? (**yes — optional $20/mo**) · What do 2 free tokens get me? (~up to 2 hrs single-platform / ~80 min full multistream).

**PRESERVED DATA CONTRACT:** none (static). Keep `/pricing` route + metadata + both `/signup` CTAs. **All pricing numbers are content-of-record — must match `lib/billing.ts` (token=$2, base 1.0, +0.2/extra landscape, +0.2 portrait, +0.5 2K; sub 15/cap 30; passthrough 0.05 sub / 0.10 payg).**

---

### 2.4 FAQ — `app/(marketing)/faq/page.tsx` (`/faq`)
**Server component.** **ADD** `export const metadata` (was missing — gap). **ADD** a CTA (was missing).

**Structure:** hero (kicker "Resources" · H1 "Frequently asked") → `Accordion` of 6 (corrected): local hardware reqs · upstream bandwidth (8–10 Mbps) · key security (AES-256-GCM at rest, injected only at stream time) · **billing** (token model + 2 free tokens + free during early access — fix "$2/hr per-second, no subscription") · credit depletion (30-min warning → graceful stop) · supported endpoints (fix "RTMP distribution": **Twitch/Kick over RTMPS, YouTube over HLS HEVC passthrough, TikTok over RTMP; OBS→SlimCast ingest is SRT**; 1080p60 standard, 2K add-on, portrait for TikTok). **Add** a closing CTA card → `/signup`.

**PRESERVED DATA CONTRACT:** none (static). Keep `/faq` route (footer links to it).

---

### 2.5 Login — `app/login/page.tsx` (`/login`)
**Client component.** **Keep the `<Suspense>` wrapper** around the inner component (it reads `useSearchParams`). **Keep `safeNext()`** verbatim (open-redirect guard: accept only `startsWith('/') && !startsWith('//')`, else `/dashboard`).

**Structure / treatment:** centered **split auth layout** — left `AuthPanel` (aurora-bg brand panel: logo, tagline, a rotating "what creators ship" testimonial/feature blurb); right `Card` with the form. Fields: Email (`Input type=email required`), Password (`Input type=password required`). `Button` submit (disabled+spinner while `loading`; label "Sign in" ↔ "Signing in…"; **do NOT reset `loading` on success** — keep spinner through nav). Error → shadcn `Alert variant=destructive` (red). Footer link "No account? **Start free**" → `/signup`.

**PRESERVED DATA CONTRACT:**
- `supabase.auth.signInWithPassword({ email, password })` (via `createBrowserClient()` from `@/lib/supabase` — **cookie-backed; do not swap clients**).
- On success → `router.push(safeNext(searchParams.get('next')))`. Read `next` query param.

---

### 2.6 Signup — `app/signup/page.tsx` (`/signup`)
**Client component.** No Suspense needed (no search-param read). Same split `AuthPanel` layout.

**Structure:** `PERKS` checklist (corrected copy): "**2 free tokens** on signup" · "All **four** platforms, full 1080p60" · "Free during early access — token pricing later, **$2/token** or **$20/mo**". Fields: Email; Password (`required minLength={8}` + helper "At least 8 characters."). Submit `Button` ("Create account" ↔ "Creating account…"; don't reset `loading` on success). **Style the email-confirm notice as an `Alert variant=default/info` (cyan), NOT destructive** (the audit flags it's currently mis-styled red). Link "Already have an account? **Log in**" → `/login`.

**PRESERVED DATA CONTRACT:**
- `supabase.auth.signUp({ email, password })`.
- `error` → banner; `!data.session` → "Check your email to confirm…" (info-styled); session present → `router.push('/onboarding')`.

---

### 2.7 Onboarding — `app/onboarding/page.tsx` (`/onboarding`)
**Client component.** **No Suspense** — it intentionally reads `window.location.search` inside `useEffect` (avoids the Suspense requirement). **Keep that pattern.** Route guard: no session → `router.push('/login')`.

**Structure / treatment:** full-bleed wizard with a top `Stepper` (5 steps from `STEPS`, `i <= step` filled via brand gradient, active label glows). Each step in a centered `Card`. Steps:
- **0 Connect Platforms:** 4 platform rows (`twitch/kick/youtube/tiktok`; TikTok note "Requires LIVE access (1000+ followers)"). `Input type=password` per platform + green `Badge` "✓ Added" when filled. Primary `Button` "Continue with N platform(s)" (disabled when `saving || connectedCount===0`), Skip ghost button. (Optional polish: surface the backend's stream-key char rule — reject `| [ ] \` + whitespace — as inline hint.)
- **1 Secure Account (Stripe):** copy "valid card prevents trial abuse; you won't be charged; 2 free tokens immediately." `Button` "Add Payment Method" ↔ "Connecting to Stripe…".
- **2 Your API Key:** amber `Alert` "Copy this key now — it won't be shown again." Key in a `mono` code block; Copy `Button` (`Copy` ↔ `Copied!` 2s). "Where to paste it" steps. Continue `Button` → step 3. Loading + (recommended new) error states for 403/429.
- **3 Install Plugin:** two download `<a>` (Mac `.pkg` / Windows `.exe`, plain anchors — **keep**). "Installed — continue" + "Skip" both → step 4.
- **4 Done:** confetti/aurora celebration, summary (`✓ N platforms`, `✓ API key`), `Button` "Open Dashboard" → `/dashboard`.

**PRESERVED DATA CONTRACT:**
- `supabase.auth.getSession()` (guard + `token`).
- `setup_success==='1'` → `setStep(parseInt(searchParams.get('step') ?? '2'))` (Stripe return).
- Step 0: per filled key, **`POST /api/platforms`** `{ platform, stream_key }` (Bearer), `Promise.all`.
- Step 1: **`POST /api/stripe/setup`** (Bearer, no body) → `{ url }` → `window.location.href = url`. Stripe `success_url=/onboarding?step=2&setup_success=1`, `cancel_url=/onboarding?step=1&setup_cancel=1`.
- Step 2: **`POST /api/apikey`** (Bearer, no body) → `{ api_key }` (shown once). 403 (no payment method) / 429 (rate-limit) yield no `api_key`.
- Plugin downloads: static `/downloads/slimcast-obs-plugin.pkg` / `.exe`.

---

### 2.8 Device Link — `app/link/page.tsx` (`/link`)
**Client component.** **Keep `<Suspense>`** (reads `useSearchParams`). Consent page for the OBS PKCE flow.

**Structure / treatment:** single centered `Card` with the brand `AuthPanel` feel — big `LogoMark`, "Authorize OBS to connect to your SlimCast account", a status-driven body, one primary `Button`. Keep the static caution footer ("Only authorize if you just clicked 'Connect' in your own OBS"). Status states (`checking → ready → working → done → error`) map to: spinner / "Authorize OBS" button / "Authorizing…" / green success `Alert` / red `Alert`.

**PRESERVED DATA CONTRACT:**
- Query params: `challenge` (regex `/^[A-Za-z0-9_-]{43}$/`), `state` (passthrough), `port` (`/^\d{1,5}$/`, 1–65535). `validParams` gate verbatim.
- `supabase.auth.getSession()`; no session → `window.location.href = /login?next=${encodeURIComponent(here)}` (the **only** producer of `?next=`).
- **`POST /api/link/authorize`** (Bearer + `Content-Type: application/json`, body `{ challenge }`) → `{ code }` → redirect `http://127.0.0.1:${port}/callback?code=…&state=…`.

---

### 2.9 Dashboard Overview — `app/dashboard/page.tsx` (`/dashboard`)
**Client component.** Shared `<DashboardNav/>` chrome (rebuilt). Guard: no session → `/login`.

**Structure / treatment:** dashboard shell = sticky `DashboardNav` (tabs + sign-out + logo) over a `max-w-5xl` grid. Overview = **Balance hero card** (big aurora token number via `formatTokens`, low-balance amber state when `< 0.5` → "Less than 30 minutes remaining", `Button` "Buy tokens" → `/dashboard/credits`) + **period stat tiles** (`Tabs`/segmented control 7d/30d/All → refetch) + **Platforms card** (chips, empty-state → `/dashboard/platforms`).

**PRESERVED DATA CONTRACT:**
- **`GET /api/credits/balance`** → `tokens` → balance. `creditsLow = credits < 0.5`.
- **`GET /api/stats?period={7d|30d|all}`** → `total_duration_seconds, session_count, avg_duration_seconds, total_credits_used, top_platforms[]`. Refetch on period change.
- Direct Supabase: `supabase.from('platform_connections').select('platform').eq('user_id', session.user.id)`.
- No polling. Use `formatTokens` from `@/lib/billing`.

---

### 2.10 Stream — `app/dashboard/stream/page.tsx` (`/dashboard/stream`)
**Client component.** Thin shell: loads enabled platforms, renders `<StreamManager/>` + `<ConnectionHealthGraph/>` + (optionally) `<CostMeter/>`.

**Structure / treatment:** the live "broadcast control room." Top = `<StreamManager/>` (the hero live card — see §3 port). Below = `<ConnectionHealthGraph enabledPlatforms={…}/>` in a `surface` card. The whole page leans into the live aesthetic (live gradient accents only when actually live). **No manual GPU controls** (product rule — status only).

**PRESERVED DATA CONTRACT:**
- Page: **`GET /api/platforms`** (Bearer) → `body.platforms[].{platform,enabled}` → filter `enabled` → `enabledPlatforms` (once on mount).
- StreamManager + ConnectionHealthGraph contracts: see §3.

---

### 2.11 Platforms — `app/dashboard/platforms/page.tsx` (`/dashboard/platforms`)
**Client component, `<Suspense>`-wrapped** (reads `useSearchParams` for `connected`/`oauth_error` toasts). Guard → `/login`.

**Structure / treatment:** grid of 4 `PlatformConnectCard`s (`twitch/kick/youtube/tiktok`). Each shows: connection state `Badge` (OAuth vs manual vs disconnected), an **Active** `Switch`, an OAuth `Button` (twitch/youtube/facebook only — `OAUTH_PLATFORMS`; kick/tiktok manual-only), a manual stream-key `Input type=password` + Save, and Remove (manual-only). Toasts via shadcn `sonner`.

**PRESERVED DATA CONTRACT:**
- Direct Supabase `loadConnections`: `platform_connections.select('platform, rtmp_url, bitrate_kbps, fps, orientation, enabled, oauth_connected').eq('user_id', userId)`.
- **`GET /api/oauth/status`** → `connected` map.
- **`GET /api/oauth/{id}/authorize`** → `{ url }` → redirect (start OAuth).
- **`DELETE /api/oauth/{id}`** → disconnect → refetch connections + status.
- **`POST /api/platforms`** `{ platform, stream_key }` (save manual key) → refetch.
- **`DELETE /api/platforms/{id}`** (remove manual).
- **`PATCH /api/platforms/{id}`** `{ enabled }` (toggle active, optimistic).
- Query params `connected` / `oauth_error` → toast. No polling.

---

### 2.12 Credits — `app/dashboard/credits/page.tsx` (`/dashboard/credits`)
**Client component, `<Suspense>`-wrapped** (reads `success`/`subscribed` → banners + refetch). Guard → `/login`. **The most endpoint-dense dashboard page.**

**Structure / treatment:** sections as cards — **Balance** (spendable = `sub?.spendable_tokens ?? balance`; split allotment/purchased when `sub.allotment_tokens>0`) · **Subscription** (`SubscriptionState`: subscribe / manage / cancel / reactivate; honest copy: "$20/mo · 15 tokens, roll over to 30") · **Buy tokens** (slider 1–100, `totalCost = $${(buyTokens*2).toFixed(2)}`) · **Auto-refill** (`Switch` + amount slider, commit on release) · **Achievements** (badge grid vs `ACHIEVEMENTS`) · **Stream history** (last 20 sessions table). Success/subscribed banners via `Alert`.

**PRESERVED DATA CONTRACT (all consumed exactly as audited):**
- **`GET /api/credits/balance`** → `tokens`.
- **`GET /api/credits/auto-refill`** → `enabled, hours, has_payment_method, card{brand,last4}`.
- **`GET /api/subscription`** → `plan, subscription_status, current_period_end, cancel_at_period_end, allotment_tokens, purchased_tokens, spendable_tokens, monthly_allotment, allotment_cap`.
- Direct Supabase: `stream_sessions.select('*').order('started_at',desc).limit(20)`; `achievements.select('achievement_key')`.
- **`POST /api/credits/checkout`** `{ hours: buyTokens }` → `{ url }` redirect.
- **`PATCH /api/credits/auto-refill`** `{ enabled? , hours? }` → handles `no_payment_method`.
- **`POST /api/stripe/portal`** → `{ url }` redirect.
- **`POST /api/subscription/checkout`** → `{ url }`; 503/`subscription_not_configured`, 409/`already_subscribed`.
- **`POST /api/subscription`** `{ action: 'portal'|'cancel'|'reactivate' }`.
- Refetch on `success==='1'` / `subscribed==='1'`. No polling. Token→USD is **×2**.

---

### 2.13 Settings — `app/dashboard/settings/page.tsx` (`/dashboard/settings`)
**Client component** (not Suspense-wrapped). Guard → `/login`. Embeds `<PortraitCropEditor/>` + inline `OBSConnectionSection`.

**Structure / treatment:** per-platform output `Card`s (ordered `twitch,kick,youtube,tiktok`): enable `Switch`, resolution segmented control (720p/1080p/1440p — **1440p locked when `twitch` or `!has2kAddon`**), bitrate `Input` (clamped to platform min/max, commit on blur/Enter), orientation toggle (youtube/tiktok), Twitch HEVC passthrough `Switch` (only when `twitch_hevc_eligible`) + "Re-check" button. **Cost summary card** from `/api/pricing` (line items + total tok/hr + $/hr). Collapsible **Vertical framing** (`PortraitCropEditor`, lazily mounted) + **OBS connection** (`OBSConnectionSection`). Hide resolution/bitrate when `isPassthrough`.

**PRESERVED DATA CONTRACT:**
- Direct Supabase: `platform_connections.select('platform, orientation, enabled, twitch_hevc_eligible, twitch_use_passthrough, twitch_max_height').order('platform')`.
- **`GET /api/output-settings`** → `output_settings, has_2k_addon`.
- **`GET /api/pricing`** → `line_items[], total_tokens_per_hr, total_dollars_per_hr, credits, estimated_seconds_remaining, has_2k_addon` (re-fetched after most mutations via `loadPricing`).
- **`PATCH /api/platforms/{id}`**: `{enabled}` | `{orientation}` | `{twitch_use_passthrough}` (path `/api/platforms/twitch`) | `{recheck_eligibility:true}` → `{hevcEligible, maxHeight}`.
- **`PATCH /api/output-settings`**: `{[id]:{resolution}}` | `{[id]:{bitrate_kbps}}`.
- `<PortraitCropEditor/>` + `OBSConnectionSection` contracts: see §3.

---

## 3. COMPONENT INVENTORY

### 3.1 shadcn components to install
```bash
npx shadcn@latest init           # interactive: style=new-york, base=radix, baseColor=neutral, css=app/globals.css
npx shadcn@latest add button card badge input label switch slider tabs \
  accordion dialog sheet dropdown-menu select tooltip separator \
  sonner skeleton progress alert avatar scroll-area navigation-menu
```
- **`button`** — every CTA / action (variants: default=brand fill, secondary, ghost, outline, destructive; add a custom `gradient` variant via `cn` for hero primary).
- **`card`** — all surface panels (marketing feature/step/stat, every dashboard section).
- **`badge`** — platform chips, "Connected via OAuth", "2 free tokens", live/status pills.
- **`input` / `label`** — auth forms, stream keys, bitrate, onboarding.
- **`switch`** — Active toggle (platforms/settings), auto-refill, Twitch passthrough.
- **`slider`** — buy-tokens (1–100), auto-refill amount, portrait zoom (1–3).
- **`tabs`** — Overview period selector (7d/30d/all); could host dashboard nav.
- **`accordion`** — pricing + FAQ Q&A (replaces `details/summary`).
- **`dialog`** — API-key reveal confirm, destructive confirms.
- **`sheet`** — mobile nav drawer (replaces hamburger menu).
- **`dropdown-menu`** — account/sign-out menu (optional).
- **`select`** — ConnectionHealthGraph series picker (replaces raw `<select>`), orientation/resolution where helpful.
- **`tooltip`** — burn-rate, eligibility, throttle explainers.
- **`separator`**, **`scroll-area`**, **`skeleton`** (loading states), **`progress`** (onboarding stepper backbone), **`alert`** (errors / confirm-email / banners), **`avatar`**, **`navigation-menu`** (desktop marketing nav), **`sonner`** (toasts on Platforms/Credits).

### 3.2 Custom components to build (new)
| Component | File | Purpose |
|---|---|---|
| `Logo` / `LogoMark` | `components/logo.tsx` | **Keep both export signatures + `href={null}` variant** (footer/onboarding rely on it). Redesign the SVG mark (aurora-fillable broadcast glyph) but preserve API + "SlimCast" wordmark. |
| `SiteNav` | `components/site-nav.tsx` | **Client.** Sticky `backdrop-blur-xl bg-bg/80`. Preserve Supabase auth-state swap + mobile menu (now a `Sheet`). New `LINKS` (drop `/#compare`, FAQ→`/faq`). |
| `SiteFooter` | `components/site-footer.tsx` | Server. Preserve 8 links + dynamic year + `Logo href={null}`. Replace `pulse-dot` with `LiveDot`. Fix tagline (drop "$2/hr · no subscription" → "Free during early access"). |
| `Kicker` | `components/ui/kicker.tsx` | Replaces `.kicker` — mono uppercase tracked eyebrow, brand/cyan, optional `▍` bar. |
| `GradientText` | `components/ui/gradient-text.tsx` | Wraps `.text-aurora`. |
| `AuroraBackground` | `components/ui/aurora-background.tsx` | Wraps `.aurora-bg` (hero + final CTA). |
| `LiveDot` / `PingDot` | `components/ui/live-dot.tsx` | Broadcast pulse (nav badge, footer, stream tiles). Color-prop. |
| `StatTile` | marketing | aurora number + count-up + label. |
| `FeatureCard` / `FeatureSplit` | marketing | landing 3-col + features zig-zag. |
| `StepCard` | marketing | numbered ghost-number step. |
| `PricingCard` | marketing | two-tier token cards. |
| `PlatformIcon` / `PlatformBadge` | shared | Twitch/Kick/YouTube/TikTok marks + status dot (uses the preserved status hexes). |
| `AuthPanel` | auth | shared split-screen brand panel (login/signup/link). |
| `Stepper` | onboarding | 5-step progress (built on `progress`/custom). |
| `DashboardNav` | `components/dashboard-nav.tsx` | **Client.** Preserve 5 tabs (`usePathname` active), sign-out (`supabase.auth.signOut()` → `/`), `Logo href="/"`. |

### 3.3 Interactive components to PORT (re-skin, preserve ALL wiring)
These keep their logic byte-for-byte; only Tailwind classes change to the new tokens. **The load-bearing constants/contracts below are non-negotiable.**

1. **`components/stream-manager.tsx` (`StreamManager`)** — re-skin only.
   - Preserve helpers exactly: `formatLocation` (regex `/([A-Za-z .'-]+,\s*[A-Z]{2})\s*$/`), `streamPhase` (5-branch order), `pollMs` (provisioning/connecting **2000** · waiting **3000** · else **5000**), `platformStateMap`, `fmtElapsed`, `PLATFORM_ORDER`, `PLATFORM_LABELS`.
   - **`GET /api/gpu/status`** (Bearer) self-rescheduling poll (clear+set each tick) + 1s elapsed ticker; `liveStartRef` edge logic. Consumed: `status, streaming, burn_rate, credits, outputs[{name,state,mode,platforms,restarts}], datacenter, gpu_type, confirm_required, confirm_deadline, hls_available`.
   - Token→USD **×2**; `lowCredits = remaining<1800 && streaming`; `secondsRemaining` from `@/lib/billing`.
   - **`HlsPlayer`**: `import('hls.js')`; source **`/api/gpu/hls/index.m3u8?token=${enc(authToken)}`** with **triple auth** (`xhrSetup` + `fetchSetup` bearer + `?token=`); 4000ms fatal-retry. Keep verbatim.
   - `PlatformTile` dot colors `#37d67a/#ffb020/#ff5470/#555e6e`; `PingDot` `#fbbf24/#f87171/#37d67a`. Keep. New skin = wrap in `Card`, use brand glow for live state.

2. **`components/cost-meter.tsx` (`CostMeter`)** — re-skin only.
   - **`GET /api/gpu/status`** fixed **5000ms** poll. `live = status==='running' && burn_rate>0`; renders `null` otherwise. Token→USD **×2**; `lowRemaining = remaining<1800`. `formatDuration` from `@/lib/billing`.

3. **`components/ConnectionHealthGraph.tsx`** — re-skin (recharts stays).
   - `enabledPlatforms?` prop filtered against `['twitch','kick','youtube','tiktok']`.
   - **`GET /api/metrics/connection?direction=inbound&window=60`** (inbound) / **`?direction=outbound&platform=<key>&window=60`** (per-platform), Bearer, **5000ms** poll restarted on `selectedKey` change (reset `points=[]`).
   - recharts: only `health` line plotted; YAxis fixed `[0,100]`; colors `LINE_COLOR=#3b82f6`, `healthColor` thresholds (≥80 `#10b981` / ≥50 `#f59e0b` / else `#f43f5e` / null `#475569`). Keep `CustomTooltip`. Swap raw `<select>` → shadcn `Select` (same value semantics).

4. **`components/portrait-crop-editor.tsx`** — re-skin (raw pointer events stay).
   - **Geometry must stay byte-aligned with `relay/supervisor.py:portrait_crop_rect`:** `CROP_W_AT_ZOOM_1 = (9/16)*(9/16)`, `cropFractions`, center-follows-pointer back-solve, `clamp01`.
   - **`GET /api/portrait-crop`** → `{zoom,pos_x,pos_y}`; **`PATCH /api/portrait-crop`** body `{zoom,pos_x,pos_y}` **on release only** (pointer-up / slider mouseup+touchend / reset) — never on every `onChange` (avoid PATCH spam). 1500ms "Saved ✓".

5. **`OBSConnectionSection`** (inline in settings) — **`POST /api/apikey`** (Bearer) behind `window.confirm`; `api_key` shown once; copy via `navigator.clipboard`.

### 3.4 Shared lib (unchanged, keep importing)
`@/lib/supabase` (`createBrowserClient()` — **cookie-backed singleton; do not replace**), `@/lib/billing` (`formatTokens`, `formatDuration`, `secondsRemaining`), new `@/lib/utils` (`cn` — created by shadcn init).

---

## 4. BUILD PARTITION (parallel-safe batches)

> Rule: batches touch disjoint file sets. Batch 0 must land first (everyone imports its tokens/chrome). Batches 1–3 are then fully parallel.

### Batch 0 — FOUNDATION (blocks everything; do first, single owner)
**Files:**
- `npx shadcn@latest init` → creates `components.json`, `lib/utils.ts`, augments `package.json`; **review + re-merge** the `app/globals.css` diff (see §5).
- `app/globals.css` — the full §1.5 token system (replace wholesale, then merge shadcn's `:root`/`@theme inline`).
- `app/layout.tsx` — Space Grotesk + Inter + JetBrains Mono via next/font; `<html className="dark …variables">`; preserve **all** metadata (`metadataBase`, title template `"%s · SlimCast"`, description, keywords, OpenGraph, Twitter `summary_large_image`), `<Analytics/>` + `<SpeedInsights/>`, flex-col body.
- `app/opengraph-image.tsx` (+ optional `app/twitter-image.tsx`) — fill the declared-but-missing OG image (`next/og` `ImageResponse`, flexbox only).
- `components/logo.tsx` (redesigned mark, **same export API**).
- `components/site-nav.tsx`, `components/site-footer.tsx` (shared chrome, fixed links).
- `components/dashboard-nav.tsx` (shared dashboard chrome).
- `components/ui/*` from shadcn add (button, card, badge, input, label, switch, slider, tabs, accordion, dialog, sheet, select, tooltip, separator, sonner, skeleton, progress, alert, avatar, scroll-area, navigation-menu).
- `components/ui/kicker.tsx`, `gradient-text.tsx`, `aurora-background.tsx`, `live-dot.tsx`, `components/platform-icon.tsx`.
- `app/(marketing)/layout.tsx` — route-group chrome wrapper (mounts SiteNav/SiteFooter once).

**Depends on:** nothing.
**Gate:** `npx tsc --noEmit` green; fonts render (font landmine check); `bg-primary`/`text-foreground` and `bg-brand`/`text-cyan` both generate; `class="dark"` present.

### Batch 1 — MARKETING (parallel; depends on Batch 0 chrome + tokens + Kicker/GradientText/Aurora/StatTile)
**Files:**
- `app/(marketing)/page.tsx` (landing) + marketing-only components `components/marketing/{stat-tile,feature-card,feature-split,step-card,pricing-card,platform-marquee}.tsx`.
- `app/(marketing)/features/page.tsx` (keep `metadata`).
- `app/(marketing)/pricing/page.tsx` (keep + rewrite `metadata`; two-tier token cards).
- `app/(marketing)/faq/page.tsx` (**add** `metadata` + CTA).
**Truthful-copy law (§2) applies.** Preserve `#how`/`#trust` anchors, both image slots, all `/signup` CTAs.
**Depends on:** Batch 0 (`SiteNav/SiteFooter/Logo`, tokens, `Kicker/GradientText/AuroraBackground/StatTile`, marketing layout).

### Batch 2 — AUTH (parallel; depends on Batch 0 tokens + Logo + `Card/Input/Button/Alert` + `AuthPanel`)
**Files:**
- `components/auth/auth-panel.tsx` (shared split brand panel).
- `app/login/page.tsx` (**keep Suspense + `safeNext`**).
- `app/signup/page.tsx` (info-style confirm notice; 4-platform + token copy).
- `app/onboarding/page.tsx` (**keep `window.location.search` pattern**; `Stepper`).
- `app/link/page.tsx` (**keep Suspense + PKCE param validation + `?next=` round-trip**).
- `components/onboarding/stepper.tsx`.
**Depends on:** Batch 0. **No file overlap with Batch 1/3.** Reuses `@/lib/supabase` unchanged.

### Batch 3 — DASHBOARD (parallel; depends on Batch 0 `DashboardNav` + tokens + `Card/Tabs/Switch/Slider/Select/Alert/sonner`)
**Files:**
- `app/dashboard/page.tsx` (overview).
- `app/dashboard/stream/page.tsx`.
- `app/dashboard/platforms/page.tsx` (**keep Suspense**).
- `app/dashboard/credits/page.tsx` (**keep Suspense**).
- `app/dashboard/settings/page.tsx`.
- **Ported interactive (re-skin only):** `components/stream-manager.tsx`, `components/cost-meter.tsx`, `components/ConnectionHealthGraph.tsx`, `components/portrait-crop-editor.tsx`.
- Dashboard sub-components `components/dashboard/{balance-card,stat-tile,platform-connect-card,subscription-card,session-history,achievement-grid}.tsx`.
**Depends on:** Batch 0 (`DashboardNav`, tokens, shadcn primitives), `@/lib/billing`, `@/lib/supabase`. **All API contracts in §2.9–2.13 + §3.3 preserved.**

> **Conflict-free guarantee:** Batch 1 = `app/(marketing)/**` + `components/marketing/**`; Batch 2 = `app/{login,signup,onboarding,link}/**` + `components/{auth,onboarding}/**`; Batch 3 = `app/dashboard/**` + the four ported components + `components/dashboard/**`. The only shared files (`globals.css`, `layout.tsx`, chrome, `components/ui/**`) all live in Batch 0 and are frozen before 1–3 start.

---

## 5. RISKS & NOTES

### Next.js 16 gotchas
- **`params`/`searchParams` are Promises** in Server Components — but all rebuilt pages reading params are **Client Components** using `useSearchParams()` (login, link, platforms, credits) or `window.location.search` (onboarding), so this doesn't bite them. If any new server page reads params, `await` them.
- **Suspense is mandatory** around `useSearchParams()` — **keep the existing `<Suspense>` wrappers on `/login`, `/link`, `/dashboard/platforms`, `/dashboard/credits`.** Onboarding deliberately avoids Suspense via `window.location.search` in an effect — **don't "fix" it into `useSearchParams`** or you must add a boundary.
- **Metadata exports are Server-Component-only.** All four auth pages + all five dashboard pages are `'use client'` and **cannot** export `metadata`. Marketing pages (`/features`, `/pricing`, `/faq`, landing) are server — add/keep metadata there. Add the missing `/faq` metadata + the root `opengraph-image.tsx`.
- **`next/image` Next-16 defaults:** `images.qualities` now `[75]` only; `minimumCacheTTL` 4h; local `src` with query string needs `images.localPatterns`. The two preview JPGs are local static with no query → fine. If you add remote screenshots, configure `images.remotePatterns` (not the deprecated `images.domains`).
- **Turbopack is default** for dev+build; don't add a custom `webpack` config (fails build). Scripts are already flag-free.
- **`next lint` is gone** — `next build` won't lint. Pre-push gate stays `npx tsc --noEmit` + `npm run lint` (eslint) + `npx tsx scripts/test-billing.ts`.
- **Auth gate is `proxy.ts`** (renamed middleware) — unchanged by this rebuild, but it depends on **cookie-backed** sessions. Do not introduce a non-cookie Supabase client anywhere.
- **`scroll-behavior: smooth`** no longer auto-applies on nav — add `data-scroll-behavior="smooth"` to `<html>` if you want smooth anchor jumps to `#how`/`#trust`.

### shadcn + Tailwind v4 integration
- **`globals.css` rewrite is the destructive init step.** Run `npx shadcn@latest init`, then **diff and re-merge** — preserve the §1.5 brand `@theme`, gradients, aurora utilities, base layer. Don't accept a blind overwrite.
- **`--color-accent` collision (the big one):** shadcn's `accent` token is a *muted surface*, NOT a brand color. The old code used `bg-accent`/`text-accent` to mean emerald brand. In the new system, **brand is `--color-brand` (`bg-brand`/`text-brand`)** and shadcn's `--color-accent` stays a surface. Audit every `bg-accent`/`text-accent` usage during the port and repoint to `bg-brand`/`text-brand` (or `bg-cyan`). Same care for `--color-ring`/`--color-border` overlaps. **This is the #1 silent-restyle risk.**
- **Font landmine:** keep next/font mappings runtime-resolvable. Safest = put `--font-display/--font-sans/--font-mono` in a **plain `@theme`** block referencing the next/font CSS vars on `<html>`; if they land in `@theme inline`, use **literal family names** ("Space Grotesk"/"Inter"/"JetBrains Mono"), never `var(--font-display)`. Verify headings render in Space Grotesk after init.
- **Dark mode:** shadcn `.dark` overrides only apply with `class="dark"` on `<html>` — **add it** (also keep `color-scheme: dark`). App is dark-only; `:root` and `.dark` carry the same palette.
- **React 19 peer deps:** init under the unified `radix-ui` base usually installs clean. If npm throws `ERESOLVE` on a later `add`, use `--legacy-peer-deps` (preferred) over `--force`.
- **`tw-animate-css`** replaces the old `tailwindcss-animate` plugin (no plugin entry needed in v4).

### Data-contract tripwires (anything here breaks the backend)
- **Token→USD is hard-coded ×2** in `StreamManager` header + `CostMeter`. Don't "centralize" it away incorrectly. 1 token = $2.
- **Low-credit threshold = `remaining < 1800` (30 min)** — preserve in StreamManager (`lowCredits`, also gated on `streaming`) and CostMeter (`lowRemaining`).
- **HLS triple-auth** (`xhrSetup` + `fetchSetup` bearer + `?token=` query on `/api/gpu/hls/index.m3u8`) — drop any one and preview/segments 401.
- **StreamManager poll self-reschedules** (clear+set each tick at `pollMs(phase)`); **CostMeter/ConnectionHealthGraph use fixed 5s.** A naive `setInterval` refactor leaks timers or breaks adaptivity.
- **PortraitCropEditor geometry** must stay byte-aligned with `relay/supervisor.py:portrait_crop_rect` (`CROP_W_AT_ZOOM_1`, `cropFractions`, center-follow back-solve) — a "cleaner" math refactor desyncs the preview from the real GPU crop. **Save on release only.**
- **`safeNext()` open-redirect guard** (login) + the `?next=` round-trip (link is the sole producer) — preserve verbatim.
- **`loading` not reset on success** in login/signup — keep the spinner through navigation (avoids a flash).
- **All POST/PATCH bodies are exact:** `/api/platforms {platform,stream_key}|{enabled}|{orientation}|{twitch_use_passthrough}|{recheck_eligibility}`, `/api/output-settings {[id]:{resolution|bitrate_kbps}}`, `/api/credits/checkout {hours}`, `/api/credits/auto-refill {enabled?,hours?}`, `/api/subscription {action}`, `/api/portrait-crop {zoom,pos_x,pos_y}`. Don't rename keys.
- **Direct Supabase reads are part of the contract** (RLS-gated): `platform_connections` (3 different column sets across overview/platforms/settings), `stream_sessions`, `achievements`. Reproduce the exact `.select()` column lists.
- **Stream-key char allowlist** (backend rejects `| [ ] \` + whitespace via `/[|\[\]\\\s]/`) — optionally surface client-side, but the backend enforces it regardless.
- **`/api/apikey` preconditions:** 429 (rate limit) / 403 (no payment method) return no `api_key`. The old onboarding silently shows nothing — the rebuild **should** add an error surface (improvement, not a contract break).

### Copy-truth tripwires (don't reintroduce false claims)
- Never write "five platforms / 5" (it's **four**), "$2/hour flat", "no subscription" (a **$20/mo** tier exists), "credits never expire" unqualified (subscription allotment rolls over **capped at 30**), or "2 free hours" (it's **2 free tokens**). 1080p60 is the **standard**, not the ceiling (2K add-on exists). Lead with **"free during early access"** since `SLIMCAST_BILLING_ACTIVE` is OFF. All pricing numbers must trace to `lib/billing.ts`.
