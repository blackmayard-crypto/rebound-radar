# Rebound Radar subscription sandbox

The billing preview lives in this directory and uses the existing Rebound Radar logo, colors, and typography. The free scanner, imported-history pilot, saved preferences, and demo rankings stay at the repository root. Sandbox research responses are access-check fixtures.

## Prices and Stripe account proposal

| USD | Monthly | Annual | Proposed access |
| --- | ---: | ---: | --- |
| Free beta | $0 | $0 | Public demo scanner and scoring pilot |
| Pro | $9.99 | $99 | Five weekday research candidates |
| Premium | $19.99 | $199 | Ten weekday candidates and deeper AI-company research |

Use the existing **Rebound Radar sandbox** (`acct_1UfMTlPy9VdylxTT`). It has four active recurring USD prices and a portal configuration with period-end cancellation. The existing sandbox research product carries both tiers, with distinct Premium prices and lookup keys. The sample environment contains all four sandbox price IDs. Existing Stripe records show successful monthly and annual Checkout payments, including one subscription scheduled to cancel at period end. Those records predate this code.

Sandbox setup still needs a server-side sandbox restricted key and a webhook signing secret. The existing portal enables period-end cancellation. Consider enabling payment-method updates and invoice history before hosted review. Keep plan changes and proration disabled for this first pass. Use a separate sandbox customer for each test identity.

Live setup requires a separate decision. Confirm the receiving Stripe account and statement descriptor, then approve two live products and four recurring USD prices, a live webhook and portal configuration, and keys stored only in the production runtime. Review tax treatment and customer-facing policies before activating any live checkout. Test-only credentials, catalog IDs, and webhook events remain isolated from production.

Published standard US fees used for estimates are 2.9% + $0.30 per successful domestic online card charge and 0.7% of Billing volume on the pay-as-you-go plan. Estimated combined fees are $0.66, $3.86, $1.02 and $7.46 respectively for Pro monthly, Pro annual, Premium monthly and Premium annual. Verify the actual account terms. International cards, currency conversion, taxes, disputes, refunds, and separately purchased services can change costs.

- [Stripe Payments pricing](https://stripe.com/pricing/local-payment-methods)
- [Stripe Billing pricing](https://stripe.com/billing/pricing)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

## Proposed holiday offer

New annual members receive 50% off the first year. The proposed signup window is December 1–31, 2026 Eastern time. A Checkout Session started before the cutoff can be completed within its existing 35-minute lifetime. Each member's first Rebound Radar subscription is eligible. Monthly plans use the existing catalog prices.

| Annual plan | First-year charge | Estimated first-year net | Automatic annual renewal | Estimated net per renewal |
| --- | ---: | ---: | ---: | ---: |
| Pro | $49.50 | $47.41 | $99.00 | $95.14 |
| Premium | $99.50 | $95.61 | $199.00 | $191.54 |

Net is gross less estimated domestic card processing and pay-as-you-go Stripe Billing fees, rounded separately to the nearest cent. The estimates exclude tax, refunds, disputes, international-card and FX fees, and operating costs.

The plan card and Stripe Checkout disclose the regular annual renewal price and how to cancel in the billing portal. Period-end cancellation keeps access through the paid period. Under the existing entitlement policy, a refund that leaves the payment below the price due for the current period ends access. A full refund and subscription cancellation are separate Stripe actions. If both are intended, perform both and verify their state in Stripe.

### Sandbox configuration and validation

Use a sandbox coupon configured for 50% off, with a duration of **Once**. The test coupon `rr_holiday_2026_sandbox` is available in the Rebound Radar sandbox. Set `STRIPE_HOLIDAY_COUPON` to that ID and set `HOLIDAY_OFFER_STARTS` and `HOLIDAY_OFFER_ENDS` to ISO 8601 timestamps with explicit offsets that include the test time. Leave the coupon variable empty to disable new promotional checkouts. To use a Stripe redemption deadline, allow for the 35-minute completion window. Keep the historical coupon record in Stripe for invoice verification.

The server chooses the coupon and applies it to eligible annual sessions. Checkout receives the standard recurring price and a one-invoice discount. The app checks the displayed price against the server-approved price and verifies Stripe's resulting Checkout total before returning the hosted URL. The signed-webhook flow verifies the invoice's subscription and customer, matching line and period, first-invoice coupon and amount, and sufficient settled, undisputed funds. Regular renewals must have zero discount and sufficient payment at the catalog price.

On November 27, 2026, Stripe's sandbox Test Clock produced a paid $49.50 Pro first invoice and a paid $99.00 renewal. Stripe also confirmed period-end cancellation and a $1.00 partial refund on the renewal charge. This was a Dashboard-created test subscription. The automated Worker tests separately cover both annual tiers, checkout price and coupon enforcement, signed-event entitlement, authorized and unauthorized discounts, renewal, cancellation, and refund behavior. A discounted hosted Checkout through this Worker, with actual Stripe webhook delivery, is still pending.

## Run locally

Requires Node 24+ and the Stripe CLI. Run from this directory.

```sh
npm ci
npm test
npm run migrate:local
cp .dev.vars.example .dev.vars
```

Generate a unique sandbox access code and hash with the command below. Put only the hash under a unique tester ID in the `TESTER_HASHES` JSON in `.dev.vars`. Give the original code to the intended tester through a private channel. Keep tester IDs distinct across separate local and hosted databases using the same Stripe sandbox. Removing a tester from the allowlist invalidates their existing sessions.

```sh
node --input-type=module -e 'import {randomBytes,createHash} from "node:crypto"; const token=randomBytes(32).toString("base64url"); console.log("Tester code",token); console.log("Server hash",createHash("sha256").update(token).digest("hex"))'
```

Set the sandbox key and the webhook secret in `.dev.vars`. A restricted key needs Checkout Sessions write, Customers write, Billing Portal Sessions write, and read access for Prices, Coupons, Subscriptions, Invoices, Invoice Payments, PaymentIntents and Billing Portal Configurations. Verify minimum permissions in the sandbox before hosted use.

With the Stripe CLI explicitly authenticated to the Rebound Radar sandbox, run the listener below and set `STRIPE_WEBHOOK_SECRET` to the listener's local signing secret. Start the dev server in another shell and use [http://localhost:8787](http://localhost:8787). Stripe webhook forwarding for local development and the deployed webhook endpoint use separate signing secrets.

```sh
stripe listen --forward-to http://localhost:8787/api/webhook --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created,charge.dispute.closed
npm run dev
```

The Worker rejects live keys and live webhook objects. A successful browser redirect displays pending verification. An independently verified Stripe event records the paid invoice, followed by a fresh Stripe check for each protected request. Paid access requires the authenticated account's Stripe customer, an approved price, a matching current invoice and billing period, and a settled and undisputed payment covering the verified price due for that period. The subscription must remain active through its paid period. An outage, failed renewal, ended subscription, or refund below the plan price closes access. Checkout permits one in-flight plan per account, with a 35-minute expiry. Sandbox sessions use revocable, eight-hour cookies after sign-in with a randomly generated tester code.

## Deployment review

1. A local Premium monthly Checkout and portal session passed against Rebound Radar's sandbox on November 25. For hosted review, test the remaining plan options, declined test payments, webhook replay, scheduled cancellation and access after the paid period. Use a sandbox Test Clock when testing renewals and period expiry.
2. After deployment approval, create a dedicated Cloudflare Worker on Workers Free and a D1 database on D1 Free. Set the real D1 ID, apply migrations with `wrangler d1 migrations apply rebound-radar-billing-sandbox --remote`, set a fixed HTTPS `PUBLIC_ORIGIN`, and configure the remaining environment variables and secrets. Stay within free-plan quotas and keep paid upgrades disabled. The proposed review Worker has its own URL and links back to the public beta.
3. After deployment approval, deploy the Worker from this directory. Register `/api/webhook` on that Worker in the Stripe sandbox using the event list above and API version `2026-11-18.endive`. Set the hosted endpoint's signing secret and repeat the sandbox checks. Validate that production Pages still shows the free beta.
4. Before a live launch, replace tester codes with production authentication, add the actual research publishing pipeline and licensed data, review operating policies and risk handling, and validate the production configuration. This sandbox branch deliberately has no live switch. Obtain separate approval for merging, production deployment, any live Stripe changes, and accepting payments.

## Validation completed November 25, 2026

Automated tests run the Worker handlers with a local Cloudflare D1 database, deterministic Stripe API fixtures, and the real Stripe SDK webhook signature verifier. They cover four price choices, checkout request coalescing, signed and invalid events, account isolation, a paid renewal, payment failure, Stripe outage, refunds and disputes, customer portal ownership, and period-end cancellation. Actual sandbox invoice and invoice-payment schemas were inspected against the existing Pro transactions. Local replay with two previously settled Stripe records verified access and expiry.

All eight automated tests passed. The local Worker HTTP check verified the preview page, security headers, logo, free beta redirect, tester sign-in, protected research gate, and sign-out. The local D1 migration and Wrangler deployment dry run passed. The package dependency audit reported zero vulnerabilities.

A fresh app-created $19.99 Premium monthly Checkout completed with a Stripe test card and captured test payment. Stripe CLI forwarded signed events to the local app, which verified the invoice and enabled Premium research access. The app created a billing portal session, and a period-end cancellation set via the sandbox API kept the subscription active through the paid period. The app ran through a local Stripe CLI transport adapter. The browser could not display the localhost return page, so payment and access were verified through Stripe and the local API.
