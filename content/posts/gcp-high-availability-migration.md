---
template: 'post'
title: 'High-Availability Cloud Migration to GCP: Compute Engine & Cloud SQL'
date: '2023-04-12'
slug: 'gcp-high-availability-migration'
series: 'Cloud Infrastructure & High Availability'
tags: ['gcp', 'cloud', 'devops', 'kubernetes', 'docker']
categories: ['Engineering', 'DevOps']
description: 'How we migrated mission-critical services to Google Cloud Platform with zero user downtime and automated failover.'
thumbnail: '../thumbnails/gcp.png'
---

Migrating live production databases and microservices without downtime requires rigorous planning, shadow traffic testing, and multi-stage cutover procedures.

Here is the migration roadmap we used to transition from legacy VPS infrastructure to a managed, autoscaling **Google Cloud Platform (GCP)** environment. I'll cover the strategy at a high level first, then go through each phase: the configuration involved, the trade-offs we weighed, and the things that can quietly go wrong.

## Why Move at All?

The legacy setup was a handful of hand-configured VPS boxes. It worked, but it had the usual problems:

- **Single points of failure.** One database server meant a disk failure or a kernel panic was an outage.
- **Snowflake servers.** Each box had been patched and tweaked by hand, so nobody could confidently rebuild one from scratch.
- **Manual scaling.** Handling a traffic spike meant someone resizing a VPS, usually after the spike had already hurt.

The target was a setup where the database fails over automatically, the application tier heals and scales itself, and every environment can be recreated from code.

## The Strategy

1. **Dual-Write / Replication Phase**:
   We provisioned a Cloud SQL PostgreSQL instance configured as a read replica of the primary master. Continuous logical replication kept latency under 100ms.

2. **Containerization & CI/CD**:
   All Node.js and Laravel applications were packaged with multi-stage Docker builds and pushed to Google Artifact Registry. GitHub Actions automated test suites (>90% coverage) before staging deployments.

3. **Traffic Splitting**:
   Using NGINX and GCP Cloud Load Balancing, traffic was progressively shifted from 5% ➡️ 25% ➡️ 100% while observing telemetry.

The order is deliberate. Data is the hardest thing to move and the easiest thing to corrupt, so it moves first and in the background. The application tier is stateless and cheap to run in two places at once. Traffic moves last, in small reversible steps.

## Phase 1: Replicating the Database

### Why logical replication instead of dump-and-restore?

A `pg_dump` / `pg_restore` is the simplest option, but it requires a write freeze for the whole copy. For any non-trivial database, that means a maintenance window measured in minutes to hours. Logical replication instead does an initial copy and then streams every change continuously, so the Cloud SQL copy stays seconds (in our case, under 100ms) behind production for as long as you need. The final cutover only has to wait for that small gap to close.

Google's **Database Migration Service (DMS)** wraps this for PostgreSQL using the `pglogical` extension. You can also run `pglogical` yourself, but DMS handles the initial load, monitoring and the final promotion step.

### Preparing the source database

On the legacy primary, logical decoding has to be enabled and the replication user needs the right privileges:

```ini
# postgresql.conf on the legacy primary
wal_level = logical
max_replication_slots = 10
max_wal_senders = 10
max_worker_processes = 8
shared_preload_libraries = 'pglogical'
```

```sql
-- In every database being migrated
CREATE EXTENSION IF NOT EXISTS pglogical;
ALTER USER migration_user WITH REPLICATION;
GRANT USAGE ON SCHEMA pglogical TO migration_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO migration_user;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO migration_user;
```

Changing `wal_level` requires a restart of the source database. Plan that one short restart early, well before the migration window.

### Things logical replication does not do for you

- **Tables without primary keys** can only replicate `INSERT`s. `UPDATE`s and `DELETE`s need a primary key (or a replica identity). Audit for these first:

  ```sql
  SELECT c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint p
      WHERE p.conrelid = c.oid AND p.contype = 'p'
    );
  ```

- **DDL is not replicated.** Freeze schema migrations for the duration, or apply them on both sides by hand.
- **Sequence values may lag.** After promotion, check that every sequence on Cloud SQL is ahead of the max ID in its table, or the first inserts will fail with duplicate key errors.

### Watching replication lag

"Under 100ms" is only useful if you're measuring it all the time. On the source, the replication slot tells you how much WAL the replica still has to consume:

```sql
SELECT slot_name,
       active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag
FROM pg_replication_slots;
```

Watch the slot itself as well. If the replica disconnects, an inactive slot keeps WAL around indefinitely and can fill the source's disk. Alert on both lag and slot activity.

## Phase 2: Containerization and CI/CD

The applications were already being moved to multi-stage Docker builds (I've written about [the Dockerfile and NGINX setup](/dockerizing-microservices-nginx-load-balancing) separately). On GCP, images go to **Artifact Registry**, and GitHub Actions authenticates using **Workload Identity Federation** instead of a long-lived JSON service account key:

```yaml
# .github/workflows/release.yml
name: release
on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write   # required for Workload Identity Federation

env:
  IMAGE: asia-south1-docker.pkg.dev/my-project/apps/api

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test -- --coverage

  build-push:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.DEPLOY_SA }}
      - uses: google-github-actions/setup-gcloud@v2
      - run: gcloud auth configure-docker asia-south1-docker.pkg.dev --quiet
      - run: |
          docker build -t "$IMAGE:${GITHUB_SHA}" .
          docker push "$IMAGE:${GITHUB_SHA}"
```

The region and project names above are placeholders. The important parts are that tests gate the build, and that images are tagged with the commit SHA so every environment runs an exact, traceable artifact.

## Infrastructure as Code & Scalability

Using Terraform and Docker Compose, environments became completely reproducible across development, staging, and production environments. Docker Compose covers local development, where developers run the same images against a local Postgres. Terraform owns everything in GCP.

### Cloud SQL with automatic failover

The setting that turns Cloud SQL into a high-availability database is `availability_type = "REGIONAL"`. It provisions a standby in a second zone with synchronous replication of the underlying storage. If the primary zone fails, Cloud SQL fails over automatically and the instance keeps the same IP, so applications only need to reconnect.

```hcl
resource "google_sql_database_instance" "main" {
  name                = "app-postgres"
  database_version    = "POSTGRES_14"
  region              = var.region
  deletion_protection = true

  settings {
    tier              = "db-custom-4-16384"
    availability_type = "REGIONAL"   # HA: standby in a second zone
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
    }

    maintenance_window {
      day  = 7
      hour = 3
    }

    database_flags {
      name  = "cloudsql.logical_decoding"
      value = "on"   # keeps reverse replication possible as a rollback path
    }
  }
}
```

Note that the HA standby is **not** a read replica. It doesn't serve traffic. If you need to offload reads, add separate read replicas.

### Self-healing, autoscaling application tier

On Compute Engine, a **regional managed instance group (MIG)** spreads VMs across zones, recreates any VM that fails its health check, and scales on load:

```hcl
resource "google_compute_health_check" "api" {
  name                = "api-health"
  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3

  http_health_check {
    port         = 3000
    request_path = "/health"
  }
}

resource "google_compute_region_instance_group_manager" "api" {
  name               = "api-mig"
  region             = var.region
  base_instance_name = "api"

  version {
    instance_template = google_compute_instance_template.api.id
  }

  named_port {
    name = "http"
    port = 3000
  }

  auto_healing_policies {
    health_check      = google_compute_health_check.api.id
    initial_delay_sec = 120
  }

  update_policy {
    type                  = "PROACTIVE"
    minimal_action        = "REPLACE"
    max_surge_fixed       = 3
    max_unavailable_fixed = 0
  }
}

resource "google_compute_region_autoscaler" "api" {
  name   = "api-autoscaler"
  region = var.region
  target = google_compute_region_instance_group_manager.api.id

  autoscaling_policy {
    min_replicas    = 3
    max_replicas    = 10
    cooldown_period = 90

    cpu_utilization {
      target = 0.6
    }
  }
}
```

A couple of the values are worth explaining:

- `max_unavailable_fixed = 0` with a surge means new VMs come up and pass health checks *before* old ones are removed. That's the same "health-gate, then rotate" rule as the single-host NGINX setup, just managed by GCP.
- On a regional MIG, the fixed surge and unavailable values must be either 0 or at least the number of zones (typically 3). That's why the surge is 3 rather than 1.
- `min_replicas = 3` gives one VM per zone. These replica counts and the 60% CPU target are reasonable starting points, not universal answers. Tune them against your own load tests.

Rolling out a new image is then a single command once the new instance template exists:

```bash
gcloud compute instance-groups managed rolling-action start-update api-mig \
  --version=template=api-template-v42 \
  --region=asia-south1 \
  --max-surge=3 \
  --max-unavailable=0
```

## Phase 3: Progressive Traffic Shifting

Traffic moved in stages: 5%, then 25%, then 100%. The legacy NGINX stayed as the entry point during the transition and acted as the splitter, sending a weighted share of requests to the GCP load balancer:

```nginx
upstream app_backends {
    server 10.0.0.10:8080 weight=95;              # legacy app servers
    server gcp-lb.internal.example.com weight=5;  # GCP external load balancer
    keepalive 32;
}
```

Moving to the next stage is just a weight change and a graceful `nginx -s reload`, and rolling back is the same edit in reverse. Once GCP was taking 100% and had been stable, DNS was pointed at the Cloud Load Balancing IP directly and the legacy NGINX was taken out of the path.

### One writer at a time

The hardest constraint during the split is that **there is only ever one writable primary**. While the Cloud SQL instance is still a replica, the GCP application tier has to send its writes to the legacy primary over a private, encrypted link, and only send reads to the replica where slightly stale data is acceptable. Never let both sides accept writes to different databases. Reconciling diverged data after the fact is far worse than any downtime you were trying to avoid.

### Gates between stages

Each step had explicit go/no-go criteria rather than a gut feeling. As an illustrative template:

| Stage | Traffic to GCP | Gate before moving on |
| --- | --- | --- |
| Canary | 5% | Error rate and p95 latency match legacy; no new error signatures in logs |
| Ramp | 25% | Autoscaler behaves under real load; DB connections and replication lag stable |
| Full | 100% | Sustained soak period with clean dashboards; rollback still rehearsed and ready |

Session handling matters too. If sessions live in local memory or local files on legacy servers, users bounce between backends and get logged out. Move sessions to a shared store (or stateless tokens) **before** you start splitting.

## The Cutover: Promoting Cloud SQL

When GCP is serving all application traffic, the last step is making Cloud SQL the primary. This is the only moment that needs tight coordination:

1. **Lower DNS TTLs** days in advance so any DNS changes propagate quickly.
2. **Pause writes briefly.** Put write endpoints into read-only mode or queue them, and let replication lag drop to zero.
3. **Verify.** Compare row counts and spot-check checksums on critical tables.
4. **Promote** the Cloud SQL instance to a standalone primary:

   ```bash
   gcloud database-migration migration-jobs promote my-migration-job \
     --region=asia-south1
   ```

5. **Fix sequences** so new IDs don't collide:

   ```sql
   SELECT setval('orders_id_seq', (SELECT COALESCE(MAX(id), 1) FROM orders));
   ```

6. **Repoint connection strings** to the Cloud SQL private IP and resume writes.
7. **Keep the legacy primary running but read-only** for the rollback window.

### The rollback plan

Before promotion, rollback is easy: shift traffic weights back. After promotion, new writes exist only in Cloud SQL, so "rolling back" means moving data the other way. Decide on that path *before* cutover, not during an incident. With `cloudsql.logical_decoding` enabled, you can set up reverse logical replication from Cloud SQL to the old server, so the legacy database stays current as a fallback until you're confident enough to decommission it.

### Test failover, don't assume it

A regional instance that has never failed over is a theory, not HA. Trigger a failover deliberately in staging (and, once you trust it, in production during a quiet period) and watch how the application reconnects:

```bash
gcloud sql instances failover app-postgres
```

This is usually where you find connection pools that don't retry, or ORMs that hold stale connections until restart.

## Common Pitfalls

- **Forgetting the replication slot.** Abandoned slots retain WAL and can fill the source disk.
- **Schema changes mid-migration.** DDL doesn't replicate, so freeze migrations or apply them on both sides deliberately.
- **Latency between clouds.** During the split, every GCP-side write crosses a network boundary to the legacy primary. Measure it at 5% before it becomes a problem at 25%.
- **Health checks that are too strict.** If `/health` checks every dependency, a brief DB blip can make the MIG recreate every VM at once. Keep liveness shallow.
- **Firewall rules for health checks.** Google's health checkers come from `35.191.0.0/16` and `130.211.0.0/22`. Forget to allow them and every instance looks unhealthy.
- **Hardcoded IPs and hostnames** buried in config files and cron jobs on the old servers. Grep for them early.

## Migration Checklist

- [ ] `wal_level=logical`, `pglogical` installed, primary keys on every replicated table
- [ ] Replication lag and slot health on a dashboard with alerts
- [ ] Images built once, tagged by SHA, pushed to Artifact Registry from CI with tests gating
- [ ] Cloud SQL `REGIONAL`, PITR enabled, private IP, deletion protection on
- [ ] Regional MIG with autohealing, surge-first rolling updates and autoscaling
- [ ] Health-check firewall ranges allowed
- [ ] Sessions externalized before traffic splitting
- [ ] Written go/no-go gates for 5% → 25% → 100%
- [ ] Cutover runbook rehearsed in staging, including sequence resets
- [ ] Rollback path defined for both before and after promotion
- [ ] Failover drill completed

## Conclusion

The migration worked because nothing happened all at once. Data replicated quietly in the background for as long as we needed. The application ran in both places while traffic moved over in small, reversible steps, and the one irreversible action, promoting the database, was rehearsed, scripted and backed by a rollback plan. The end state is infrastructure that's defined in Terraform, heals itself when a VM or zone fails, and scales without someone resizing a server by hand. If I could pass on one lesson, it's to spend most of the effort on the boring parts: lag monitoring, gates, runbooks and failover drills. They're what make the cutover itself uneventful.
