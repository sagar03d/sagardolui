---
template: 'post'
title: 'Architecting Scalable EdTech Systems for 60K+ Monthly Active Users'
date: '2024-02-18'
slug: 'architecting-scalable-edtech-platforms'
series: 'Architecting Scalable EdTech Systems'
tags: ['edtech', 'architecture', 'node', 'gcp', 'websockets']
categories: ['Engineering', 'Architecture']
description: 'How we designed, migrated, and scaled an EdTech backend to achieve 99.99% uptime for over 60,000 active students and faculty.'
thumbnail: '../thumbnails/node.png'
---

Scaling an educational technology platform presents unique architectural challenges. Unlike typical e-commerce traffic where requests are distributed throughout the day, EdTech traffic features massive peak concurrency spikes during live classroom schedules and exam periods.

A class that starts at 10:00 AM doesn't ramp up gently. Hundreds of students and tutors hit "Join" within the same minute, every one of them opening a WebSocket, fetching a schedule, validating a session token and pulling course material. Ten minutes later the load drops off a cliff, only to spike again at the top of the next hour. Exam windows are worse: the traffic is just as bursty, and the tolerance for failure is close to zero, because a dropped connection during a timed test is a support ticket, an angry parent, and sometimes a re-exam.

In this article, I share the architectural decisions and engineering practices we implemented to maintain **99.99% uptime** for over 60K+ monthly active users. I'll cover not just *what* we built, but *why* we chose it, which alternatives we passed on, and the mistakes that taught us the most.

## Understanding the Traffic Shape First

Before touching infrastructure, it's worth being precise about what "scale" means for your product. For us, monthly active users was the headline number, but it was the wrong number to design around. What actually mattered was:

| Metric | Why it matters |
| --- | --- |
| Peak concurrent connections | Sizes the WebSocket tier and file-descriptor limits |
| Requests per second at the top of the hour | Sizes the REST tier and the database connection pool |
| Write bursts (attendance, submissions) | Drives database IOPS and lock contention |
| Session length | Determines how long sockets stay open and how much memory they hold |

The lesson here is that a platform with modest MAU can still have a punishing peak-to-average ratio. Design for the peak, autoscale for the average.

## The Architecture Overview

Our backend ecosystem consists of decoupled microservices written in **Node.js (TypeScript)** and **Laravel (PHP)**, containerized with **Docker** and deployed on **Google Cloud Platform (GCP)**.

```
Client (Web / Mobile)
        │
   Cloud Load Balancing (NGINX + SSL)
        │
   ┌────┴─────────────────────────────┐
   ▼                                  ▼
Node.js Real-time Service     Laravel Core REST API
(WebSockets / Analytics)      (Auth, Billing, Scheduling)
   │                                  │
   ├──────────────┬───────────────────┤
   ▼              ▼                   ▼
Cloud SQL      Redis Cache         GCS Storage
(PostgreSQL)   (Pub/Sub & Sessions)
```

### Why two runtimes?

A fair question is why we didn't standardise on a single language. The honest answer is that each service plays to its runtime's strengths:

- **Laravel** is excellent for the transactional, CRUD-heavy core: authentication, billing, scheduling, admin panels. Its ORM, queues, validation and migrations let the team move fast on business logic where correctness matters more than raw concurrency.
- **Node.js** shines at holding thousands of mostly idle, long-lived connections on a single event loop. That's exactly the profile of a live classroom: lots of sockets, small frequent messages, very little CPU per message.

Splitting along this line also gave us **failure isolation**. If a bad deploy or a slow query degrades the REST API, students already in a live class keep their real-time connection. If the socket tier is under pressure, billing and scheduling are unaffected. The trade-off is operational: two build pipelines, two sets of dependencies and a shared contract (session tokens, event schemas) that both sides must respect.

## Key Engineering Pillars

### 1. High-Availability Cloud Infrastructure

We migrated our core compute workloads to GCP utilizing **Compute Engine managed instance groups** with autoscaling and **Cloud SQL for PostgreSQL** configured with high availability (HA) regional failover.

**Why managed instance groups over Kubernetes?** We evaluated GKE. For a team of our size, the operational surface of Kubernetes (cluster upgrades, networking, RBAC, Helm charts) was a real cost, while our service count was small enough that MIGs with container-optimised images covered our needs: autohealing, rolling updates and autoscaling, all managed by GCP.

A few configuration details made a big difference:

- **Autohealing health checks** that hit a real `/health` endpoint (not just a TCP check), so instances with a wedged event loop or a lost database connection get recycled.
- **Regional (multi-zone) instance groups**, so a single zone outage doesn't take out a tier.
- **Scheduled scaling ahead of class times.** Reactive CPU-based autoscaling is too slow for top-of-the-hour spikes: by the time new instances are booted and healthy, the spike is already underway. Pre-warming capacity a few minutes before known peaks is far more effective.

A minimal health endpoint for the Node service looks like this:

```typescript
import express from 'express';
import { Pool } from 'pg';
import { createClient } from 'redis';

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

app.get('/health', async (_req, res) => {
  try {
    await Promise.all([pool.query('SELECT 1'), redis.ping()]);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: (err as Error).message });
  }
});
```

On the database side, Cloud SQL HA keeps a standby in a second zone with synchronous replication. Failover takes time (typically on the order of a minute), and during that window connections drop. That means **every service must reconnect gracefully**: connection pools with retry and backoff, and request handlers that fail fast rather than hang.

### 2. State Synchronization with WebSockets

For real-time classroom telemetry, tutor presence, and live student attendance, we implemented a dedicated Node.js WebSocket cluster with Redis Pub/Sub backplane. This decoupled live events from transactional database operations.

The core problem with scaling WebSockets horizontally is that a student in Room A might be connected to instance 1 while the tutor is connected to instance 3. Without a backplane, a broadcast from the tutor never reaches the student. With Socket.IO, the Redis adapter solves this by publishing every room broadcast to Redis, where all instances are subscribed:

```typescript
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') },
  pingInterval: 25000,
  pingTimeout: 20000,
});

const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
await Promise.all([pubClient.connect(), subClient.connect()]);
io.adapter(createAdapter(pubClient, subClient));

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  const user = await verifySessionToken(token); // validated against the shared session store
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  socket.on('class:join', async ({ classId }) => {
    await socket.join(`class:${classId}`);
    socket.to(`class:${classId}`).emit('presence:joined', { userId: socket.data.user.id });
  });
});

httpServer.listen(3000);
```

Decisions worth calling out:

- **Sticky sessions at the load balancer.** Socket.IO's HTTP long-polling fallback requires that all requests for a session land on the same instance. We enabled session affinity at the load balancer; if you can guarantee WebSocket-only transport, you can drop this requirement.
- **Don't write every event to Postgres.** Presence updates and telemetry are high-frequency and mostly ephemeral. We keep them in Redis and flush aggregated records (for example, final attendance) to Postgres in batches. Writing every heartbeat to the primary database is one of the fastest ways to turn a socket spike into a database outage.
- **Authenticate at the handshake, not per message.** Validating once on connect keeps the per-message path cheap.

**Alternatives we considered:** a managed real-time service (simpler to run, but per-connection pricing and less control over event semantics) and raw `ws` with a hand-rolled Redis fan-out (leaner, but we'd have rebuilt rooms, reconnection and acknowledgements ourselves). Socket.IO plus the Redis adapter was the pragmatic middle ground.

### 3. Caching Boundaries

Redis also serves as our cache and session store, and drawing clear caching boundaries mattered as much as the cache itself. Our rule of thumb: **cache reads that are hot, shared and tolerant of slight staleness** (timetables, course metadata, feature flags), and **never cache anything authoritative for money or grades**.

A common pitfall is the cache stampede: a popular key expires right at the top of the hour and hundreds of requests hit the database at once. Short-lived locks or staggered TTLs with a little random jitter go a long way:

```php
// Laravel: cache today's timetable, with only one request rebuilding it on a miss
$timetable = Cache::lock("timetable:{$schoolId}:lock", 10)->block(5, function () use ($schoolId) {
    return Cache::remember(
        "timetable:{$schoolId}",
        now()->addMinutes(10)->addSeconds(random_int(0, 60)),
        fn () => Timetable::forSchool($schoolId)->today()->get()
    );
});
```

### 4. Protecting the Database

PostgreSQL was our ultimate bottleneck, so we treated database connections as a scarce resource. Each Node instance runs a bounded `pg` pool, and the total number of connections across all instances at maximum autoscale must stay under the Cloud SQL `max_connections` limit, with headroom for migrations and admin access. It's easy to forget that autoscaling the app tier silently multiplies your connection count.

```typescript
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                       // per instance; multiply by max instances when sizing
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000, // fail fast instead of queueing forever
  statement_timeout: 10000,      // kill runaway queries
});
```

Alongside this, read-heavy reporting queries were moved off the primary, and slow-query logging was enabled so regressions surfaced before they caused incidents.

### 5. Automated Monitoring & 99.99% SLA

By leveraging health checks, structured JSON logging, and Prometheus/Grafana alerting, our team eliminated single points of failure and brought downtime to virtually zero.

It helps to remember what 99.99% means in practice: roughly **4.3 minutes of downtime per month**. You cannot hit that with humans watching dashboards. It requires automated recovery (autohealing, HA failover) and alerts that fire on symptoms users actually feel.

What we instrumented:

- **Structured JSON logs** with a request ID propagated from the load balancer through both services, so a single failed "Join class" can be traced end to end.
- **RED metrics** (Rate, Errors, Duration) per endpoint, plus socket-specific gauges: active connections, connections per room, and Redis Pub/Sub latency.
- **Alerts on symptoms, not causes.** "p95 latency on `/api/schedule` above threshold for 5 minutes" is actionable; "CPU at 80%" often isn't.

```typescript
import client from 'prom-client';

client.collectDefaultMetrics();

export const activeSockets = new client.Gauge({
  name: 'ws_active_connections',
  help: 'Currently open WebSocket connections',
});

io.on('connection', (socket) => {
  activeSockets.inc();
  socket.on('disconnect', () => activeSockets.dec());
});
```

## Lessons Learned the Hard Way

- **Reconnect storms are real.** When a socket instance restarts, every client it held reconnects at once. Clients should reconnect with exponential backoff and jitter (Socket.IO's client supports `reconnectionDelay` and `randomizationFactor`), or a single restart can cascade.
- **Graceful shutdown matters during deploys.** Instances should stop accepting new connections, let the load balancer drain them, and close sockets cleanly before exiting. Otherwise every rolling deploy looks like a mini outage.
- **Load test the peak, not the average.** Synthetic tests that ramp slowly over 30 minutes will pass. Tests that open thousands of connections in 60 seconds reveal the real limits: file descriptors, connection pools and slow handshakes.
- **Keep the real-time path independent of the REST path.** Any synchronous call from the socket tier to the REST API couples their failure modes again.

## Key Takeaways Checklist

- [ ] Design around peak concurrency, not MAU.
- [ ] Separate real-time and transactional workloads so they fail independently.
- [ ] Use multi-zone instance groups with meaningful health checks and autohealing.
- [ ] Pre-scale ahead of known traffic peaks; don't rely on reactive autoscaling alone.
- [ ] Use a Redis backplane for horizontally scaled WebSockets, and keep ephemeral events out of Postgres.
- [ ] Cap database connections per instance and size against maximum autoscale.
- [ ] Add jitter to cache TTLs and client reconnects.
- [ ] Alert on user-facing symptoms and automate recovery.

## Conclusion

Architecting for scale requires proactive load isolation, smart caching boundaries, and resilient failover mechanisms. With the right foundation, platforms can easily handle rapid user growth without performance degradation.

None of the individual techniques here is exotic. What made the difference for us was applying them deliberately to the shape of EdTech traffic: short, intense spikes, long-lived connections and very little tolerance for failure at exactly the moments that matter most. If you're building something similar, start by measuring your peak, isolate the parts that must never go down, and let automation, not people, handle recovery.
