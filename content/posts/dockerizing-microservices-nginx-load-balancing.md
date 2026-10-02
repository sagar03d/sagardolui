---
template: 'post'
title: 'Dockerizing Microservices with NGINX Load Balancing for Zero-Downtime Deployments'
date: '2022-04-18'
slug: 'dockerizing-microservices-nginx-load-balancing'
tags: ['docker', 'devops', 'nginx', 'architecture', 'linux']
categories: ['Engineering', 'DevOps']
description: 'Step-by-step setup for multi-stage Docker builds, health checks, and NGINX upstream balancing for zero downtime.'
thumbnail: '../thumbnails/gcp.png'
---

Zero-downtime rolling updates ensure that user sessions are never severed during active code pushes or configuration changes.

In this guide, I share the multi-stage Docker configurations and NGINX upstream proxy architectures we deployed across our SaaS backends. More importantly, I want to walk through the *why* behind each piece, because a Dockerfile and an `nginx.conf` on their own don't give you zero downtime. You get it from how the pieces cooperate during the few seconds when an old container is going away and a new one is coming up.

## The Problem We Were Solving

The naive deployment looks like this: SSH into the box, `git pull`, rebuild, restart the process. For a few seconds (or longer, if the build is slow) the port is closed. NGINX returns `502 Bad Gateway`, in-flight requests are cut off, and any long-polling or streaming clients get disconnected.

The goal was simple to state:

- At least one healthy instance is **always** serving traffic.
- An instance is only removed from rotation **after** it stops receiving new requests and finishes the ones it has.
- A new instance is only added to rotation **after** it proves it is healthy.
- A bad release can be rolled back by redeploying the previous image tag, with no rebuild required.

The architecture that gets us there is small: two (or more) identical containers per service on the host, with NGINX in front acting as a reverse proxy and load balancer.

```text
                 ┌──────────────────────────┐
  Clients ──────▶│   NGINX (:80 / :443)     │
                 │   upstream node_cluster  │
                 └──────┬────────────┬──────┘
                        │            │
                 ┌──────▼─────┐ ┌────▼───────┐
                 │ api-blue   │ │ api-green  │
                 │ :3001      │ │ :3002      │
                 └────────────┘ └────────────┘
```

## Multi-Stage Dockerfile for Node.js Services

```dockerfile
# Stage 1: Build & Prune
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --production

# Stage 2: Minimal Production Image
FROM node:20-alpine
WORKDIR /app
USER node
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json

EXPOSE 3000
CMD ["node", "dist/main.js"]
```

### Why multi-stage?

The builder stage needs everything: TypeScript, build tooling, dev dependencies, and sometimes native compilers. None of that belongs in production. With a multi-stage build, the final image only gets the compiled `dist/` output, production `node_modules`, and `package.json`. That has a few concrete benefits:

- **Smaller images** pull faster, so new containers start sooner during a deploy.
- **Smaller attack surface**: no compilers, no dev tooling, no source files.
- **Layer caching**: copying `package*.json` and running `npm ci` *before* `COPY . .` means dependency layers are reused whenever only application code changes.

A few details worth calling out:

- `USER node` drops root privileges. The official Node images ship a `node` user, and `--chown=node:node` makes sure that user owns the copied files.
- `npm prune --production` strips dev dependencies after the build. On newer npm versions the equivalent flag is `npm prune --omit=dev`.
- Add a `.dockerignore` (at minimum `node_modules`, `.git`, `dist`, `.env*`). Without it, `COPY . .` sends your local `node_modules` and secrets into the build context.

### Adding a container health check

A running process is not the same as a healthy process. A Docker `HEALTHCHECK` lets the runtime (and our deploy script) know when the app is actually ready. The Alpine image doesn't include `curl`, but BusyBox `wget` is available:

```dockerfile
# Appended to the production stage
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
```

`--start-period` gives the app time to boot (open DB pools, warm caches) before failed checks count against it.

### PID 1 and signal handling

This one bites a lot of teams. With `CMD ["node", "dist/main.js"]`, Node runs as PID 1 inside the container. The Linux kernel does not apply default signal actions to PID 1, so if your code doesn't explicitly handle `SIGTERM`, `docker stop` will wait for the full timeout (10 seconds by default) and then `SIGKILL` the process, dropping every in-flight request.

There are two fixes, and I use both:

1. Run the container with `--init` (or `init: true` in Compose) so a tiny init process (`tini`) sits at PID 1, forwards signals, and reaps zombie processes.
2. Handle `SIGTERM` in the application and shut down gracefully.

Also avoid `CMD npm start` in production. npm doesn't reliably forward signals to the child process, and you're adding a pointless extra process.

## Graceful Shutdown in Node.js

Graceful shutdown means: stop accepting new connections, let in-flight requests finish, close downstream resources (DB pools, queues), then exit. Just as important, the health endpoint should start failing **first**, so the load balancer stops sending traffic before the server closes.

```javascript
// src/server.js (simplified)
const http = require('http');

let shuttingDown = false;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(shuttingDown ? 503 : 200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: shuttingDown ? 'draining' : 'ok' }));
  }
  // ... application routes
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ hello: 'world' }));
});

server.keepAliveTimeout = 65_000; // must exceed NGINX's upstream keepalive_timeout (60s default)
server.headersTimeout = 66_000;

server.listen(3000, () => console.log('listening on :3000'));

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining...`);

  // Give the load balancer time to observe the failing health check
  await new Promise((r) => setTimeout(r, 5_000));

  server.close(async (err) => {
    // await db.end(); await queue.close();
    process.exit(err ? 1 : 0);
  });
  server.closeIdleConnections?.(); // Node 18.2+: drop idle keep-alive sockets

  // Hard deadline so a stuck request can't block the deploy forever
  setTimeout(() => process.exit(1), 20_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

Two timeouts matter here. The application's hard deadline (20s above) must be shorter than Docker's stop timeout, so set `docker stop -t 30` or `stop_grace_period: 30s` in Compose. Otherwise Docker kills the process before your cleanup runs.

## NGINX Upstream Configuration

```nginx
upstream node_cluster {
    least_conn;
    server 127.0.0.1:3001 max_fails=3 fail_timeout=10s;
    server 127.0.0.1:3002 max_fails=3 fail_timeout=10s;
    keepalive 32;
}

server {
    listen 80;
    server_name api.platform.com;

    location / {
        proxy_pass http://node_cluster;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### What each directive is doing

| Directive | Purpose |
| --- | --- |
| `least_conn` | Sends each request to the instance with the fewest active connections. Better than round-robin when request durations vary a lot. |
| `max_fails=3 fail_timeout=10s` | Passive health checking: after 3 failed attempts within 10s, the server is marked unavailable for 10s. |
| `keepalive 32` | Keeps up to 32 idle connections per worker open to upstreams, avoiding a TCP handshake per request. |
| `proxy_http_version 1.1` + `Connection ""` | Required for upstream keepalive. HTTP/1.0 (the proxy default) closes the connection after each request. |
| `X-Forwarded-For` / `X-Real-IP` | Preserve the client IP so the app logs and rate limits on the real user, not `127.0.0.1`. |

### Choosing a balancing method

| Method | Good for | Watch out for |
| --- | --- | --- |
| Round-robin (default) | Uniform, short requests | Slow requests pile up on one instance |
| `least_conn` | Mixed workloads, long-lived requests | Slight overhead tracking connection counts |
| `ip_hash` | Legacy apps with in-memory sessions | Uneven distribution behind corporate NATs; masks statelessness problems |

I deliberately avoided `ip_hash`. Sticky sessions are a crutch: if one instance holds session state, draining it logs users out. Sessions belong in Redis or a signed token, which keeps every instance interchangeable.

### Retrying on the other instance

Add these inside the `location` block so a request that hits a dying instance is retried on the healthy one:

```nginx
proxy_next_upstream error timeout http_502 http_503;
proxy_next_upstream_tries 2;
proxy_connect_timeout 2s;
proxy_read_timeout 30s;
```

Since NGINX 1.9.13, non-idempotent requests (`POST`, `PATCH`, `LOCK`) are **not** retried once they've been sent to an upstream, unless you add `non_idempotent`. Leave it that way. Retrying a payment `POST` is how you double-charge someone.

### Open-source NGINX has no active health checks

The `health_check` directive is NGINX Plus only. Open-source NGINX learns that an upstream is down only when real requests fail. That's why the deploy script below **explicitly** takes an instance out of rotation before stopping it, instead of hoping passive checks notice in time.

## Docker Compose for the Two Instances

```yaml
# docker-compose.yml
services:
  api-blue:
    image: registry.example.com/api:${BLUE_TAG:-latest}
    init: true
    restart: unless-stopped
    env_file: .env.production
    ports:
      - "127.0.0.1:3001:3000"
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 20s

  api-green:
    image: registry.example.com/api:${GREEN_TAG:-latest}
    init: true
    restart: unless-stopped
    env_file: .env.production
    ports:
      - "127.0.0.1:3002:3000"
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 20s
```

Binding ports to `127.0.0.1` matters. By default Docker publishes on `0.0.0.0` and inserts its own iptables rules, which can **bypass host firewalls like UFW** and expose your app directly to the internet, skipping NGINX entirely.

## The Rolling Deploy Script

To control rotation, I moved the upstream servers into their own include file that the script rewrites:

```nginx
# /etc/nginx/conf.d/upstream.conf
upstream node_cluster {
    least_conn;
    include /etc/nginx/upstreams/api.servers;
    keepalive 32;
}
```

The script updates one instance at a time: drain it, replace it, wait for health, put it back.

```bash
#!/usr/bin/env bash
# deploy.sh <image-tag>
set -euo pipefail

TAG="${1:?usage: deploy.sh <image-tag>}"
SERVERS_FILE=/etc/nginx/upstreams/api.servers

write_upstreams() {  # $1 = service to mark down (or "none")
  {
    [[ "$1" == "api-blue"  ]] && d=" down" || d=""
    echo "server 127.0.0.1:3001 max_fails=3 fail_timeout=10s${d};"
    [[ "$1" == "api-green" ]] && d=" down" || d=""
    echo "server 127.0.0.1:3002 max_fails=3 fail_timeout=10s${d};"
  } | sudo tee "$SERVERS_FILE" > /dev/null
  sudo nginx -t && sudo nginx -s reload
}

wait_healthy() {
  local id
  for _ in $(seq 1 30); do
    id=$(docker compose ps -q "$1")
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' "$id")" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "$1 failed health checks" >&2
  return 1
}

for svc in api-blue api-green; do
  echo "==> Draining $svc"
  write_upstreams "$svc"
  sleep 10   # let in-flight requests finish on the drained instance

  echo "==> Deploying $TAG to $svc"
  if [[ "$svc" == "api-blue" ]]; then export BLUE_TAG="$TAG"; else export GREEN_TAG="$TAG"; fi
  docker compose pull "$svc"
  docker compose up -d --no-deps "$svc"

  if ! wait_healthy "$svc"; then
    echo "!! Aborting. The other instance is still serving traffic." >&2
    exit 1
  fi
done

write_upstreams none
echo "==> Deploy of $TAG complete"
```

A few things make this safe:

- **`nginx -s reload` is graceful.** NGINX starts new workers with the new config, and the old workers finish their in-flight requests before exiting. No connections are dropped.
- **`nginx -t` runs first**, so a broken config never gets loaded.
- **The script fails closed.** If the new container never becomes healthy, it exits with the bad instance still marked `down`, and the other instance keeps serving on the old version. Rollback is just `./deploy.sh <previous-tag>`.
- **Immutable tags.** Deploy by Git SHA, not `latest`. Otherwise "roll back to the previous version" has no meaning.

One thing to watch: the script exports `BLUE_TAG`/`GREEN_TAG` only for its own run. In practice, persist the current tags in a small `.env` file next to the Compose file so a later `docker compose up` doesn't silently revert one instance to `latest`.

## Wiring It into CI/CD

The pipeline builds once, tags the image with the commit SHA, pushes it, and runs the deploy script over SSH:

```yaml
# .github/workflows/deploy.yml
name: build-and-deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: registry.example.com
          username: ${{ secrets.REGISTRY_USER }}
          password: ${{ secrets.REGISTRY_PASSWORD }}

      - uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: registry.example.com/api:${{ github.sha }}

      - name: Rolling deploy
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: deploy
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: cd /srv/api && ./deploy.sh ${{ github.sha }}
```

Run tests in an earlier job and make `deploy` depend on it with `needs:`. A zero-downtime pipeline can still ship broken code with zero downtime.

## Common Pitfalls

- **Keep-alive races.** If Node's `keepAliveTimeout` is shorter than NGINX's upstream keepalive timeout, Node can close a socket at the same moment NGINX reuses it, which produces sporadic 502s. Keep the app's timeout longer.
- **Database migrations.** During a rolling deploy, old and new code run side by side. Schema changes must be backward compatible (expand, then contract): add a column in one release, start using it in the next, and drop the old one later.
- **WebSockets.** Long-lived connections won't finish within a 10-second drain. Clients need reconnect logic, and the server should send a close frame during shutdown.
- **Health checks that lie.** A `/health` that always returns 200 is useless. Check what the instance needs to serve traffic (e.g. the DB pool is connected), but don't cascade: if the DB is down for everyone, failing every instance helps nobody.
- **Running out of disk.** Every deploy pulls a new image. Schedule `docker image prune` or your rollback window will end on a full disk.

## Zero-Downtime Checklist

- [ ] Multi-stage build, non-root user, `.dockerignore` in place
- [ ] `HEALTHCHECK` with a sensible `start-period`
- [ ] `init: true` (or `--init`) and an explicit `SIGTERM` handler
- [ ] Health endpoint returns 503 while draining
- [ ] App shutdown deadline shorter than `stop_grace_period`
- [ ] Container ports bound to `127.0.0.1`
- [ ] `proxy_next_upstream` set, without retrying non-idempotent requests
- [ ] Deploy script drains, replaces, health-gates and restores one instance at a time
- [ ] Images tagged by commit SHA, with rollback tested at least once
- [ ] Backward-compatible database migrations

## Conclusion

None of the individual pieces here is exotic: a multi-stage Dockerfile, a health check, a signal handler, an NGINX upstream block and a short Bash script. Zero downtime comes from getting the order right. Fail the health check, drain, close, replace, verify, restore. Once that loop was in place, deploys stopped being events we scheduled around and became something we did several times a day without thinking about it. When you eventually outgrow a single host, the same ideas carry over almost unchanged to managed instance groups or Kubernetes. Readiness probes, termination grace periods and rolling updates are this pattern under different names.
