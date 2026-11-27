import { cookie, getMember, hash, sandboxOrigin, sessionToken, signIn } from './access.mjs';
import { activeHolidayCoupon, holidayCents, plans } from './catalog.mjs';
import { entitlement, handleWebhook, openPortal, RequestError, startCheckout, stripeClient } from './stripe.mjs';

const NO_CACHE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const API = {
  '/api/login': 'POST',
  '/api/logout': 'POST',
  '/api/status': 'GET',
  '/api/checkout': 'POST',
  '/api/portal': 'POST',
  '/api/research': 'GET',
  '/api/webhook': 'POST',
};

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { ...NO_CACHE, ...headers } });
}

async function readBody(request, maxBytes) {
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw new RequestError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, 'Missing request body.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '';
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return body + decoder.decode();
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new RequestError(413, 'Request is too large.');
    }
    body += decoder.decode(value, { stream: true });
  }
}

async function readJson(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
    throw new RequestError(415, 'Expected a JSON request.');
  }
  const raw = await readBody(request, 2048);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new RequestError(400, 'Invalid JSON.');
  }
}

function publicPlans(env, member, status, now) {
  const coupon = status === 'none' ? activeHolidayCoupon(env, now) : null;
  const pending = member.checkout_expires > now;

  return Object.entries(plans).map(([key, plan]) => ({
    key, name: plan.name, interval: plan.interval, cents: plan.cents,
    firstYearCents: plan.interval === 'year' &&
      (pending ? member.checkout_plan === key && member.checkout_coupon : coupon) ? holidayCents(plan) : null,
    configured: /^price_[a-zA-Z0-9]+$/.test(env[plan.variable] ?? ''),
  }));
}

export function createWorker({ client = stripeClient, clock = () => Date.now() } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      try {
        const origin = sandboxOrigin(env.PUBLIC_ORIGIN);
        if (url.origin !== origin) return json({ error: 'Unexpected origin.' }, 421);
        if (!url.pathname.startsWith('/api/')) return assetResponse(request, env);
        if (!Object.hasOwn(API, url.pathname)) return json({ error: 'Unknown route.' }, 404);
        const method = API[url.pathname];
        if (request.method !== method) return json({ error: 'Method not allowed.' }, 405, { Allow: method });
        const now = Math.floor(clock() / 1000);

        if (url.pathname === '/api/webhook') {
          const raw = await readBody(request, 1024 * 1024);
          await handleWebhook(client(env.STRIPE_TEST_KEY), env, raw, request.headers.get('Stripe-Signature'), now);
          return json({ received: true });
        }
        if (method === 'POST' && request.headers.get('Origin') !== origin) {
          throw new RequestError(403, 'Unexpected origin.');
        }

        const session = sessionToken(request);
        if (url.pathname === '/api/login') {
          const { token } = await readJson(request);
          const newSession = await signIn(env.DB, env.TESTER_HASHES, token, now);
          if (!newSession) throw new RequestError(401, 'Sandbox access code is invalid.');
          if (session) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hash(session)).run();
          return json({ signedIn: true }, 200, { 'Set-Cookie': cookie(newSession, origin) });
        }
        if (url.pathname === '/api/logout') {
          if (session) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hash(session)).run();
          return json({ signedIn: false }, 200, { 'Set-Cookie': cookie(null, origin) });
        }

        const member = await getMember(env.DB, env.TESTER_HASHES, session, now);
        if (!member) throw new RequestError(401, 'Sign in to the billing sandbox.');

        switch (url.pathname) {
          case '/api/checkout': {
            const { plan, quotedCents } = await readJson(request);
            if (typeof plan !== 'string') throw new RequestError(400, 'Choose a valid plan.');
            return json(await startCheckout(client(env.STRIPE_TEST_KEY), env, member, plan, origin, now, quotedCents));
          }
          case '/api/portal':
            return json(await openPortal(client(env.STRIPE_TEST_KEY), env, member, origin));
          case '/api/status':
          case '/api/research': {
            const access = await entitlement(client(env.STRIPE_TEST_KEY), env, member, now);
            if (url.pathname === '/api/status') {
              return json({ ...access, hasBillingAccount: Boolean(member.stripe_customer), plans: publicPlans(env, member, access.status, now) });
            }
            if (access.tier === 'free') throw new RequestError(403, 'A verified sandbox subscription is required.');
            return json({
              tier: access.tier,
              weekdayResearch: 'Weekday research access verified in the sandbox.',
              aiResearch: access.tier === 'premium' ? 'Premium AI-company research access verified in the sandbox.' : null,
            });
          }
        }
      } catch (error) {
        if (error instanceof RequestError) return json({ error: error.message }, error.status);
        console.error('Billing sandbox request failed', url.pathname, error.type ?? error.name, error.code ?? '');
        return json({ error: 'Billing is temporarily unavailable. Please try again.' }, 503);
      }
    },
  };
}

async function assetResponse(request, env) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/beta') {
    const beta = new URL(env.BETA_URL ?? 'https://blackmayard-crypto.github.io/rebound-radar/');
    if (beta.protocol !== 'https:') throw new Error('Beta URL must use HTTPS');
    return Response.redirect(beta, 302);
  }
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(NO_CACHE)) headers.set(key, value);
  headers.set('Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'");
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, headers });
}

export default createWorker();
