---
template: 'post'
title: 'Building Real-Time Faculty & Student Analytics Dashboards with WebSockets & React'
date: '2022-08-20'
slug: 'real-time-dashboards-with-websockets-react'
tags: ['react', 'websockets', 'javascript', 'frontend']
categories: ['Engineering', 'Frontend']
description: 'Architecting low-latency, event-driven web dashboards for live classroom monitoring and instant student analytics.'
thumbnail: '../thumbnails/websockets.png'
---

Real-time visibility into student engagement, attendance, and session progression is vital for instructors and operations teams in EdTech.

When a class is live, "a few minutes ago" is too late. If a student drops off the call, if half the room hasn't answered a poll, or if a faculty member's session is running over and the next one is about to collide with it, the people watching the dashboard need to know *now* — not on the next page refresh.

In this article, I discuss designing real-time analytics dashboards in **React.js** powered by a **WebSocket** streaming layer and **Redis Pub/Sub**. I'll walk through the transport decision, the server setup, the React side, and the mistakes I made along the way.

## Why Not Just Poll?

The first version of almost every "live" dashboard is a `setInterval` that hits a REST endpoint every few seconds. It works, and for a while it's honestly fine. The problems show up as usage grows:

- **Wasted work**: most polls return "nothing changed", but each one still costs a request, an auth check, and usually a database query.
- **Latency floor**: with a 5-second interval, the average delay is ~2.5 seconds and the worst case is a full 5 — no matter how fast your backend is.
- **Thundering herds**: many open dashboards polling on similar intervals turns into synchronized load spikes against the same queries.

So I looked at the three realistic options:

| Approach | Direction | Latency | Infra complexity | Good fit for |
| --- | --- | --- | --- | --- |
| Short polling | Client → server | Interval-bound | Lowest | Low-frequency data, simple admin pages |
| Server-Sent Events (SSE) | Server → client | Low | Low (plain HTTP) | One-way feeds, notifications |
| WebSockets (Socket.io) | Bidirectional | Low | Higher (stateful connections) | Interactive, room-based, two-way flows |

SSE is genuinely underrated, and if the dashboard were strictly read-only I'd consider it seriously. What tipped me toward WebSockets via **Socket.io** was:

1. **Bidirectional needs**: dashboards weren't purely passive — faculty could acknowledge alerts, request snapshots, and switch which session they were watching without reconnecting.
2. **Rooms**: Socket.io's room abstraction maps perfectly onto "everyone watching session X".
3. **Built-in reconnection and acknowledgements**, which I'd otherwise have to rebuild on top of SSE or raw WebSockets.

The trade-off is that WebSocket connections are stateful and long-lived, which affects load balancing, auth, and horizontal scaling. Most of the rest of this post is about handling those trade-offs.

## High-Level Architecture

The shape of the system looks like this:

```text
 Class events (joins, leaves,          ┌──────────────┐
 polls, activity, session state) ───▶  │ API / Workers │
                                       └──────┬───────┘
                                              │ publish
                                              ▼
                                       ┌──────────────┐
                                       │    Redis     │  (Pub/Sub via Socket.io adapter)
                                       └──────┬───────┘
                         ┌────────────────────┼────────────────────┐
                         ▼                    ▼                    ▼
                  ┌────────────┐       ┌────────────┐       ┌────────────┐
                  │ Socket node│       │ Socket node│       │ Socket node│
                  └─────┬──────┘       └─────┬──────┘       └─────┬──────┘
                        ▼                    ▼                    ▼
                  React dashboards (each joined to rooms like session:<id>)
```

The key idea: **the services that produce events don't need to know which socket server a given dashboard is connected to.** They publish to Redis, and every socket node delivers to whichever of its local clients are in the matching room.

## Server Side: Socket.io with the Redis Adapter

A single Node process can hold a lot of connections, but the moment you run more than one instance (for availability, or behind a load balancer), a `io.to(room).emit()` on instance A won't reach a client connected to instance B. The Redis adapter solves this by propagating broadcasts across all nodes.

```javascript
// server/socket.js
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: { origin: process.env.DASHBOARD_ORIGIN, credentials: true },
  pingInterval: 25000, // heartbeat cadence
  pingTimeout: 20000,  // how long to wait for a pong before considering the client gone
});

const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();

await Promise.all([pubClient.connect(), subClient.connect()]);
io.adapter(createAdapter(pubClient, subClient));

httpServer.listen(process.env.PORT || 4000);

export { io };
```

Two notes from running this in practice:

- **Sticky sessions matter** if you allow the HTTP long-polling transport. Socket.io starts with polling by default and upgrades to WebSocket; the polling requests must hit the same node. Either enable sticky sessions at the load balancer or restrict clients to `transports: ['websocket']`.
- The subscriber connection must be a **separate** Redis client — a connection in subscribe mode can't issue regular commands. That's why we `duplicate()`.

### Authenticating the Handshake

Long-lived connections are easy to forget about from a security standpoint. I authenticate once, at handshake time, using namespace middleware, and authorize room membership explicitly.

```javascript
// server/telemetry-namespace.js
import jwt from 'jsonwebtoken';
import { io } from './socket.js';
import { canViewSession, getSessionSnapshot } from './sessions.js';

const telemetry = io.of('/telemetry');

telemetry.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('unauthorized'));

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.data.user = { id: payload.sub, role: payload.role };
    // Remember expiry so we can drop the socket when the token lapses.
    socket.data.tokenExp = payload.exp;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

telemetry.on('connection', async (socket) => {
  const { sessionId } = socket.handshake.query;
  const { user } = socket.data;

  if (!sessionId || !(await canViewSession(user, sessionId))) {
    socket.emit('error:forbidden', { sessionId });
    return socket.disconnect(true);
  }

  await socket.join(`session:${sessionId}`);

  // Let clients pull a full snapshot on demand (used on reconnect).
  socket.on('stats:snapshot', async (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack(await getSessionSnapshot(sessionId));
  });

  // Disconnect when the JWT expires; the client will re-auth with a fresh token.
  const msUntilExpiry = socket.data.tokenExp * 1000 - Date.now();
  const timer = setTimeout(() => socket.disconnect(true), Math.max(msUntilExpiry, 0));
  socket.on('disconnect', () => clearTimeout(timer));
});
```

A `next(new Error(...))` in middleware surfaces on the client as a `connect_error` event, which is where the client decides whether to refresh its token or send the user back to login.

### Rooms per Session

Every live class gets a room: `session:<id>`. Faculty dashboards watching a specific class join that room; an operations overview can join a broader room like `org:<id>:live`. This keeps the fan-out tight — an event about one class only goes to the people watching that class, instead of being broadcast to everyone and filtered in the browser.

### Publishing Events From Anywhere

The services that generate events (API handlers, background workers processing attendance) often aren't socket servers at all. For those, the `@socket.io/redis-emitter` package lets any Node process emit into rooms through Redis without holding a single client connection:

```javascript
// workers/publish-stats.js
import { Emitter } from '@socket.io/redis-emitter';
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const emitter = new Emitter(redis);

export function publishSessionStats(sessionId, delta) {
  emitter
    .of('/telemetry')
    .to(`session:${sessionId}`)
    .emit('stats:update', { ...delta, version: Date.now() });
}
```

I send **deltas** (`{ activeStudents: 23 }`) rather than full snapshots on every change. It keeps payloads small, and full snapshots are reserved for initial load and reconnects.

## Front-End Architecture

On the client side, React components subscribe to granular channel topics rather than polling endpoints every few seconds.

```javascript
import { useEffect, useState } from 'react';
import io from 'socket.io-client';

export function useLiveFacultyTelemetry(sessionId) {
  const [telemetry, setTelemetry] = useState(null);

  useEffect(() => {
    const socket = io('/telemetry', {
      auth: { token: localStorage.getItem('token') },
      query: { sessionId },
    });

    socket.on('stats:update', (data) => {
      setTelemetry((prev) => ({ ...prev, ...data }));
    });

    return () => socket.disconnect();
  }, [sessionId]);

  return telemetry;
}
```

This is the simplest working version, and it's a good starting point. But under real load it has two problems: every single message triggers a React state update, and a reconnect silently leaves the UI with whatever stale data it had before the drop. The next sections fix both.

## Key Optimizations

- **Throttling State Updates**: Batching incoming WebSocket payloads using `requestAnimationFrame` to prevent React render thrashing.
- **Heartbeat & Exponential Backoff**: Automatic reconnection routines with state re-synchronization on network reconnects.

### Batching Updates with requestAnimationFrame

During busy moments — everyone joining at the start of class, or a poll closing — a dashboard can receive dozens of messages in a fraction of a second. The screen can only paint about once per frame anyway, so rendering more often than that is pure waste.

The fix is to merge incoming patches into a buffer and flush them at most once per animation frame:

```javascript
import { useEffect, useRef, useState } from 'react';

export function useBatchedSocketState(socket, event, initialState = null) {
  const [state, setState] = useState(initialState);
  const pendingRef = useRef(null);
  const frameRef = useRef(null);

  useEffect(() => {
    if (!socket) return;

    const flush = () => {
      frameRef.current = null;
      const patch = pendingRef.current;
      pendingRef.current = null;
      if (patch) setState((prev) => ({ ...prev, ...patch }));
    };

    const onMessage = (data) => {
      // Merge rather than queue: memory stays constant even if frames stall.
      pendingRef.current = { ...pendingRef.current, ...data };
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flush);
      }
    };

    socket.on(event, onMessage);

    return () => {
      socket.off(event, onMessage);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      pendingRef.current = null;
    };
  }, [socket, event]);

  return [state, setState];
}
```

Merging (instead of pushing to an array) is deliberate. Browsers pause `requestAnimationFrame` in background tabs, so a queue would grow unbounded while the tab is hidden; a merged object stays the same size and the UI catches up in one render when the tab becomes visible again.

### Reconnects and State Resync

Socket.io's client already reconnects with exponential backoff and jitter; I just tune it and, more importantly, **resync state** after every reconnect. Any delta sent while the client was offline is gone, so the client must ask for a fresh snapshot.

```javascript
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

export function useTelemetrySocket(sessionId) {
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState('connecting');

  useEffect(() => {
    const s = io('/telemetry', {
      transports: ['websocket'],
      // Called on every (re)connect attempt, so a refreshed token is picked up.
      auth: (cb) => cb({ token: localStorage.getItem('token') }),
      query: { sessionId },
      reconnectionDelay: 1000,      // first retry after ~1s
      reconnectionDelayMax: 10000,  // cap the backoff at 10s
      randomizationFactor: 0.5,     // jitter to avoid reconnect stampedes
    });

    s.on('connect', () => setStatus('live'));
    s.on('disconnect', () => setStatus('reconnecting'));
    s.on('connect_error', (err) => {
      if (err.message === 'unauthorized') setStatus('auth-required');
    });

    setSocket(s);
    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [sessionId]);

  return { socket, status };
}

export function useSessionTelemetry(sessionId) {
  const { socket, status } = useTelemetrySocket(sessionId);
  const [stats, setStats] = useBatchedSocketState(socket, 'stats:update', null);

  useEffect(() => {
    if (!socket) return;

    const resync = () => {
      socket.timeout(5000).emit('stats:snapshot', {}, (err, snapshot) => {
        if (!err && snapshot) setStats(snapshot); // replace, don't merge
      });
    };

    // 'connect' fires on the first connection *and* every reconnection.
    socket.on('connect', resync);
    return () => socket.off('connect', resync);
  }, [socket, setStats]);

  return { stats, status };
}
```

A few details that matter here:

- `auth` as a **function** means each reconnect reads the latest token, so a token refreshed elsewhere in the app is used automatically.
- The snapshot **replaces** state instead of merging into it — otherwise stale keys from before the disconnect can linger.
- Surfacing `status` in the UI ("Reconnecting…") is cheap and builds a lot of trust. A dashboard that silently shows stale numbers is worse than one that admits it's catching up.

### Ordering and Versions

Because the snapshot and in-flight deltas can race, I attach a `version` (a timestamp or monotonically increasing counter) to every payload and ignore deltas older than the last snapshot. It's a small amount of code that prevents a confusing class of "the number jumped backwards" bugs.

## Keeping React Fast Under a Firehose

Batching fixes the *frequency* of renders; these fix the *cost* of each render:

1. **Normalize state.** Store students as `{ byId: { [id]: student }, ids: [...] }` rather than an array. Updating one student becomes an O(1) object spread instead of mapping over the entire list.
2. **Memoize rows.** Wrap row components in `React.memo` and pass primitive props or stable references, so updating one student re-renders one row, not the whole table.
3. **Subscribe selectively.** For large dashboards, I moved live data into a tiny external store and used `useSyncExternalStore`, so each widget subscribes only to the slice it renders:

```javascript
import { useSyncExternalStore } from 'react';

export function createLiveStore(initial = {}) {
  let state = initial;
  const listeners = new Set();

  return {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useLiveSelector(store, selector) {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

// Usage: only re-renders when activeStudents changes.
// const active = useLiveSelector(store, (s) => s.activeStudents);
```

The selector must return a primitive or a stable reference; returning a freshly built object on each call will cause re-renders on every store update.

4. **Virtualize long lists.** For rosters with many rows, rendering only what's visible (e.g. with `react-window`) keeps DOM size bounded regardless of class size.

## Pitfalls and Lessons Learned

- **Duplicate listeners in development.** React 18's Strict Mode mounts effects twice in development. If your cleanup doesn't `off()` handlers and `disconnect()` the socket, you'll see doubled events and assume the server is misbehaving.
- **Token expiry on long-lived sockets.** A JWT verified at connect time stays "valid" for the life of the connection unless you enforce expiry yourself. Disconnecting on expiry and re-authing on reconnect closed that gap.
- **Polling transport without sticky sessions.** This produced intermittent `400` errors on handshake behind the load balancer. Forcing `transports: ['websocket']` (or enabling stickiness) fixed it.
- **Broadcasting too broadly.** Early on, I emitted to everyone in a namespace and filtered client-side. Rooms per session cut both bandwidth and client CPU.
- **Treating the socket as the source of truth.** It isn't — the database is. The socket is a fast notification channel, and every client must be able to rebuild its state from a snapshot.

## Key Takeaways

- Choose the transport by interaction pattern: polling for slow data, SSE for one-way feeds, WebSockets when you need rooms and two-way messaging.
- Use the Redis adapter (and the Redis emitter for non-socket services) as soon as you run more than one socket node.
- Authenticate at the handshake, authorize every room join, and enforce token expiry on long-lived connections.
- Send deltas for live updates and snapshots for initial load and reconnects; version both.
- Batch updates with `requestAnimationFrame`, normalize state, and subscribe selectively to keep React responsive.

## Conclusion

Real-time dashboards are less about the WebSocket itself and more about everything around it: who is allowed to listen, how events reach the right node, what happens when the network blips, and how to keep the UI smooth when messages arrive faster than the screen can paint. Getting those pieces right turned the dashboards from a "refresh to see the latest" page into something faculty and operations teams could actually trust during a live class.
