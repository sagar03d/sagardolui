---
template: 'post'
title: 'Optimizing PostgreSQL Query Performance & Indexing: 800ms to 320ms'
date: '2023-11-10'
slug: 'optimizing-postgresql-query-performance'
series: 'PostgreSQL Performance & Indexing'
tags: ['postgresql', 'database', 'sql', 'performance']
categories: ['Engineering', 'Databases']
description: 'A deep dive into query execution plans, B-Tree and partial indexing, and reducing average API response times by 60%.'
thumbnail: '../thumbnails/postgres.png'
---

When API latency is dominated by database execution time, optimizing database queries yields the highest return on investment. In this post, I detail how we investigated slow endpoints and reduced average API latency from **800ms down to 320ms**, a **60% performance improvement**.

None of the fixes were exotic. The real work was measuring carefully, understanding *why* PostgreSQL chose the plans it did, and making changes that were safe to roll out on a live database. I'll go through the process in the order we actually followed it.

## Step 0: Find the Queries That Matter

Before running `EXPLAIN` on anything, you need to know which queries to look at. Guessing based on which endpoint "feels slow" is unreliable. The `pg_stat_statements` extension aggregates statistics for every normalized query the server executes, and it's available on managed services like Cloud SQL.

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

SELECT
  queryid,
  calls,
  round(total_exec_time::numeric, 0)  AS total_ms,
  round(mean_exec_time::numeric, 1)   AS mean_ms,
  round(stddev_exec_time::numeric, 1) AS stddev_ms,
  rows,
  left(query, 120)                    AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

(On PostgreSQL 12 and older, the columns are `total_time` and `mean_time`.)

Sort by **total** execution time first, not mean. A 5ms query called a million times a day costs more than a 2s report someone runs once a week. Then look at the outliers by mean time and high standard deviation, which often point at plans that flip between good and bad depending on parameters.

## Pinpointing Bottlenecks with EXPLAIN ANALYZE

The first step in any database tuning effort is quantifying where the database engine spends CPU cycles and I/O reads.

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS, VERBOSE)
SELECT s.id, s.title, f.name, COUNT(a.id) as attendee_count
FROM sessions s
JOIN faculties f ON f.id = s.faculty_id
LEFT JOIN attendance a ON a.session_id = s.id
WHERE s.scheduled_at >= NOW() - INTERVAL '30 days'
  AND s.status = 'COMPLETED'
GROUP BY s.id, f.name
ORDER BY s.scheduled_at DESC
LIMIT 50;
```

A word of caution: `EXPLAIN ANALYZE` actually **executes** the statement. That's fine for a `SELECT`, but wrap any `UPDATE` or `DELETE` in `BEGIN; ... ROLLBACK;` if you want to analyze it without changing data.

### How to Read the Output

Plans are trees, read from the most indented node outward. A simplified, illustrative shape of what a problem plan looks like:

```text
Limit  (actual time=812.4..812.5 rows=50 loops=1)
  ->  Sort  (actual time=812.4..812.4 rows=50 loops=1)
        Sort Key: s.scheduled_at DESC
        ->  HashAggregate  (actual time=790.1..805.3 rows=... loops=1)
              ->  Hash Right Join  (actual time=... rows=... loops=1)
                    Hash Cond: (a.session_id = s.id)
                    ->  Seq Scan on attendance a  (actual time=0.02..410.7 rows=... loops=1)
                          Buffers: shared hit=... read=...
                    ->  Hash
                          ->  Seq Scan on sessions s
                                Filter: ((status = 'COMPLETED') AND (scheduled_at >= ...))
                                Rows Removed by Filter: ...
```

The things I look for, in order:

| Signal | What it usually means |
| --- | --- |
| `Seq Scan` on a large table with a selective `Filter` | Missing or unusable index |
| High `Rows Removed by Filter` | The scan reads far more rows than it returns |
| Estimated `rows=` far from actual `rows=` | Stale statistics or correlated columns; run `ANALYZE` |
| Large `Buffers: shared read` | Data coming from disk rather than the buffer cache |
| `loops=` in the thousands on an inner node | A nested loop repeating work per outer row |
| `Sort Method: external merge  Disk:` | Sort spilled to disk; `work_mem` too small for this query |

For sharing plans with teammates, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` pasted into a plan visualizer makes the expensive nodes much easier to spot.

### The Problem: Sequential Scans on High-Churn Tables

The query plan revealed sequential table scans across over 2 million attendance records because composite keys were not properly indexed, and filter predicates evaluated unindexed boolean expressions.

In other words, to show the 50 most recent completed sessions, PostgreSQL was reading the entire attendance table, hashing it, and only then throwing most of it away. The `sessions` filter on `status` and `scheduled_at` had no index to lean on either, so the cost grew linearly with the table, and attendance is exactly the kind of table that grows every single day.

## Optimization Strategies

### 1. Composite & Partial Indexes

Rather than indexing whole columns indiscriminately, we created targeted composite and partial indexes for hot queries:

```sql
-- Partial index targeting active completed sessions
CREATE INDEX idx_sessions_completed_scheduled 
ON sessions (scheduled_at DESC, faculty_id) 
WHERE status = 'COMPLETED';

-- Covering index on foreign keys with included columns
CREATE INDEX idx_attendance_session_covered 
ON attendance (session_id) 
INCLUDE (student_id, attended_at);
```

Why these shapes specifically:

- **Partial index (`WHERE status = 'COMPLETED'`)**: The index only contains completed sessions, so it's smaller, cheaper to maintain, and more likely to stay in memory. The catch is that the planner only uses it when the query's `WHERE` clause provably implies the index predicate. `status = 'COMPLETED'` matches; `status = $1` with a generic prepared-statement plan may not.
- **Column order (`scheduled_at DESC` first)**: B-Tree indexes are used left to right. Putting the range/sort column first lets PostgreSQL walk the index in order and stop after enough rows for the `LIMIT`, instead of sorting everything. A rule of thumb: equality columns first, then the range or sort column. Here the equality condition is baked into the partial predicate, so the sort column leads.
- **Covering index (`INCLUDE`)**: PostgreSQL 11+ lets you store extra non-key columns in the index leaf pages. Queries that only need `session_id`, `student_id`, and `attended_at` can be answered with an **Index Only Scan**, skipping the heap entirely, as long as the visibility map is reasonably up to date (more on that under VACUUM).

#### Creating Indexes Safely in Production

A plain `CREATE INDEX` takes a lock that blocks writes to the table for the duration of the build. On a table receiving attendance inserts all day, that's an outage. Use `CONCURRENTLY`:

```sql
CREATE INDEX CONCURRENTLY idx_attendance_session_covered
ON attendance (session_id)
INCLUDE (student_id, attended_at);
```

Things to know about concurrent builds:

- It **cannot run inside a transaction block**, which trips up some migration tools. In Laravel, put it in its own migration and disable the wrapping transaction; in Node migration tools, look for a "no transaction" option.
- It takes longer, because it scans the table twice and waits for existing transactions to finish.
- If it fails, it leaves an **`INVALID`** index behind that still costs write overhead. Check for and drop those:

```sql
SELECT indexrelid::regclass AS index_name
FROM pg_index
WHERE NOT indisvalid;

DROP INDEX CONCURRENTLY IF EXISTS idx_attendance_session_covered;
```

And remember that every index has a write cost. Before adding new ones, it's worth checking `pg_stat_user_indexes` for indexes with `idx_scan = 0` that you're paying for and never using.

### 2. Eliminating N+1 Joins in ORMs

In our Laravel and Node.js repositories, we replaced implicit nested relationships with eager loading and window functions (`ROW_NUMBER()` / `DENSE_RANK()`), avoiding multiple roundtrips to Cloud SQL.

The N+1 pattern rarely shows up in `pg_stat_statements` as one slow query. It shows up as a cheap query with an enormous `calls` count. Here's the classic Laravel version:

```php
// Before: 1 query for sessions + 1 per session for faculty + 1 per session for count
$sessions = Session::where('status', 'COMPLETED')
    ->latest('scheduled_at')
    ->take(50)
    ->get();

foreach ($sessions as $session) {
    $session->faculty->name;          // lazy load: +1 query
    $session->attendance()->count();  // +1 query
}
// Up to 101 round trips for one API response.
```

```php
// After: 3 queries total, regardless of page size
$sessions = Session::query()
    ->where('status', 'COMPLETED')
    ->with('faculty:id,name')
    ->withCount('attendance')
    ->latest('scheduled_at')
    ->take(50)
    ->get();
```

With a managed database, each round trip carries network latency on top of execution time, so collapsing 101 small queries into a handful often matters more than shaving milliseconds off any single one. Laravel can also catch regressions for you in development with `Model::preventLazyLoading(! app()->isProduction());`, which throws whenever a relationship is lazy loaded.

#### Window Functions Instead of Loops

A common N+1 variant is "for each student, fetch their latest attendance record". Instead of looping, let the database rank rows per group:

```sql
SELECT student_id, session_id, attended_at
FROM (
  SELECT
    a.student_id,
    a.session_id,
    a.attended_at,
    ROW_NUMBER() OVER (
      PARTITION BY a.student_id
      ORDER BY a.attended_at DESC
    ) AS rn
  FROM attendance a
  WHERE a.student_id = ANY($1)
) ranked
WHERE rn = 1;
```

`ROW_NUMBER()` gives exactly one row per student, while `DENSE_RANK()` is useful when ties should all be kept, for example "every session tied for the most recent date". An index on `(student_id, attended_at DESC)` lets PostgreSQL read each partition already in order. For the specific "top 1 per group" case, `SELECT DISTINCT ON (student_id) ... ORDER BY student_id, attended_at DESC` is a PostgreSQL-specific alternative that's often just as fast and shorter to write.

### 3. Connection Pooling with PgBouncer

We introduced connection pooling to eliminate the overhead of TCP handshakes and PostgreSQL backend process forking on every request.

Each PostgreSQL connection is a separate OS process with its own memory, so hundreds of short-lived connections from many app containers waste resources on setup and context switching. PgBouncer keeps a small pool of server connections and multiplexes client connections onto them.

```ini
[databases]
appdb = host=10.0.0.5 port=5432 dbname=appdb

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 20
max_client_conn = 1000
server_idle_timeout = 600
```

`pool_mode = transaction` gives the best connection reuse, but it changes the rules: a client only owns a server connection for the duration of a transaction. That means session state does not carry over between transactions:

- `SET` statements, session-level advisory locks, `LISTEN/NOTIFY`, and temporary tables won't behave as expected. Use `SET LOCAL` inside a transaction instead.
- Prepared statements historically broke in transaction mode. PgBouncer 1.21+ supports protocol-level prepared statements via `max_prepared_statements`; on older versions, disable them in the driver.

Sizing is a common mistake. A bigger pool is not faster; past a point, more concurrent queries just contend for the same CPU cores and disks. A reasonable starting point is a small multiple of the database's CPU core count, then adjust based on observed wait times.

## Keeping Plans Good: VACUUM, ANALYZE and Autovacuum

Indexes fix today's plans. Statistics and vacuuming keep them good next month.

PostgreSQL's MVCC means an `UPDATE` or `DELETE` leaves the old row version behind as a dead tuple. `VACUUM` reclaims that space and updates the **visibility map**, which is what makes Index Only Scans possible. `ANALYZE` refreshes the column statistics the planner uses to estimate row counts. When estimates drift, the planner picks the wrong join strategy even when the right index exists.

Check whether a table is keeping up:

```sql
SELECT relname,
       n_live_tup,
       n_dead_tup,
       last_autovacuum,
       last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;
```

The default autovacuum thresholds trigger a vacuum when roughly 20% of a table has changed (`autovacuum_vacuum_scale_factor = 0.2`). On a table with millions of rows, that's a lot of dead tuples before anything happens. For large, high-churn tables, per-table settings help:

```sql
ALTER TABLE attendance SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.01
);
```

These values are illustrative; the right ones depend on your write volume. After bulk imports or big backfills, run a manual `ANALYZE attendance;` rather than waiting for autovacuum to notice. Avoid `VACUUM FULL` on live tables: it rewrites the table under an exclusive lock.

## Common Pitfalls

- **Indexing every column "just in case".** Each index slows writes and competes for cache.
- **Functions on indexed columns.** `WHERE DATE(scheduled_at) = '2023-11-01'` can't use a plain index on `scheduled_at`; rewrite as a range, or create an expression index.
- **Mismatched types.** Comparing a `bigint` column to a `text` parameter can force casts that disable index use.
- **Leading wildcards.** `LIKE '%term'` can't use a B-Tree index; consider `pg_trgm` for that.
- **Testing on tiny datasets.** The planner rightly prefers sequential scans on small tables, so plans in development may look nothing like production.
- **Using `OFFSET` for deep pagination.** The database still reads and discards every skipped row; keyset pagination (`WHERE scheduled_at < $last ORDER BY scheduled_at DESC LIMIT 50`) scales far better.

## Checklist

1. Enable `pg_stat_statements` and rank queries by total time.
2. Run `EXPLAIN (ANALYZE, BUFFERS)` on the top offenders and compare estimated vs actual rows.
3. Design indexes around the query's equality, range, and sort columns; consider partial and covering indexes.
4. Build indexes with `CREATE INDEX CONCURRENTLY` and check for invalid leftovers.
5. Hunt N+1 patterns via high `calls` counts; use eager loading and window functions.
6. Pool connections, and understand what transaction pooling changes.
7. Monitor dead tuples and tune autovacuum on high-churn tables.
8. Re-measure after every change, one change at a time.

## Results

- **Average API Response Time**: 800ms ➡️ 320ms (60% decrease)
- **p99 Latency**: 2.4s ➡️ 650ms
- **Database CPU Utilization**: Reduced from 78% peak to 34% steady state.

## Conclusion

The biggest lesson from this work was that performance tuning is a loop, not a one-time project: measure, read the plan, make one targeted change, and measure again. Targeted indexes removed the sequential scans over 2 million attendance records, eager loading and window functions cut the round trips, and pooling took connection overhead off the critical path. Together they took average latency from 800ms to 320ms. Keeping it there is the job of good statistics, healthy vacuuming, and checking `pg_stat_statements` before the next slow endpoint turns into a support ticket.
