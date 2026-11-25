export const plans = Object.freeze({
  'pro-month': { tier: 'pro', name: 'Pro', interval: 'month', cents: 999, variable: 'STRIPE_PRO_MONTH' },
  'pro-year': { tier: 'pro', name: 'Pro', interval: 'year', cents: 9900, variable: 'STRIPE_PRO_YEAR' },
  'premium-month': { tier: 'premium', name: 'Premium', interval: 'month', cents: 1999, variable: 'STRIPE_PREMIUM_MONTH' },
  'premium-year': { tier: 'premium', name: 'Premium', interval: 'year', cents: 19900, variable: 'STRIPE_PREMIUM_YEAR' },
});

export const subscriptionEvents = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
];

export function priceMatches(price, plan, env) {
  return Boolean(price && price.livemode === false && price.id === env[plan.variable] &&
    price.currency === 'usd' && price.unit_amount === plan.cents &&
    price.recurring?.interval === plan.interval && price.recurring.interval_count === 1 &&
    price.recurring.usage_type === 'licensed');
}
