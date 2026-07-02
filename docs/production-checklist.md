# SlimCast — Production Checklist

Pre-production cutover steps. Nothing here is required during dev (everything is gated
OFF), but each must be done before real users / real money. Grouped by area; check off as
done. Last updated 2026-07-02.

> **Already shipped (fableroadmap Phase A + pre-billing hardening, 2026-07-02)** — no cutover
> action needed, listed so you don't re-do them:
> - **Security lockdown applied to prod** (`…deny_by_default`): deny-by-default on schema public
>   closed the credit-mint RPC hole + eligibility-forge + secret-leak (Mgmt-API-verified).
> - **web-ci is a REQUIRED status check** on `main` (tsc + billing/provider tests + migration
>   replay). `enforce_admins=false` (admins still direct-push); flip strict when ready.
> - **Observability live** — `SENTRY_DSN` is set; errors + webhook money-drops report to Sentry.
> - **Billing correctness** — deduction is idempotent (`bill_stream_interval` CAS cursor) with a
>   `usage_events` ledger; auto-refill `>=` edge fixed; webhook amount cross-check + Stripe event
>   idempotency (`stripe_events`) in place. Still inert until the master switch below.
> - **Relay** — fail-static reconciliation, `-rw_timeout` on ffmpeg legs, bridge auth fail-closed.

> **Env-var note:** `vercel env pull` in this workspace returns empty values for *every*
> key (even known-good ones), so you can only confirm whether a key *exists*, not its value.
> Verify values in the Vercel dashboard, not via pull.

---

## 1. Billing activation (Phase 3) — **TURN BILLING ON**

Billing is fully built + migrations applied to prod, but it is **deactivated** until these
are done. See `memory/phase3_billing_model.md` and CLAUDE.md "Business model".

- [ ] **Turn billing on:** set `SLIMCAST_BILLING_ACTIVE=true` in Vercel (production), then
      redeploy. Currently **unset** (= OFF). This is the master switch — it gates credit
      deduction, the credits≤0 self-destruct, auto-refill, and the provision payment gate.
      (Idle / max-session / orphan safety run regardless.)
- [ ] **Create the Stripe subscription price:** run `cd web && STRIPE_SECRET_KEY=sk_live_…
      node scripts/setup-stripe.mjs` against the **live** Stripe account. It prints a
      subscription price id + a token/hourly price id.
- [ ] Set `STRIPE_PRICE_SUBSCRIPTION` in Vercel to the printed subscription price id.
      Currently **unset** → `/api/subscription/checkout` returns 503 until set (the PAYG
      token purchase still works via `STRIPE_PRICE_HOURLY`).
- [ ] (Optional) override the price points if you don't want the defaults
      ($20/mo, 15 tokens, cap 30, $2/token): `SLIMCAST_SUB_PRICE_CENTS`,
      `SLIMCAST_SUB_ALLOTMENT_TOKENS`, `SLIMCAST_SUB_ALLOTMENT_CAP`, `SLIMCAST_TOKEN_PRICE_CENTS`
      — these must match the Stripe prices you actually created.
- [ ] **Enable the subscription webhook events** on the Stripe webhook endpoint (Stripe
      Dashboard → Webhooks): `customer.subscription.created`, `customer.subscription.updated`,
      `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Without
      these, subscriptions won't flip `plan`/`status` and the monthly allotment is never
      granted. (The existing `checkout.session.completed` + `payment_intent.*` already power
      the one-time credit purchase + auto-refill.)
- [ ] **Verify the Stripe object shapes in TEST mode first.** The webhook + subscription
      routes use defensive field access for the `2026-05-27.dahlia` API (subscription
      `current_period_end`, invoice `subscription`/`billing_reason`/`customer`). Run a full
      test-mode subscribe → invoice.paid → cancel cycle and confirm `profiles.plan`,
      `subscription_status`, `subscription_current_period_end`, and `allotment_tokens` update
      correctly before going live.
- [ ] **Confirm the billing dev-bypass is clear:** `SLIMCAST_DEV_NO_BILLING_USER_ID` should
      be **blank** in prod (a non-blank UUID exempts that user from all deduction). Verify in
      the Vercel dashboard.
- [ ] After turning on, smoke-test: a PAYG account with a low balance hard-stops at 0; a
      subscriber's allotment deducts before purchased; auto-refill fires below 1 token.

## 2. Access / security — remove the private-dev gate

- [ ] **Remove the private-dev email allowlist:** delete/blank `SLIMCAST_ALLOWED_EMAILS` in
      Vercel so signups aren't restricted to the dev allowlist. Then **delete the gate code
      block** in `web/app/api/gpu/provision/route.ts` (marked "⚠️ TEMPORARY PRIVATE-DEV GATE
      — DELETE BEFORE PRODUCTION"). See `memory/prelaunch_repo_private.md`.
- [ ] Confirm `CRON_SECRET` is set (protects `/api/cron/reap` + the `/api/health` detail
      snapshot). **Now fail-CLOSED in production (2026-07-02):** if unset, both refuse in prod —
      so this is enforced, not just advisory. Set it, or the daily reaper cron won't run.
- [ ] **Validate the GPU bridge lock live:** `SLIMCAST_BRIDGE_AUTH=true` is set in prod
      (fail-closed default), but the authenticated `bridge_proxy` path hasn't yet run a live
      stream. Confirm one transcode stream connects end-to-end; rollback is
      `SLIMCAST_BRIDGE_AUTH=false` + reprovision.
- ~~Confirm the VPS-hub flag `SLIMCAST_VPS_HUB`~~ — **N/A:** the all-in-one path was deleted
  2026-06-29; the VPS-hub is the ONLY path and `SLIMCAST_VPS_HUB` is no longer a gate.
- ~~Confirm the `:8080` relay debug panel fails closed~~ — **N/A:** the `:8080` FastAPI panel was
  deleted 2026-06-29 (relay stderr now goes to `docker logs`).

## 3. Repository

- [ ] **Make the repo private.** It is public now; before prod, create a fresh private repo
      so sensitive history (keys, infra details) doesn't ship publicly. See
      `memory/prelaunch_repo_private.md`.
- [ ] Confirm `STREAM_KEY_SECRET` is backed up somewhere durable — losing it makes all
      stored stream keys unrecoverable (CLAUDE.md).

## 4. App polish (deferred items)

From `memory/web_todo.md`:
- [ ] Email confirmation on signup.
- [ ] CAPTCHA / abuse protection on signup + sensitive routes.
- [ ] Review the credits/subscription checkout UX end-to-end.

## 5. Final verification

- [ ] Confirm the latest `main` **web-ci** run is green — it runs `tsc --noEmit` + the billing &
      provider unit suites + a `postgres:17` migration replay on every push (now a required check),
      so this is largely automated.
- [ ] Run one real end-to-end paid stream on a non-dev account in Stripe **live** mode and
      confirm the credit ledger, burn rate, and teardown behave (this is the first real
      "billing on" smoke test).
- [ ] Confirm Vercel production deploy is green after each env change (env changes need a
      redeploy to take effect).
