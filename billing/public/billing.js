const $ = id => document.getElementById(id);
const status = $('status');
const login = $('login');
const account = $('account');
const params = new URLSearchParams(location.search);
const checkoutReturn = params.get('checkout');
if (checkoutReturn) history.replaceState(null, '', '/');
let busy = false;

async function api(route, data) {
  const response = await fetch('/api/' + route, data === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error), { status: response.status });
  return payload;
}

function card(plan, canSubscribe) {
  const element = document.createElement('article');
  element.className = 'card';
  const name = document.createElement('h2');
  name.textContent = plan.name;
  const price = document.createElement('p');
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(plan.cents / 100);
  price.textContent = `${amount} / ${plan.interval}`;
  const button = document.createElement('button');
  button.className = 'btn primary';
  button.textContent = plan.configured ? `Test ${plan.name} ${plan.interval === 'month' ? 'monthly' : 'annual'} checkout` :
    'Sandbox price pending';
  button.disabled = !plan.configured || !canSubscribe;
  button.addEventListener('click', () => action(async () => {
    location.assign((await api('checkout', { plan: plan.key })).url);
  }));
  element.append(name, price, button);
  return element;
}

async function refresh(returnState = null) {
  $('research').hidden = true;
  try {
    const current = await api('status');
    login.hidden = true;
    account.hidden = false;
    $('manage').hidden = !current.hasBillingAccount;
    const canSubscribe = ['none', 'canceled', 'incomplete_expired'].includes(current.status);
    $('plans').replaceChildren(...current.plans.map(plan => card(plan, canSubscribe)));
    if (current.tier !== 'free') {
      const research = await api('research');
      $('weekday').textContent = research.weekdayResearch;
      $('ai').textContent = research.aiResearch ?? '';
      $('ai').hidden = !research.aiResearch;
      $('research').hidden = false;
      const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(current.accessUntil));
      status.textContent = current.cancelAtPeriodEnd ? `Cancellation scheduled. Access through ${date}.` :
        `${current.tier === 'pro' ? 'Pro' : 'Premium'} access verified through ${date}.`;
    } else if (returnState === 'returned' || current.status === 'active' || current.status === 'incomplete') {
      status.textContent = 'Waiting for Stripe payment verification. Refresh status in a moment.';
    } else if (returnState === 'abandoned') {
      status.textContent = 'Checkout closed. You can resume the same plan.';
    } else {
      status.textContent = 'No verified subscription. Choose a plan or manage your existing billing.';
    }
  } catch (error) {
    if (error.status !== 401) throw error;
    account.hidden = true;
    login.hidden = false;
    status.textContent = 'Sign in with your sandbox access code.';
  }
}

async function action(task) {
  if (busy) return;
  busy = true;
  try {
    await task();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    busy = false;
  }
}

login.addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    await api('login', { token: $('token').value.trim() });
    login.reset();
    await refresh();
  });
});
$('manage').addEventListener('click', () => action(async () => {
  location.assign((await api('portal', {})).url);
}));
$('logout').addEventListener('click', () => action(async () => {
  await api('logout', {});
  await refresh();
}));
$('refresh').addEventListener('click', () => action(() => refresh()));
action(() => refresh(checkoutReturn));
