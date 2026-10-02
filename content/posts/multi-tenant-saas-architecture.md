---
template: 'post'
title: 'Designing Scalable Multi-Tenant SaaS Backends Supporting 300K+ Users'
date: '2021-01-15'
slug: 'multi-tenant-saas-architecture'
tags: ['saas', 'architecture', 'rest', 'docker', 'nginx']
categories: ['Engineering', 'Architecture']
description: 'Multi-domain tenant isolation, payment gateways (Stripe & Razorpay), and containerized deployments for 300K+ users.'
thumbnail: '../thumbnails/saas.png'
---

When scaling a B2B SaaS platform, multi-tenancy enables a single application instance to serve multiple corporate customers while ensuring strict data separation and custom domain routing.

At [Arobit Business Solutions Pvt Ltd](https://www.arobit.com/), we built a multi-tenant backend architecture serving over **300K+ registered users** and processing **50L+ INR monthly**.

In this post I want to go beyond the diagram and walk through the decisions that actually mattered: how a request finds its tenant, how tenant data stays isolated, and how billing works when money flows through two different payment gateways. Along the way I'll cover the trade-offs we weighed and the mistakes that are easy to make.

## Choosing a Tenancy Model

Before writing any routing code, you have to decide where the boundary between tenants lives in the database. There are three common models, and each one pushes complexity to a different place.

| Model | Isolation | Operational cost | Good fit |
| --- | --- | --- | --- |
| Database per tenant | Strongest; separate DBs, backups, and credentials | High; migrations and connections multiply with every tenant | Few, large, compliance-heavy customers |
| Schema per tenant | Strong; one DB, a Postgres schema (or MySQL database) per tenant | Medium; migrations must run N times, catalog bloat at scale | Tens to low hundreds of tenants |
| Shared tables with `tenant_id` | Logical; enforced by the application (and optionally RLS) | Low; one migration, one connection pool | Many small-to-mid tenants, fast onboarding |

The temptation is to pick "database per tenant" because it *feels* safest. In practice, once you have more than a handful of tenants, you end up running migrations in loops, juggling connection pools per database, and writing tooling just to answer "how many active users do we have across all customers?"

For a platform where tenants are onboarded frequently and most of them are small, shared tables with a `tenant_id` column are usually the pragmatic default. That's the "Row Context" in the diagram below. Keeping the door open for a scoped schema (or a dedicated database) for an unusually large or regulated customer is a sensible escape hatch, and the tenant-resolution layer is what makes that possible without touching business logic.

## Tenant Resolution & Routing

We solved custom domain mapping through dynamic NGINX proxy headers passed into our Node.js and Laravel middleware:

```
Request: customer1.platform.com OR customdomain.com
                    │
                    ▼
          NGINX (Reverse Proxy)
     Sets Host & X-Tenant-Domain
                    │
                    ▼
          Tenant Resolution Middleware
   (Lookup Tenant by Hostname in Redis Cache)
                    │
                    ▼
     Scoped Database Schema / Row Context
```

The key idea is that **the hostname is the tenant identifier**. Whether a customer uses `acme.platform.com` or their own `portal.acme.com`, the backend only ever sees a hostname and resolves it to a tenant record.

### NGINX: Wildcard Subdomains and Custom Domains

NGINX handles two cases: wildcard subdomains under the platform domain, and arbitrary custom domains that customers point at us via a CNAME.

```nginx
upstream app_backend {
    server app:3000;
    keepalive 32;
}

# 1. Wildcard subdomains: *.platform.com
server {
    listen 443 ssl http2;
    server_name ~^(?<tenant_slug>[a-z0-9-]+)\.platform\.com$;

    ssl_certificate     /etc/ssl/platform/wildcard.platform.com.crt;
    ssl_certificate_key /etc/ssl/platform/wildcard.platform.com.key;

    location / {
        proxy_set_header Host              $host;
        proxy_set_header X-Tenant-Domain   $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_pass http://app_backend;
    }
}

# 2. Custom domains: anything that doesn't match above
server {
    listen 443 ssl http2 default_server;
    server_name _;

    # Certificates for custom domains are issued per domain
    # (e.g. via an ACME client) and selected by SNI.
    ssl_certificate     /etc/ssl/custom/$ssl_server_name.crt;
    ssl_certificate_key /etc/ssl/custom/$ssl_server_name.key;

    location / {
        proxy_set_header Host              $host;
        proxy_set_header X-Tenant-Domain   $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_pass http://app_backend;
    }
}
```

A few notes from experience:

- **Always overwrite `X-Tenant-Domain` at the proxy.** If the client can send that header and NGINX passes it through untouched, anyone can impersonate another tenant. The application should only trust headers set by your own proxy.
- **Variables in `ssl_certificate`** (NGINX 1.15.9+) let you load certificates by SNI name, but they're read on every handshake, so keep the cert store on fast local disk. Many teams instead put a TLS-terminating layer with on-demand certificate issuance in front; either approach works as long as you verify domain ownership before issuing.
- **Verify custom domains before activating them.** We required the customer's domain to resolve to our ingress (CNAME check) before the domain was marked active in the tenants table.

### Tenant Resolution Middleware (Node.js + Redis)

Every request needs a tenant lookup, so it has to be cheap. A Redis cache keyed by hostname keeps the database out of the hot path:

```js
// middleware/resolveTenant.js
const Redis = require('ioredis');
const db = require('../db');

const redis = new Redis(process.env.REDIS_URL);
const TTL_SECONDS = 300;
const NEGATIVE_TTL_SECONDS = 30;

async function findTenantByHost(host) {
  const cacheKey = `tenant:host:${host}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached === 'null' ? null : JSON.parse(cached);

  const { rows } = await db.query(
    `SELECT t.id, t.slug, t.plan, t.status
       FROM tenant_domains d
       JOIN tenants t ON t.id = d.tenant_id
      WHERE d.hostname = $1 AND d.verified = true`,
    [host]
  );

  const tenant = rows[0] || null;
  // Cache misses too, so random hostnames can't hammer the DB.
  await redis.set(
    cacheKey,
    tenant ? JSON.stringify(tenant) : 'null',
    'EX',
    tenant ? TTL_SECONDS : NEGATIVE_TTL_SECONDS
  );
  return tenant;
}

module.exports = async function resolveTenant(req, res, next) {
  try {
    const host = String(req.get('x-tenant-domain') || req.hostname)
      .toLowerCase()
      .split(':')[0];

    const tenant = await findTenantByHost(host);
    if (!tenant) return res.status(404).json({ error: 'Unknown tenant' });
    if (tenant.status !== 'active') {
      return res.status(402).json({ error: 'Tenant suspended' });
    }

    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
};
```

Two details are easy to miss. First, **cache negative lookups** with a short TTL; otherwise a bot scanning random subdomains turns into a database load test. Second, **invalidate on write**: when a tenant changes plan, gets suspended, or adds a domain, delete the `tenant:host:*` keys for that tenant instead of waiting for the TTL to expire.

### The Laravel Side

On the Laravel services, the same idea lives in a middleware that binds the tenant into the container so models and services can read it:

```php
// app/Http/Middleware/ResolveTenant.php
public function handle(Request $request, Closure $next)
{
    $host = strtolower($request->header('X-Tenant-Domain', $request->getHost()));

    $tenant = Cache::remember("tenant:host:{$host}", 300, function () use ($host) {
        return Tenant::whereHas('domains', fn ($q) =>
            $q->where('hostname', $host)->where('verified', true)
        )->first();
    });

    abort_if(!$tenant, 404, 'Unknown tenant');

    app()->instance(Tenant::class, $tenant);

    return $next($request);
}
```

Combined with an Eloquent global scope that adds `where tenant_id = ?` to tenant-owned models, most queries become tenant-safe by default. Note that `Cache::remember` won't cache a `null` result in a useful way, so for production you'd want an explicit negative-cache entry, as in the Node version.

## Enforcing Isolation in the Database

Application-level scoping is necessary but not sufficient. One forgotten `where` clause in a report query, one raw SQL statement in a background job, and tenant A sees tenant B's invoices. If you're on PostgreSQL, **Row-Level Security (RLS)** gives you a second line of defense inside the database itself:

```sql
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
-- Apply policies even to the table owner (superusers still bypass RLS).
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

The application sets the tenant for each transaction:

```js
await client.query('BEGIN');
await client.query("SELECT set_config('app.tenant_id', $1, true)", [req.tenant.id]);
// ... tenant-scoped queries ...
await client.query('COMMIT');
```

The third argument `true` makes the setting **transaction-local**, which is critical when you use a connection pool (or PgBouncer in transaction mode). A session-level `SET` would leak the previous request's tenant onto whichever request picks up that connection next. If `app.tenant_id` isn't set at all, `current_setting(..., true)` returns `NULL`, the comparison is never true, and the query returns zero rows: a safe failure mode.

Things to keep in mind with RLS:

- **Your app role must not be a superuser** or have `BYPASSRLS`, otherwise policies are silently skipped.
- **Index `tenant_id`**, typically as the leading column of composite indexes (`(tenant_id, created_at)`), because every query now carries that predicate.
- **Cross-tenant jobs** (billing runs, analytics) should use a separate, explicitly privileged role so that bypassing isolation is a deliberate act, not an accident.

## Payment Processing Integration

Handling global and domestic billing across tenants required integrating both **Stripe** and **Razorpay** with automated webhook verification, recurring subscription state machines, and idempotent charge processing.

Why two gateways? Razorpay covers domestic Indian payment methods like UPI, netbanking, and RuPay well, while Stripe is the stronger choice for international cards and currencies. The cost is that you now have two sources of truth for "did this customer pay?", which is why the internal subscription model has to be gateway-agnostic.

### Verifying Webhook Signatures

Webhooks are how the gateway tells you a payment succeeded, failed, or was refunded. They're also an unauthenticated public endpoint unless you verify the signature. Both gateways sign the **raw request body**, so you must capture it before any JSON parser touches it.

```js
const express = require('express');
const crypto = require('crypto');
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

// Stripe: use the SDK helper on the raw body.
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.get('stripe-signature'),
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Invalid signature: ${err.message}`);
  }

  await handleEventOnce('stripe', event.id, event.type, event.data.object);
  res.sendStatus(200);
});

// Razorpay: HMAC-SHA256 of the raw body with the webhook secret.
router.post('/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');
  const received = req.get('x-razorpay-signature') || '';

  const valid =
    received.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!valid) return res.status(400).send('Invalid signature');

  const payload = JSON.parse(req.body.toString('utf8'));
  const eventId = req.get('x-razorpay-event-id');
  await handleEventOnce('razorpay', eventId, payload.event, payload.payload);
  res.sendStatus(200);
});
```

Use `crypto.timingSafeEqual` rather than `===` so the comparison doesn't leak timing information, and mount these routes **before** any global `express.json()` middleware, or the raw body will already be consumed.

### Idempotency: Processing Each Event Exactly Once

Gateways retry webhooks whenever they don't get a timely 2xx, and they can deliver the same event more than once even when you do respond. If "payment succeeded" extends a subscription by a month, processing it twice is a real money bug.

The simplest robust pattern is a table with a unique constraint on the event ID:

```sql
CREATE TABLE processed_webhook_events (
  provider     text        NOT NULL,
  event_id     text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
```

```js
async function handleEventOnce(provider, eventId, type, data) {
  await db.tx(async (tx) => {
    const { rowCount } = await tx.query(
      `INSERT INTO processed_webhook_events (provider, event_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [provider, eventId]
    );
    if (rowCount === 0) return; // already handled

    await applyBillingEvent(tx, provider, type, data);
  });
}
```

Because the insert and the business update share a transaction, a crash halfway through rolls both back and the retry succeeds cleanly. The same principle applies in the other direction: when *we* create a charge, we pass an idempotency key so a network retry doesn't double-charge.

```js
await stripe.paymentIntents.create(
  { amount, currency, customer: customerId },
  { idempotencyKey: `invoice-${invoiceId}-attempt-${attempt}` }
);
```

### The Subscription State Machine

Rather than scattering `if (status === 'active')` checks everywhere, we modeled subscriptions as an explicit state machine. Both gateways' events are mapped to the same internal transitions.

```
 trialing ──► active ──► past_due ──► canceled
               │           │
               │           └── payment recovered ──► active
               └──► paused ──► resumed ──► active

 trialing, active and paused can also move directly to canceled
```

```js
const TRANSITIONS = {
  trialing: ['active', 'canceled'],
  active:   ['past_due', 'paused', 'canceled'],
  past_due: ['active', 'canceled'],
  paused:   ['active', 'canceled'],
  canceled: [],
};

function transition(subscription, next) {
  const allowed = TRANSITIONS[subscription.status] || [];
  if (!allowed.includes(next)) {
    throw new Error(`Illegal transition ${subscription.status} -> ${next}`);
  }
  return { ...subscription, status: next, status_changed_at: new Date() };
}
```

An explicit transition table pays off in two ways. Out-of-order webhooks (a "payment failed" arriving after a later "payment succeeded") get rejected or logged instead of silently corrupting state, and the tenant-resolution middleware has exactly one field to check when deciding whether a tenant's users can log in.

## Containerized Deployments

Every service (the Node.js API, the Laravel app, queue workers, and NGINX) ran as a Docker container built from the same images in every environment. For multi-tenancy, the important property is that **the application is stateless with respect to tenants**: any container can serve any tenant because tenant context comes from the request, not from the process. That's what lets you scale horizontally by adding containers rather than by provisioning per-customer infrastructure.

## Common Pitfalls

- **Trusting client-supplied tenant headers.** Always set them at the proxy.
- **Session-level `SET` with pooled connections.** Use transaction-local settings, or you'll leak tenant context across requests.
- **Caching without tenant in the key.** A cache key like `dashboard:stats` will happily serve one tenant's numbers to another. Prefix everything with the tenant ID.
- **Background jobs losing tenant context.** Queue payloads must carry `tenant_id` explicitly; workers have no hostname to resolve.
- **Parsing JSON before verifying webhooks.** Signature checks fail (or worse, get skipped) once the raw body is gone.
- **Unique constraints without `tenant_id`.** `UNIQUE (email)` blocks the same person from belonging to two tenants; you usually want `UNIQUE (tenant_id, email)`.

## Key Takeaways

1. Pick the tenancy model based on tenant count and compliance needs; shared tables with `tenant_id` scale best operationally.
2. Treat the hostname as the tenant identifier, resolve it once per request, and cache aggressively (including misses).
3. Back application scoping with database enforcement such as Postgres RLS.
4. Verify every webhook against the raw body and deduplicate by event ID inside a transaction.
5. Model subscriptions as an explicit state machine that is independent of any one payment gateway.

## Conclusion

Multi-tenancy is less about one clever trick and more about making tenant context impossible to lose: from NGINX, through middleware, into the database session, and all the way to the payment webhook that keeps a customer's account active. Getting those layers right is what allowed a single platform to serve 300K+ users and process 50L+ INR monthly without each new customer adding operational weight.
