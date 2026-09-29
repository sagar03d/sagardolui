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

When API latency is dominated by database execution time, optimizing database queries yields the highest return on investment. In this post, I detail how we investigated slow endpoints and reduced average API latency from **800ms down to 320ms**—a **60% performance improvement**.

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

### The Problem: Sequential Scans on High-Churn Tables
The query plan revealed sequential table scans across over 2 million attendance records because composite keys were not properly indexed, and filter predicates evaluated unindexed boolean expressions.

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

### 2. Eliminating N+1 Joins in ORMs
In our Laravel and Node.js repositories, we replaced implicit nested relationships with eager loading and window functions (`ROW_NUMBER()` / `DENSE_RANK()`), avoiding multiple roundtrips to Cloud SQL.

### 3. Connection Pooling with PgBouncer
We introduced connection pooling to eliminate the overhead of TCP handshakes and PostgreSQL backend process forking on every request.

## Results
- **Average API Response Time**: 800ms ➡️ 320ms (60% decrease)
- **p99 Latency**: 2.4s ➡️ 650ms
- **Database CPU Utilization**: Reduced from 78% peak to 34% steady state.
