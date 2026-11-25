import Stripe from 'stripe';
import { plans, priceMatches, subscriptionEvents } from './catalog.mjs';

const APP = 'rebound-radar-billing-sandbox';
const ENDED = new Set(['canceled', 'incomplete_expired']);
const EVENTS = new Set(subscriptionEvents);
const id = value => typeof value === 'string' ? value : value?.id;

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function stripeClient(key) {
  if (!/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(key ?? '')) {
    throw new RequestError(503, 'A Stripe sandbox key is required.');
  }
  return new Stripe(key, {
    apiVersion: '2026-11-18.endive',
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 1,
    timeout: 8000,
  });
}

async function billingCustomer(stripe, env, member) {
  if (member.stripe_customer) return member.stripe_customer;
  const customer = await stripe.customers.create({
    metadata: { app: APP, member: member.member_id },
  }, { idempotencyKey: `rr-sandbox-customer-${member.member_id}` });
  if (customer.livemode !== false) throw new Error('Expected sandbox customer');

  const registered = await env.DB.prepare(
    'UPDATE members SET stripe_customer = COALESCE(stripe_customer, ?) WHERE member_id = ? RETURNING stripe_customer',
  ).bind(customer.id, member.member_id).first();
  return registered.stripe_customer;
}

async function subscriptions(stripe, customer) {
  const all = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
  if (all.has_more || all.data.some(sub => sub.livemode !== false || id(sub.customer) !== customer)) {
    throw new Error('Could not establish sandbox subscription state');
  }
  return all.data.filter(sub => sub.metadata?.app === APP);
}

export async function startCheckout(stripe, env, member, planKey, origin, now) {
  if (!Object.hasOwn(plans, planKey)) throw new RequestError(400, 'Choose a valid plan.');
  const plan = plans[planKey];
  if (!/^price_[a-zA-Z0-9]+$/.test(env[plan.variable] ?? '')) {
    throw new RequestError(503, 'This sandbox price has not been configured.');
  }
  const price = await stripe.prices.retrieve(env[plan.variable]);
  if (!priceMatches(price, plan, env) || !price.active) throw new RequestError(503, 'Sandbox price mismatch.');

  const customer = await billingCustomer(stripe, env, member);
  // Serialize the choice per member. Concurrent requests use one Stripe idempotency key.
  const reserved = await env.DB.prepare(`UPDATE members
    SET checkout_key = CASE WHEN COALESCE(checkout_expires, 0) <= ? THEN ? ELSE checkout_key END,
        checkout_plan = CASE WHEN COALESCE(checkout_expires, 0) <= ? THEN ? ELSE checkout_plan END,
        checkout_expires = CASE WHEN COALESCE(checkout_expires, 0) <= ? THEN ? ELSE checkout_expires END
    WHERE member_id = ? RETURNING checkout_key, checkout_plan, checkout_expires`
  ).bind(now, crypto.randomUUID(), now, planKey, now, now + 35 * 60, member.member_id).first();

  if ((await subscriptions(stripe, customer)).some(sub => !ENDED.has(sub.status))) {
    throw new RequestError(409, 'Manage your existing subscription in the billing portal.');
  }
  if (reserved.checkout_plan !== planKey) {
    throw new RequestError(409, 'A different plan is already in checkout. Resume it or wait for it to expire.');
  }

  const metadata = { app: APP, member: member.member_id };
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: price.id, quantity: 1 }],
    client_reference_id: member.member_id,
    metadata,
    subscription_data: { metadata },
    success_url: origin + '/?checkout=returned',
    cancel_url: origin + '/?checkout=abandoned',
    expires_at: reserved.checkout_expires,
    adaptive_pricing: { enabled: false },
    integration_identifier: 'rebound_radar_sandbox_qkmyrdvc',
  }, { idempotencyKey: `rr-checkout-${reserved.checkout_key}` });

  if (session.livemode !== false || id(session.customer) !== customer ||
      session.status !== 'open' || !session.url || new URL(session.url).origin !== 'https://checkout.stripe.com') {
    throw new RequestError(409, 'This Checkout Session is no longer available. Refresh your account status.');
  }
  return { url: session.url };
}

export async function openPortal(stripe, env, member, origin) {
  if (!member.stripe_customer) throw new RequestError(409, 'Complete checkout before opening billing.');
  const configId = env.STRIPE_PORTAL_CONFIGURATION;
  if (!/^bpc_[a-zA-Z0-9]+$/.test(configId ?? '')) throw new RequestError(503, 'Billing portal is not configured.');
  const config = await stripe.billingPortal.configurations.retrieve(configId);
  if (config.livemode !== false || !config.active ||
      !config.features?.subscription_cancel?.enabled ||
      config.features.subscription_cancel.mode !== 'at_period_end' ||
      config.features.subscription_update?.enabled) {
    throw new RequestError(503, 'Billing portal cancellation settings need review.');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: member.stripe_customer,
    configuration: configId,
    return_url: origin + '/',
  });
  if (session.livemode !== false || session.customer !== member.stripe_customer ||
      new URL(session.url).origin !== 'https://billing.stripe.com') {
    throw new Error('Expected a sandbox billing portal session');
  }
  return { url: session.url };
}

function subscriptionPlan(sub, env, member, now) {
  if (sub.livemode !== false || id(sub.customer) !== member.stripe_customer ||
      sub.metadata?.app !== APP || sub.metadata?.member !== member.member_id ||
      sub.status !== 'active' || sub.pause_collection) return null;
  const item = sub.items?.data?.[0];
  if (!item || sub.items.data.length !== 1 || sub.items.has_more || item.quantity !== 1 ||
      !Number.isSafeInteger(item.current_period_end) || item.current_period_end <= now ||
      (sub.cancel_at && sub.cancel_at <= now)) return null;
  const plan = Object.values(plans).find(candidate => priceMatches(item.price, candidate, env));
  return plan ? {
    plan,
    item,
    ends: Math.min(item.current_period_end, sub.cancel_at ?? item.current_period_end),
    cancels: Boolean(sub.cancel_at_period_end || sub.cancel_at),
  } : null;
}

async function stripePayment(stripe, sub, { plan, item }) {
  const invoiceId = id(sub.latest_invoice);
  if (!invoiceId) return null;
  const invoice = await stripe.invoices.retrieve(invoiceId);
  if (invoice.livemode !== false || invoice.status !== 'paid' ||
      id(invoice.customer) !== id(sub.customer) ||
      id(invoice.parent?.subscription_details?.subscription) !== sub.id ||
      invoice.currency !== 'usd' || invoice.amount_paid < plan.cents ||
      !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason) ||
      invoice.lines?.has_more || !invoice.lines?.data?.some(line =>
        id(line.parent?.subscription_item_details?.subscription_item) === item.id &&
        id(line.pricing?.price_details?.price) === item.price.id &&
        line.period?.end === item.current_period_end)) return null;

  const payments = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 100 });
  if (payments.has_more) return null;
  const settled = payments.data.find(payment => payment.livemode === false &&
    id(payment.invoice) === invoiceId && payment.status === 'paid' && payment.currency === 'usd' &&
    payment.amount_paid >= plan.cents && payment.payment?.type === 'payment_intent');
  const paymentId = id(settled?.payment.payment_intent);
  if (!paymentId) return null;
  const intent = await stripe.paymentIntents.retrieve(paymentId, { expand: ['latest_charge'] });
  const charge = intent.latest_charge;
  if (intent.livemode !== false || id(intent.customer) !== id(sub.customer) ||
      intent.status !== 'succeeded' || intent.currency !== 'usd' ||
      intent.amount_received < plan.cents || charge?.livemode !== false || !charge.paid ||
      !charge.captured || charge.disputed || charge.refunded ||
      charge.amount_captured - charge.amount_refunded < plan.cents) return null;

  return { invoiceId, paymentId };
}

export async function entitlement(stripe, env, member, now) {
  const result = { tier: 'free', status: 'none', accessUntil: null, cancelAtPeriodEnd: false };
  if (!member.stripe_customer) return result;
  const all = await subscriptions(stripe, member.stripe_customer);
  if (all.length) {
    result.status = all.find(sub => !ENDED.has(sub.status))?.status ?? all[0].status;
  }
  for (const sub of all) {
    const access = subscriptionPlan(sub, env, member, now);
    if (!access || (access.plan.tier === 'pro' && result.tier === 'premium')) continue;
    const verified = await env.DB.prepare(`SELECT payment_intent_id FROM verified_invoices
      WHERE invoice_id = ? AND subscription_id = ? AND customer_id = ?`
    ).bind(id(sub.latest_invoice) ?? '', sub.id, member.stripe_customer).first();
    if (!verified) continue;
    const payment = await stripePayment(stripe, sub, access);
    if (payment?.paymentId !== verified.payment_intent_id) continue;
    Object.assign(result, {
      tier: access.plan.tier,
      status: sub.status,
      accessUntil: new Date(access.ends * 1000).toISOString(),
      cancelAtPeriodEnd: access.cancels,
    });
  }
  return result;
}

function eventSubscription(event) {
  const object = event.data.object;
  if (event.type.startsWith('checkout.session.') && object.mode === 'subscription' &&
      object.metadata?.app === APP && object.payment_status === 'paid') return id(object.subscription);
  if (event.type === 'customer.subscription.updated' && object.status === 'active') return object.id;
  if (event.type === 'invoice.paid') return id(object.parent?.subscription_details?.subscription);
  return null;
}

export async function handleWebhook(stripe, env, rawBody, signature, now) {
  if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) {
    throw new RequestError(503, 'Webhook signing secret is missing.');
  }

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, env.STRIPE_WEBHOOK_SECRET,
      300, Stripe.createSubtleCryptoProvider(), now * 1000);
  } catch {
    throw new RequestError(400, 'Invalid Stripe signature.');
  }
  if (event.livemode !== false || event.data?.object?.livemode !== false) {
    throw new RequestError(400, 'This endpoint only accepts sandbox events.');
  }
  if (!EVENTS.has(event.type)) return;
  const duplicate = await env.DB.prepare('SELECT event_id FROM stripe_events WHERE event_id = ?').bind(event.id).first();
  if (duplicate) return;

  const statements = [];
  const subId = eventSubscription(event);
  // Other lifecycle events are recorded. Every protected read evaluates current Stripe state,
  // so retries and out-of-order failures, cancellations and risk events cannot restore access.
  if (subId) {
    const sub = await stripe.subscriptions.retrieve(subId);
    const member = await env.DB.prepare('SELECT * FROM members WHERE stripe_customer = ?')
      .bind(id(sub.customer)).first();
    const access = member && subscriptionPlan(sub, env, member, now);
    if (access) {
      const payment = await stripePayment(stripe, sub, access);
      if (payment) {
        statements.push(env.DB.prepare('INSERT OR IGNORE INTO verified_invoices VALUES (?, ?, ?, ?)')
          .bind(payment.invoiceId, member.stripe_customer, sub.id, payment.paymentId));
      }
    }
  }
  statements.push(env.DB.prepare('INSERT OR IGNORE INTO stripe_events VALUES (?, ?, ?)')
    .bind(event.id, event.type, now));
  await env.DB.batch(statements);
}
