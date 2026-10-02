---
template: 'post'
title: 'Database Connection Pooling and High-Concurrency Handling in Node.js'
date: '2023-07-14'
slug: 'database-connection-pooling-concurrency'
series: 'PostgreSQL Performance & Indexing'
tags: ['postgresql', 'node', 'database', 'performance', 'backend']
categories: ['Engineering', 'Databases']
description: 'Configuring PgBouncer and node-postgres connection pools to prevent connection starvation under massive traffic spikes.'
thumbnail: '../thumbnails/postgres.png'
---

Under sudden traffic bursts, Node.js applications that create database connections on the fly can quickly exhaust PostgreSQL `max_connections`, leading to cascading gateway timeouts.

Here are the best practices we used to keep database connections stable and resilient under heavy concurrent loads.

## Why Connections Are the Bottleneck

It's easy to think of a database connection as a cheap socket. In PostgreSQL it isn't. Every connection is a dedicated **backend process** on the server, with its own memory for sorting, hashing, and caches. Opening one involves a TCP handshake, TLS negotiation, authentication, and forking that process, which adds up to milliseconds of work before a single query runs.

That has two consequences:

1. **Connection setup is expensive**, so creating a connection per request adds latency and CPU load exactly when you can least afford it.
2. **Many connections hurt throughput.** Past a certain point, more concurrent backends don't mean more work done; they compete for CPU, locks, and memory, and overall throughput drops while latency climbs.

Node.js makes this easy to get wrong. Because it's non-blocking, a single process can have thousands of in-flight requests, and every one of them would happily open a connection if you let it. Multiply that by horizontal scaling (say 30 pods, each with a pool of 20) and you're asking for 600 connections from a server whose default `max_connections` is 100. During a spike, new connections are rejected with `sorry, too many clients already`, requests time out at the load balancer, clients retry, and the retries make it worse.

The fix is a layered approach: a small, well-behaved pool in each Node.js process, a connection pooler in front of PostgreSQL, and protective logic that fails fast instead of piling up.

```text
 Node.js pods (many)          PgBouncer               PostgreSQL
 ┌──────────────┐
 │ pg.Pool (20) │──┐
 └──────────────┘  │     ┌──────────────────┐     ┌────────────────────┐
 ┌──────────────┐  ├────▶│ thousands of     │────▶│ 50–100 backend     │
 │ pg.Pool (20) │──┤     │ client conns     │     │ processes          │
 └──────────────┘  │     └──────────────────┘     └────────────────────┘
 ┌──────────────┐  │
 │ pg.Pool (20) │──┘
 └──────────────┘
```

## Architecture & Configuration

1. **PgBouncer in Transaction Pooling Mode**:
   Allows thousands of client connections to share a small pool of 50–100 actual PostgreSQL backend processes.

2. **Pool Tuning in Node.js**:
```javascript
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20, // Max clients in local process pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

3. **Circuit Breakers**:
   Implementing graceful backoff and read-replica fallbacks when primary pool latency crosses established thresholds.

Let's dig into each layer.

## Layer 1: PgBouncer in Transaction Mode

PgBouncer is a lightweight proxy that speaks the PostgreSQL protocol. Applications connect to it as if it were the database, and it multiplexes those client connections onto a much smaller set of real server connections.

It has three pooling modes:

| Mode | Server connection is returned to the pool… | Good for |
| --- | --- | --- |
| `session` | when the client disconnects | Legacy apps relying on session state |
| `transaction` | when the transaction ends | Most web/API workloads |
| `statement` | after every statement | Autocommit-only workloads; multi-statement transactions are disallowed |

Transaction mode is the sweet spot for an API. A request typically holds a server connection for a few milliseconds of actual work, so a pool of 50 backends can serve a very large number of clients.

### A starting `pgbouncer.ini`

```ini
[databases]
appdb = host=10.0.0.5 port=5432 dbname=appdb

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432

auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt

pool_mode = transaction

; Client side: how many app connections PgBouncer will accept
max_client_conn = 5000

; Server side: real PostgreSQL connections per (database, user) pair
default_pool_size = 50
min_pool_size = 10
reserve_pool_size = 10
reserve_pool_timeout = 3

; Fail clients that wait too long instead of queueing forever
query_wait_timeout = 15

; Recycle server connections periodically
server_idle_timeout = 600
server_lifetime = 3600

; Some drivers send this startup parameter; let it through
ignore_startup_parameters = extra_float_digits
```

The key relationship is that `max_client_conn` can be large because client connections to PgBouncer are cheap, while `default_pool_size` (plus `reserve_pool_size`) must stay comfortably under PostgreSQL's `max_connections`, leaving headroom for migrations, admin sessions, and replication.

### Sizing the server pool

A common rule of thumb for the number of *active* backend connections is roughly:

```text
connections ≈ (CPU cores × 2) + effective disk spindles
```

It's only a starting point, but it makes the important point: the right number is tied to the hardware, not to your traffic. If the database has 16 cores, a few dozen active connections will usually saturate it. Beyond that, extra connections just queue inside PostgreSQL instead of inside PgBouncer, where they're far cheaper to hold.

### The transaction-mode gotchas

Transaction pooling has a cost: **session state doesn't survive between transactions**, because your next transaction may run on a different server connection. Things that break or misbehave:

- **`SET` statements** (e.g. `SET search_path`, `SET statement_timeout`) leak onto whatever client next gets that backend. Use `SET LOCAL` inside a transaction, or set defaults at the role/database level with `ALTER ROLE ... SET`.
- **Named prepared statements.** node-postgres only uses named prepared statements when you pass a `name` in the query config. Parameterized queries without a name use the unnamed statement and work fine. If you do need named statements, newer PgBouncer releases (1.21+) can track protocol-level prepared statements via `max_prepared_statements`; on older versions, avoid them.
- **Session advisory locks** (`pg_advisory_lock`). Use `pg_advisory_xact_lock` instead, which is released at transaction end.
- **`LISTEN`/`NOTIFY`**, temporary tables, and `WITH HOLD` cursors. Route these through a direct connection or a separate session-mode pool.

For things like migrations and `LISTEN`, I keep a second, small connection string that bypasses PgBouncer (or points to a session-mode pool). Mixing the two concerns is what usually causes the strange bugs.

## Layer 2: The node-postgres Pool

Even with PgBouncer, each Node.js process should use a bounded pool. The pool caps how much concurrency one process can push downstream and reuses connections to PgBouncer instead of reconnecting per request.

### What the settings mean

- **`max: 20`**: the most connections this process will open. Requests beyond that queue *inside the process*. Remember the multiplication: total client connections = pods × `max`. That number must fit in `max_client_conn`.
- **`idleTimeoutMillis: 30000`**: close connections idle for 30 seconds, so a quiet pod gives connections back.
- **`connectionTimeoutMillis: 2000`**: if no connection is available within 2 seconds, fail with an error. This is the most important setting on the list. Without it, `pool.connect()` waits indefinitely, and under load requests pile up in memory until the gateway times them out anyway.

I also add server-side guards so a single bad query can't hold a connection forever:

```javascript
const pool = new Pool({
  // ...connection settings as above
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000, // server cancels statements running longer than 5s
  query_timeout: 6000, // client-side timeout as a backstop
  idle_in_transaction_session_timeout: 10000, // kill sessions stuck mid-transaction
  application_name: 'api-service',
});
```

Note that `statement_timeout` is sent as a startup parameter. If you're behind PgBouncer and it rejects unknown startup parameters, either add it to `ignore_startup_parameters` or set it on the role with `ALTER ROLE app_user SET statement_timeout = '5s'`.

### Handle pool errors, always

An idle client can lose its connection (a PgBouncer restart, a network blip, a failover). node-postgres emits that as an `error` event on the pool, and an unhandled `error` event crashes the Node.js process.

```javascript
pool.on('error', (err) => {
  // The broken client is removed from the pool automatically.
  logger.error({ err }, 'Idle PostgreSQL client error');
});

pool.on('connect', (client) => {
  metrics.increment('db.pool.connect');
});
```

### Always release clients

Using `pool.query()` checks out and releases a client automatically. Transactions need a dedicated client, and forgetting to release it is the classic leak that slowly starves the pool.

```javascript
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
```

If a client hit a connection-level error, call `client.release(err)` (or `client.release(true)`) instead, which destroys it rather than returning a broken connection to the pool.

### Watch the pool

`pg.Pool` exposes `totalCount`, `idleCount`, and `waitingCount`. `waitingCount` is the early-warning signal: when it's consistently above zero, requests are queueing for a connection, and latency will follow.

```javascript
setInterval(() => {
  metrics.gauge('db.pool.total', pool.totalCount);
  metrics.gauge('db.pool.idle', pool.idleCount);
  metrics.gauge('db.pool.waiting', pool.waitingCount);
}, 5000);
```

On the PgBouncer side, `SHOW POOLS;` on the admin console shows `cl_waiting` and `maxwait`, the same signal one layer down.

## Layer 3: Circuit Breakers and Load Shedding

Pools and timeouts stop the database from being overwhelmed, but they don't stop the application from hammering a database that's already struggling. That's the job of a circuit breaker: after enough failures or timeouts, stop sending traffic for a while, serve a fallback, and periodically let a test request through to see if things have recovered.

With [opossum](https://github.com/nodeshift/opossum):

```javascript
const CircuitBreaker = require('opossum');

const readFromPrimary = (sql, params) => primaryPool.query(sql, params);

const breaker = new CircuitBreaker(readFromPrimary, {
  timeout: 3000, // treat calls slower than 3s as failures
  errorThresholdPercentage: 50, // open when half of recent calls fail
  volumeThreshold: 20, // ...but only after at least 20 calls in the window
  resetTimeout: 10000, // try a half-open request after 10s
});

// While open, serve reads from the replica instead
breaker.fallback((sql, params) => replicaPool.query(sql, params));

breaker.on('open', () => logger.warn('Primary read circuit OPEN'));
breaker.on('halfOpen', () => logger.info('Primary read circuit HALF-OPEN'));
breaker.on('close', () => logger.info('Primary read circuit CLOSED'));

async function readQuery(sql, params) {
  return breaker.fire(sql, params);
}
```

A few decisions behind this:

- **Only reads fall back.** A read replica may lag slightly, which is acceptable for dashboards and listings but not for anything that reads its own writes. Writes don't get a fallback; they fail fast with a clear error and let the client retry with backoff.
- **`volumeThreshold` prevents flapping.** Without it, two failures out of three calls during a quiet period would open the circuit.
- **Shed load early.** When the pool queue is already long, waiting just converts a fast failure into a slow one. Returning `503` with a `Retry-After` header is kinder to both the database and the user.

```javascript
app.use('/api', (req, res, next) => {
  if (primaryPool.waitingCount > 50) {
    res.set('Retry-After', '2');
    return res.status(503).json({ error: 'Service busy, please retry' });
  }
  next();
});
```

On the client side, retries should use **exponential backoff with jitter**, otherwise every client retries at the same instant and recreates the spike that caused the problem.

## Graceful Shutdown

During deploys and autoscaling, pods are terminated constantly. Draining the pool on `SIGTERM` avoids cutting queries off mid-flight and leaving dangling connections on PgBouncer:

```javascript
process.on('SIGTERM', async () => {
  server.close(); // stop accepting new requests
  await pool.end(); // wait for checked-out clients, then close all connections
  process.exit(0);
});
```

## Checklist

- [ ] Every process uses a bounded `pg.Pool`, never a new `Client` per request.
- [ ] `connectionTimeoutMillis` is set so waiting for a connection fails fast.
- [ ] `pods × max` fits within PgBouncer's `max_client_conn`.
- [ ] PgBouncer's server pool stays well under PostgreSQL's `max_connections`.
- [ ] No session state (`SET`, session advisory locks, `LISTEN`, named prepared statements) is relied on through transaction-mode pooling.
- [ ] `statement_timeout` and `idle_in_transaction_session_timeout` are set.
- [ ] A `pool.on('error')` handler is registered.
- [ ] Transaction clients are released in `finally`.
- [ ] `waitingCount` and PgBouncer's `cl_waiting` are monitored and alerted on.
- [ ] Reads have a circuit breaker with a replica fallback; writes fail fast.
- [ ] Pools are drained on `SIGTERM`.

## Conclusion

Connection exhaustion rarely comes from a single bad setting. It's what happens when unbounded concurrency in the application meets a hard limit in the database with nothing in between. Bounding concurrency at every layer (the per-process pool, PgBouncer's server pool, and a circuit breaker in front of it all) turns a cascading outage into a short period of degraded, but still working, service. Getting there is mostly configuration, and it's worth doing before the traffic spike rather than during it.
