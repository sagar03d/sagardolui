---
template: 'post'
title: 'Dockerizing Microservices with NGINX Load Balancing for Zero-Downtime Deployments'
date: '2022-04-18'
slug: 'dockerizing-microservices-nginx-load-balancing'
tags: ['docker', 'devops', 'nginx', 'architecture', 'linux']
categories: ['Engineering', 'DevOps']
description: 'Step-by-step setup for multi-stage Docker builds, health checks, and NGINX upstream balancing for zero downtime.'
thumbnail: '../thumbnails/docker.svg'
---

Zero-downtime rolling updates ensure that user sessions are never severed during active code pushes or configuration changes.

In this guide, I share the multi-stage Docker configurations and NGINX upstream proxy architectures we deployed across our SaaS backends.

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
