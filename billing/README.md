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

Set the sandbox key and the webhook secret in `.dev.vars`. A restricted key needs Checkout Sessions write, Customers write, Billing Portal Sessions write, and read access for Prices, Subscriptions, Invoices, Invoice Payments, PaymentIntents and Billing Portal Configurations. Verify minimum permissions in the sandbox before hosted use.

With the Stripe CLI explicitly authenticated to the Rebound Radar sandbox, run the listener below and set `STRIPE_WEBHOOK_SECRET` to the listener's local signing secret. Start the dev server in another shell and use [http://localhost:8787](http://localhost:8787). Stripe webhook forwarding for local development and the deployed webhook endpoint use separate signing secrets.

```sh
stripe listen --forward-to http://localhost:8787/api/webhook --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created,charge.dispute.closed
npm run dev
```

The Worker rejects live keys and live webhook objects. A successful browser redirect displays pending verification. An independently verified Stripe event records the paid invoice, followed by a fresh Stripe check for each protected request. Paid access requires the authenticated account's Stripe customer, an approved price, a matching current invoice and billing period, and a settled and undisputed payment covering the plan price. The subscription must remain active through its paid period. An outage, failed renewal, ended subscription, or refund below the plan price closes access. Checkout permits one in-flight plan per account, with a 35-minute expiry. Sandbox sessions use revocable, eight-hour cookies after sign-in with a randomly generated tester code.

## Deployment review

1. Complete a fresh local hosted Checkout and portal test with this implementation against Rebound Radar's sandbox. Verify all four prices, successful and declined test payments, webhook delivery and replay, scheduled cancellation, and access after the paid period. Use a sandbox Test Clock when testing renewals and period expiry.
2. After deployment approval, create a dedicated Cloudflare Worker on Workers Free and a D1 database on D1 Free. Set the real D1 ID, apply migrations with `wrangler d1 migrations apply rebound-radar-billing-sandbox --remote`, set a fixed HTTPS `PUBLIC_ORIGIN`, and configure the remaining environment variables and secrets. Stay within free-plan quotas and keep paid upgrades disabled. The proposed review Worker has its own URL and links back to the public beta.
3. After deployment approval, deploy the Worker from this directory. Register `/api/webhook` on that Worker in the Stripe sandbox using the event list above and API version `2026-11-18.endive`. Set the hosted endpoint's signing secret and repeat the sandbox checks. Validate that production Pages still shows the free beta.
4. Before a live launch, replace tester codes with production authentication, add the actual research publishing pipeline and licensed data, review operating policies and risk handling, and validate the production configuration. This sandbox branch deliberately has no live switch. Obtain separate approval for merging, production deployment, any live Stripe changes, and accepting payments.

## Validation completed November 25, 2026

Automated tests run the Worker handlers with a local Cloudflare D1 database, deterministic Stripe API fixtures, and the real Stripe SDK webhook signature verifier. They cover four price choices, checkout request coalescing, signed and invalid events, account isolation, a paid renewal, payment failure, Stripe outage, refunds and disputes, customer portal ownership, and period-end cancellation. Actual sandbox invoice and invoice-payment schemas were inspected against the existing Pro transactions. A new app-driven Stripe test payment and external webhook delivery require the runtime sandbox key and signing secret.

All eight automated tests passed. The local Worker HTTP check verified the preview page, security headers, logo, free beta redirect, tester sign-in, protected research gate, and sign-out. The local D1 migration and Wrangler deployment dry run passed. The package dependency audit reported zero vulnerabilities.
