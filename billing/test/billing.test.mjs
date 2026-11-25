import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { test, before, after } from 'node:test';
import Stripe from 'stripe';
import { getPlatformProxy } from 'wrangler';
import { hash } from '../access.mjs';
import { plans } from '../catalog.mjs';
import { stripeClient } from '../stripe.mjs';
import { createWorker } from '../worker.mjs';

const origin = 'http://localhost:8787';
const secret = 'whsec_local_suite';
const appName = 'rebound-radar-billing-sandbox';
const timestamp = 1820000000;
const tester = 't'.repeat(43);
const otherTester = 'u'.repeat(43);
const sdk = new Stripe('sk_test_fixture');
let platform;

before(async () => {
  platform = await getPlatformProxy({ configPath: 'wrangler.jsonc', persist: false });
  const schema = await readFile(new URL('../migrations/0001_sandbox.sql', import.meta.url), 'utf8');
  await platform.env.DB.batch(schema.split(';').filter(sql => sql.trim()).map(sql => platform.env.DB.prepare(sql)));
});
after(async () => { await platform?.dispose(); });

function fixture(planKey = 'pro-month') {
  const plan = plans[planKey];
  const env = {
    DB: platform.env.DB,
    PUBLIC_ORIGIN: origin,
    STRIPE_TEST_KEY: 'sk_test_fixture',
    STRIPE_WEBHOOK_SECRET: secret,
    STRIPE_PORTAL_CONFIGURATION: 'bpc_sandbox',
    TESTER_HASHES: '{}',
    ASSETS: { fetch: () => new Response('Billing preview') },
  };
  const catalog = Object.fromEntries(Object.entries(plans).map(([key, entry], i) => {
    const id = `price_${i}`;
    env[entry.variable] = id;
    return [key, {
      id, active: true, livemode: false, currency: 'usd', unit_amount: entry.cents,
      recurring: { interval: entry.interval, interval_count: 1, usage_type: 'licensed' },
    }];
  }));
  const state = {
    customer: 'cus_tester',
    sessions: new Map(),
    subscriptions: [],
    paid: true,
    failure: false,
    refunded: false,
    disputed: false,
    noCharge: false,
    wrongLine: false,
    portalRequests: [],
    prices: catalog,
  };
  const client = {
    webhooks: sdk.webhooks,
    customers: { create: async ({ metadata }) => ({ livemode: false, id: 'cus_' + metadata.member }) },
    prices: { retrieve: async id => Object.values(catalog).find(price => price.id === id) },
    checkout: { sessions: { create: async (params, { idempotencyKey }) => {
      if (!state.sessions.has(idempotencyKey)) state.sessions.set(idempotencyKey, params);
      return { livemode: false, customer: params.customer, status: 'open', url: 'https://checkout.stripe.com/c/pay/fixture' };
    } } },
    subscriptions: {
      list: async ({ customer }) => {
        if (state.failure) throw Object.assign(new Error('unavailable'), { type: 'FixtureStripeDown' });
        return { has_more: false, data: state.subscriptions.filter(sub => sub.customer === customer) };
      },
      retrieve: async id => state.subscriptions.find(sub => sub.id === id),
    },
    invoices: { retrieve: async invoice => {
      const sub = state.subscriptions.find(sub => sub.latest_invoice === invoice);
      const item = sub.items.data[0];
      return {
        status: state.paid ? 'paid' : 'open', livemode: false, customer: sub.customer,
        parent: { subscription_details: { subscription: sub.id } },
        currency: 'usd', amount_paid: plan.cents,
        billing_reason: 'subscription_cycle',
        lines: { has_more: false, data: [{
          parent: { subscription_item_details: { subscription_item: item.id } },
          pricing: { price_details: { price: state.wrongLine ? 'price_other' : item.price.id } },
          period: { end: item.current_period_end },
        }] },
      };
    } },
    invoicePayments: { list: async ({ invoice }) => ({
      has_more: false,
      data: state.noCharge ? [] : [{
        invoice, livemode: false, status: 'paid', currency: 'usd', amount_paid: plan.cents,
        payment: { type: 'payment_intent', payment_intent: 'pi_' + invoice },
      }],
    }) },
    paymentIntents: { retrieve: async () => ({
      livemode: false, customer: state.customer, status: 'succeeded', currency: 'usd', amount_received: plan.cents,
      latest_charge: {
        livemode: false, paid: true, captured: true, disputed: state.disputed, refunded: state.refunded,
        amount_captured: plan.cents, amount_refunded: state.refunded ? plan.cents : 0,
      },
    }) },
    billingPortal: {
      configurations: { retrieve: async () => ({
        livemode: false, active: true,
        features: { subscription_cancel: { enabled: true, mode: 'at_period_end' }, subscription_update: { enabled: false } },
      }) },
      sessions: { create: async params => {
        state.portalRequests.push(params);
        return { livemode: false, customer: params.customer, url: 'https://billing.stripe.com/p/session/fixture' };
      } },
    },
  };

  let now = timestamp;
  const worker = createWorker({ client: () => client, clock: () => now * 1000 });
  const call = (path, { cookie, body, method = body ? 'POST' : 'GET', headers = {} } = {}) =>
    worker.fetch(new Request(origin + path, {
      method,
      headers: {
        Origin: origin,
        ...(body && { 'Content-Type': 'application/json' }),
        ...(cookie && { Cookie: cookie }),
        ...headers,
      },
      body: typeof body === 'string' ? body : body && JSON.stringify(body),
    }), env);

  const login = async (token, cookie) => {
    const res = await call('/api/login', { body: { token }, cookie });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('Set-Cookie');
    assert.match(setCookie, /HttpOnly; SameSite=Lax/);
    return setCookie.split(';')[0];
  };

  const hook = async (name, object, eventId, opts = {}) => {
    const payload = JSON.stringify({ livemode: opts.live ?? false, id: eventId, type: name, data: { object: { livemode: false, ...object } } });
    const signedAt = opts.at ?? now;
    const signature = createHmac('sha256', secret).update(`${signedAt}.${payload}`).digest('hex');
    return call('/api/webhook', {
      method: 'POST', body: opts.tamper ? payload + ' ' : payload,
      headers: { 'Stripe-Signature': `t=${signedAt},v1=${signature}` },
    });
  };

  const subscribe = (member, invoice) => {
    const sub = {
      id: 'sub_' + member, livemode: false, customer: 'cus_' + member,
      metadata: { app: appName, member },
      latest_invoice: invoice,
      status: 'active',
      items: { data: [{ id: 'si_' + member, price: catalog[planKey], quantity: 1, current_period_end: now + 3600 }] },
    };
    state.customer = sub.customer;
    state.subscriptions.push(sub);
    return sub;
  };

  return { env, state, call, login, hook, subscribe, advance: seconds => { now += seconds; } };
}

async function register(f, first, second = 'other') {
  f.env.TESTER_HASHES = JSON.stringify({ [first]: await hash(tester), [second]: await hash(otherTester) });
  return f.login(tester);
}

function invoiceEvent(sub) {
  return { id: sub.latest_invoice, parent: { subscription_details: { subscription: sub.id } } };
}

test('rejects live keys before creating the Stripe client', () => {
  assert.throws(() => stripeClient('sk_live_fixture'), /sandbox key/);
  assert.throws(() => stripeClient('rk_live_fixture'), /sandbox key/);
  assert.ok(stripeClient('rk_test_fixture'));
});

test('private routes require a valid session and reject cross-origin writes', async () => {
  const f = fixture();
  assert.equal((await f.call('/api/research')).status, 401);
  assert.equal((await f.call('/api/checkout', { body: { plan: 'pro-month' }, headers: { Origin: 'https://example.org' } })).status, 403);
  assert.equal((await f.call('/api/login', { body: { token: 'bad' } })).status, 401);
  const cookie = await register(f, 'access');
  assert.equal((await f.call('/api/research', { cookie })).status, 403);
  const status = await f.call('/api/status', { cookie });
  assert.equal(status.headers.get('Cache-Control'), 'no-store');
  assert.equal((await status.json()).tier, 'free');
  assert.equal((await f.call('/api/logout', { cookie, body: {} })).status, 200);
  assert.equal((await f.call('/api/status', { cookie })).status, 401);
  const renewed = await f.login(tester);
  f.advance(8 * 3600 + 1);
  assert.equal((await f.call('/api/status', { cookie: renewed })).status, 401);
});

test('validates all four recurring prices and pins the plan, customer, and redirect server-side', async () => {
  for (const [index, [key, plan]] of Object.entries(plans).entries()) {
    const f = fixture(key);
    const cookie = await register(f, 'catalog' + index);
    const res = await f.call('/api/checkout', {
      cookie, body: { plan: key, price: 'price_intruder', return_url: 'https://example.org', customer: 'cus_intruder' },
    });
    assert.equal(res.status, 200);
    const [params] = f.state.sessions.values();
    assert.equal(params.mode, 'subscription');
    assert.equal(params.customer, 'cus_catalog' + index);
    assert.deepEqual(params.line_items, [{ price: f.env[plan.variable], quantity: 1 }]);
    assert.equal(params.success_url, origin + '/?checkout=returned');
    assert.equal(params.adaptive_pricing.enabled, false);
  }
  const f = fixture();
  const cookie = await register(f, 'forgedprice');
  assert.equal((await f.call('/api/checkout', { cookie, body: { plan: 'constructor' } })).status, 400);
  f.state.prices['pro-month'].unit_amount = 1;
  assert.equal((await f.call('/api/checkout', { cookie, body: { plan: 'pro-month' } })).status, 503);
  delete f.env.STRIPE_PREMIUM_MONTH;
  assert.equal((await f.call('/api/checkout', { cookie, body: { plan: 'premium-month' } })).status, 503);
});

test('coalesces parallel checkouts and rejects a second subscription or session with a different plan', async () => {
  const f = fixture();
  const cookie = await register(f, 'parallel');
  const submit = plan => f.call('/api/checkout', { cookie, body: { plan } });
  const [one, two] = await Promise.all([submit('pro-month'), submit('pro-month')]);
  assert.deepEqual([one.status, two.status], [200, 200]);
  assert.equal(f.state.sessions.size, 1);
  assert.equal((await submit('premium-year')).status, 409);
  f.subscribe('parallel', 'in_parallel');
  assert.equal((await submit('pro-month')).status, 409);
  f.advance(35 * 60 + 1);
  assert.equal((await submit('premium-year')).status, 409);
});

test('an unpaid redirect and unsigned, stale, tampered, or live webhook cannot enable a tier', async () => {
  const f = fixture();
  const cookie = await register(f, 'signed');
  await f.call('/api/checkout', { cookie, body: { plan: 'pro-month' } });
  const sub = f.subscribe('signed', 'in_signed');
  assert.equal((await f.call('/api/research?checkout=returned', { cookie })).status, 403);
  assert.equal((await f.call('/api/webhook', { body: '{}' })).status, 400);
  for (const options of [{ live: true }, { tamper: true }, { at: timestamp - 301 }]) {
    assert.equal((await f.hook('invoice.paid', invoiceEvent(sub), 'evt_invalid', options)).status, 400);
  }
  f.state.paid = false;
  const session = { mode: 'subscription', metadata: { app: appName }, subscription: sub.id, payment_status: 'unpaid' };
  assert.equal((await f.hook('checkout.session.completed', session, 'evt_unpaid')).status, 200);
  assert.equal((await f.call('/api/research', { cookie })).status, 403);
  f.state.paid = true;
  assert.equal((await f.hook('checkout.session.async_payment_succeeded',
    { ...session, payment_status: 'paid' }, 'evt_asyncpaid')).status, 200);
  const access = await (await f.call('/api/research', { cookie })).json();
  assert.equal(access.tier, 'pro');
  assert.equal(access.aiResearch, null);
});

test('links paid invoices to the authenticated owner and verifies every renewal', async () => {
  const f = fixture('premium-year');
  const cookie = await register(f, 'premium', 'isolated');
  const other = await f.login(otherTester);
  await f.call('/api/checkout', { cookie, body: { plan: 'premium-year' } });
  const sub = f.subscribe('premium', 'in_premium');
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.hook('invoice.paid', invoiceEvent(sub), 'evt_premium')).status, 200);
  }
  const record = await f.env.DB.prepare('SELECT count(*) AS count FROM stripe_events WHERE event_id = ?').bind('evt_premium').first();
  assert.equal(record.count, 1);
  assert.equal((await f.call('/api/research', { cookie: other })).status, 403);
  const access = await (await f.call('/api/research', { cookie })).json();
  assert.equal(access.tier, 'premium');
  assert.match(access.aiResearch, /Premium/);

  sub.latest_invoice = 'in_premium_renewal';
  assert.equal((await f.call('/api/research', { cookie })).status, 403);
  await f.hook('invoice.paid', invoiceEvent(sub), 'evt_renewal');
  await f.hook('invoice.payment_failed', { id: 'in_premium' }, 'evt_delayedfailure');
  assert.equal((await f.call('/api/research', { cookie })).status, 200);
  sub.status = 'past_due';
  assert.equal((await f.call('/api/research', { cookie })).status, 403);
  f.state.failure = true;
  assert.equal((await f.call('/api/research', { cookie })).status, 503);
});

test('blocks paid-out-of-band, wrong invoice periods or prices, disputes and refunds', async () => {
  const f = fixture();
  const cookie = await register(f, 'risk');
  await f.call('/api/checkout', { cookie, body: { plan: 'pro-month' } });
  const sub = f.subscribe('risk', 'in_risk');
  f.state.noCharge = true;
  await f.hook('invoice.paid', invoiceEvent(sub), 'evt_oob');
  assert.equal((await f.call('/api/research', { cookie })).status, 403);
  f.state.noCharge = false;
  f.state.wrongLine = true;
  await f.hook('invoice.paid', invoiceEvent(sub), 'evt_wrongline');
  assert.equal((await f.call('/api/research', { cookie })).status, 403);
  f.state.wrongLine = false;
  await f.hook('invoice.paid', invoiceEvent(sub), 'evt_goodrisk');
  assert.equal((await f.call('/api/research', { cookie })).status, 200);
  f.state.disputed = true;
  await f.hook('charge.dispute.created', { id: 'dp_fixture' }, 'evt_dispute');
  assert.equal((await f.call('/api/research', { cookie })).status, 403);
  f.state.disputed = false;
  f.state.refunded = true;
  await f.hook('charge.refunded', { id: 'ch_fixture' }, 'evt_refund');
  assert.equal((await f.call('/api/research', { cookie })).status, 403);
});

test('portal uses only the signed-in customer and cancellation retains access until the paid period ends', async () => {
  const f = fixture();
  const cookie = await register(f, 'cancel');
  await f.call('/api/checkout', { cookie, body: { plan: 'pro-month' } });
  const sub = f.subscribe('cancel', 'in_cancel');
  await f.hook('invoice.paid', invoiceEvent(sub), 'evt_paid_cancel');
  const portal = await f.call('/api/portal', { cookie, body: { customer: 'cus_intruder' } });
  assert.equal(portal.status, 200);
  assert.equal(f.state.portalRequests[0].customer, 'cus_cancel');
  sub.cancel_at_period_end = true;
  sub.cancel_at = timestamp + 3600;
  await f.hook('customer.subscription.updated', sub, 'evt_schedule_cancel');
  const scheduled = await (await f.call('/api/status', { cookie })).json();
  assert.equal(scheduled.tier, 'pro');
  assert.equal(scheduled.cancelAtPeriodEnd, true);
  assert.equal(scheduled.accessUntil, new Date((timestamp + 3600) * 1000).toISOString());
  f.advance(3600);
  assert.equal((await f.call('/api/research', { cookie })).status, 403);
  sub.status = 'canceled';
  await f.hook('customer.subscription.deleted', sub, 'evt_ended');
  await f.hook('invoice.paid', invoiceEvent(sub), 'evt_stale_paid');
  assert.equal((await f.call('/api/research', { cookie })).status, 403);
});
