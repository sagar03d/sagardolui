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

At Arobit Business Solutions, we built a multi-tenant backend architecture serving over **300K+ registered users** and processing **50L+ INR monthly**.

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

## Payment Processing Integration

Handling global and domestic billing across tenants required integrating both **Stripe** and **Razorpay** with automated webhook verification, recurring subscription state machines, and idempotent charge processing.
