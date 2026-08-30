# Billing

meamus ships with a stub provider so the paid path is testable without a
payment account. `POST /api/billing/checkout` upgrades the account immediately
and returns the updated user. Everything gated on Pro — the APK export and the
higher quota — works end to end.

The rest of the app only ever reads `user.plan`. Swapping providers means
implementing two functions.

## Switching to Stripe

### 1. Configure

```bash
# .env
BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PRICE_ID=price_...        # a recurring price for the Pro plan
STRIPE_WEBHOOK_SECRET=whsec_...
```

`npm install stripe`

### 2. Create the checkout session

In `server/routes/billing.routes.js`, replace the `501` in the
`config.billing.provider === 'stripe'` branch:

```js
const stripe = require('stripe')(config.billing.stripeSecretKey);

const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: config.billing.stripePriceId, quantity: 1 }],
  customer_email: req.user.email,
  // The webhook needs to know which meamus account to upgrade.
  client_reference_id: req.user.id,
  success_url: `${req.protocol}://${req.get('host')}/#/library?upgraded=1`,
  cancel_url: `${req.protocol}://${req.get('host')}/#/pricing`
});

return res.json({ checkoutUrl: session.url, upgraded: false, provider: 'stripe' });
```

The frontend already redirects when the response carries `checkoutUrl`
(`changePlan()` in `public/app.js`), so no client change is needed.

### 3. Handle the webhook

The webhook is what actually grants the plan. Never upgrade from the success
URL — the user controls their browser, not your billing state.

Stripe signs the **raw** body, so this route needs the raw parser mounted
before `express.json()` in `server/index.js`:

```js
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handler);
```

Then, in the handler:

```js
let event;
try {
  event = stripe.webhooks.constructEvent(
    req.body,
    req.get('stripe-signature'),
    config.billing.stripeWebhookSecret
  );
} catch (err) {
  return res.status(400).json({ error: `Signature verification failed: ${err.message}` });
}

switch (event.type) {
  case 'checkout.session.completed': {
    const session = event.data.object;
    db.update('users', session.client_reference_id, {
      plan: 'pro',
      billing: {
        provider: 'stripe',
        customerId: session.customer,
        subscriptionId: session.subscription,
        since: new Date().toISOString()
      }
    });
    break;
  }
  case 'customer.subscription.deleted':
  case 'invoice.payment_failed': {
    const user = db.find('users', (u) => u.billing && u.billing.customerId === event.data.object.customer);
    if (user) db.update('users', user.id, { plan: 'free' });
    break;
  }
  default:
    break;
}

res.json({ received: true });
```

Register the endpoint in the Stripe dashboard for
`checkout.session.completed`, `customer.subscription.deleted` and
`invoice.payment_failed`.

### 4. Test locally

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook
stripe trigger checkout.session.completed
```

## Changing what Pro unlocks

Plans are declared in `PLANS` in `server/routes/billing.routes.js`; quotas come
from `FREE_DAILY_GENERATIONS` / `PRO_DAILY_GENERATIONS`. To gate another route,
add `requirePlan('pro')` to it — that is the whole mechanism.

## Adding a tier

1. Add the plan object to `PLANS`.
2. Add its quota to `config.quotas` in `server/config.js`.
3. Add a price id to `.env`.

The pricing page renders whatever `GET /api/billing/plans` returns, so no
frontend change is needed.
