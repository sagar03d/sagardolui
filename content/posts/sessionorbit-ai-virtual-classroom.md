---
template: 'post'
title: 'Inside SessionOrbit: Designing an AI-Powered Virtual Classroom Platform'
date: '2024-05-10'
slug: 'sessionorbit-ai-virtual-classroom'
tags: ['genai', 'react', 'node', 'postgresql', 'projects', 'websockets']
categories: ['Projects', 'Engineering']
description: 'How SessionOrbit centralized tutor-student operations and cut administrative overhead by 40% with real-time data sync.'
thumbnail: '../thumbnails/node.png'
---

Managing high-frequency online tutoring sessions requires coordination-heavy synchronization between students, educators, parents, and administrative staff.

Every session touches several people and several systems: someone has to book it, someone has to confirm the teacher is free, someone has to check who actually showed up, someone has to bill for it, and the student ideally walks away with notes they can revisit. When those steps live in spreadsheets, chat threads, and a calendar app, the operations team becomes the glue — and glue doesn't scale.

I designed and built **SessionOrbit** as a modern, centralized operations platform to address these pain points. This post goes beyond the feature list and into how the pieces are designed: the architecture, the data model, how scheduling conflicts are prevented at the database level, how attendance and billing are driven by webhooks, how the AI notes pipeline works, and how the collaborative whiteboard stays in sync.

## Platform Highlights

1. **Centralized Operations & Scheduling**:
   Automated real-time calendar bookings, attendance tracking, and teacher-student matching.
2. **40% Administrative Overhead Reduction**:
   Eliminated manual logging through automated webhook session triggers and instantaneous billing reconciliation.
3. **AI Assistance**:
   Integrated automated session notes, transcript summarization, and key concept indexing for students following each class.
4. **Real-time Synchronized Whiteboards**:
   Low-latency collaborative canvases built on top of WebSockets and canvas rendering.

The 40% reduction didn't come from any single clever feature. It came from systematically removing the moments where a human had to copy information from one place to another — and that principle shaped almost every design decision below.

## Technology Stack
- **Frontend**: React.js, TypeScript, TailwindCSS / Custom Design System
- **Backend**: Node.js, Express, Socket.io
- **Database**: PostgreSQL on Cloud SQL / Supabase
- **AI**: OpenAI API with custom prompt chains

### Why This Stack

- **PostgreSQL** was the most important choice. Scheduling and billing are fundamentally relational problems with hard correctness requirements, and Postgres gives me transactions, range types, and exclusion constraints — which, as you'll see, do a lot of the heavy lifting.
- **Node.js + Express + Socket.io** kept the REST API and the real-time layer in one language and let them share types and validation with the TypeScript frontend.
- **React + TypeScript + Tailwind** with a custom design system meant the many admin screens (calendars, rosters, billing tables) stayed visually consistent without a lot of bespoke CSS.
- **OpenAI API with prompt chains** rather than a single giant prompt, for reasons covered in the AI section.

## High-Level Architecture

```text
 ┌──────────────────────────── React + TypeScript SPA ─────────────────────────────┐
 │  Admin console  │  Teacher dashboard  │  Student / parent portal  │  Whiteboard   │
 └────────┬─────────────────────┬───────────────────────────────────────┬──────────┘
          │ REST (Express)      │ Socket.io (live updates)              │ Socket.io (whiteboard ops)
          ▼                     ▼                                       ▼
 ┌────────────────────────────────────────────────────────────────────────────────┐
 │                         Node.js application layer                              │
 │  Scheduling & matching │ Attendance │ Billing │ Webhook receiver │ Realtime hub  │
 └───────┬───────────────────────┬──────────────────────┬─────────────────────────┘
         │                       │                      │ enqueue post-session jobs
         ▼                       ▼                      ▼
 ┌───────────────┐      ┌─────────────────┐     ┌──────────────────────────┐
 │  PostgreSQL   │◀─────│ Video provider  │     │  AI worker               │
 │ (source of    │      │ webhooks        │     │  transcript → notes →    │
 │  truth)       │      │ (join/leave/end)│     │  summary → key concepts  │
 └───────────────┘      └─────────────────┘     └────────────┬─────────────┘
         ▲                                                   │ OpenAI API
         └───────────────────── results written back ────────┘
```

The guiding rule: **PostgreSQL is the source of truth; everything else reacts to it.** The socket layer pushes changes to connected clients after a transaction commits, the AI worker writes its results back to the database, and webhooks are translated into rows before anything else happens.

## Data Model Sketch

A simplified version of the core tables:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role        text NOT NULL CHECK (role IN ('admin', 'teacher', 'student', 'parent')),
  full_name   text NOT NULL,
  email       text UNIQUE NOT NULL,
  timezone    text NOT NULL DEFAULT 'UTC'
);

CREATE TABLE teacher_subjects (
  teacher_id  uuid REFERENCES users(id),
  subject     text NOT NULL,
  level       text NOT NULL,
  PRIMARY KEY (teacher_id, subject, level)
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid NOT NULL REFERENCES users(id),
  student_id  uuid NOT NULL REFERENCES users(id),
  subject     text NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'scheduled'
              CHECK (status IN ('scheduled', 'live', 'completed', 'cancelled', 'no_show')),
  during      tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  CHECK (ends_at > starts_at)
);

CREATE TABLE attendance_events (
  id                 bigserial PRIMARY KEY,
  session_id         uuid NOT NULL REFERENCES sessions(id),
  user_id            uuid REFERENCES users(id),
  kind               text NOT NULL CHECK (kind IN ('joined', 'left', 'meeting_ended')),
  occurred_at        timestamptz NOT NULL,
  provider_event_id  text UNIQUE NOT NULL   -- idempotency key from the webhook
);

CREATE TABLE billing_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid UNIQUE NOT NULL REFERENCES sessions(id), -- one entry per session
  amount      numeric(10, 2) NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session_notes (
  session_id    uuid PRIMARY KEY REFERENCES sessions(id),
  summary       text,
  key_concepts  jsonb,
  generated_at  timestamptz
);
```

Two things worth calling out: attendance is stored as an **append-only event log** rather than a single "attended" boolean, and the `UNIQUE` constraints on `provider_event_id` and `billing_entries.session_id` are what make the webhook pipeline safe to retry.

## Scheduling Without Double-Booking

The classic scheduling bug is a race: two admins (or an admin and an automated rebooking) check that a teacher is free at 4 pm, both see "free", and both insert. Application-level checks can't fully prevent this without careful locking.

Instead, I let PostgreSQL enforce it with **exclusion constraints** on the time range:

```sql
ALTER TABLE sessions
  ADD CONSTRAINT no_teacher_overlap
  EXCLUDE USING gist (teacher_id WITH =, during WITH &&)
  WHERE (status <> 'cancelled');

ALTER TABLE sessions
  ADD CONSTRAINT no_student_overlap
  EXCLUDE USING gist (student_id WITH =, during WITH &&)
  WHERE (status <> 'cancelled');
```

This reads as: "no two non-cancelled sessions may have the same teacher and overlapping time ranges." The `[)` bound on the range means a session ending at 5:00 doesn't conflict with one starting at 5:00. The `btree_gist` extension is what allows mixing the equality check on a UUID with the range-overlap check in one GiST index.

On the Node side, a violation surfaces as SQLSTATE `23P01`, which I translate into a friendly error:

```typescript
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function bookSession(input: {
  teacherId: string;
  studentId: string;
  subject: string;
  startsAt: Date;
  endsAt: Date;
}) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO sessions (teacher_id, student_id, subject, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.teacherId, input.studentId, input.subject, input.startsAt, input.endsAt],
    );
    return rows[0];
  } catch (err: any) {
    if (err.code === '23P01') {
      throw new ConflictError('That slot overlaps an existing session for this teacher or student.');
    }
    throw err;
  }
}
```

After the insert commits, the server emits a `calendar:changed` event to the relevant rooms so every open calendar updates immediately — that's the "real-time" part of real-time bookings. Times are always stored as `timestamptz` and converted to each user's timezone only at the edges, which avoids an entire category of daylight-saving bugs.

### Teacher-Student Matching

Matching is designed as a two-step query rather than a black box: first **filter** to teachers who teach the subject at the right level and have no overlapping session in the requested slot (the same range logic as the constraint, expressed as a `NOT EXISTS` with `&&`), then **rank** the candidates using simple, explainable signals such as whether the teacher has taught this student before. Keeping it explainable mattered — the operations team needs to understand *why* a teacher was suggested before they trust automation enough to stop double-checking it by hand.

## Webhook-Driven Attendance and Billing

Manual logging was one of the largest sources of administrative work: someone would check who joined each call and then update attendance and invoices. SessionOrbit replaces that with the video provider's webhooks (participant joined, participant left, meeting ended).

The receiver has three jobs: **verify**, **deduplicate**, and **record** — and do it fast.

```typescript
import express from 'express';
import crypto from 'node:crypto';

const router = express.Router();

router.post(
  '/webhooks/video',
  express.raw({ type: 'application/json' }), // need the raw bytes to verify the signature
  async (req, res) => {
    const signature = req.header('x-signature') ?? '';
    const expected = crypto
      .createHmac('sha256', process.env.VIDEO_WEBHOOK_SECRET!)
      .update(req.body)
      .digest('hex');

    const valid =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString('utf8'));

    // Idempotent insert: providers retry, and that's fine.
    await pool.query(
      `INSERT INTO attendance_events (session_id, user_id, kind, occurred_at, provider_event_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider_event_id) DO NOTHING`,
      [event.sessionId, event.userId, event.kind, event.timestamp, event.id],
    );

    if (event.kind === 'meeting_ended') {
      await jobs.enqueue('reconcile-session', { sessionId: event.sessionId });
      await jobs.enqueue('generate-notes', { sessionId: event.sessionId });
    }

    res.sendStatus(200);
  },
);
```

(The exact header name and payload shape depend on the provider; the pattern is the same.) The handler acknowledges quickly and pushes heavier work to background jobs, because webhook senders typically time out and retry slow endpoints.

### Billing Reconciliation

The `reconcile-session` job turns raw join/leave events into a final status and a billing entry, in a single transaction:

```sql
BEGIN;

UPDATE sessions
SET status = CASE
  WHEN EXISTS (
    SELECT 1 FROM attendance_events ae
    WHERE ae.session_id = $1 AND ae.user_id = sessions.student_id AND ae.kind = 'joined'
  ) THEN 'completed'
  ELSE 'no_show'
END
WHERE id = $1 AND status IN ('scheduled', 'live');

INSERT INTO billing_entries (session_id, amount)
SELECT s.id, $2
FROM sessions s
WHERE s.id = $1 AND s.status = 'completed'
ON CONFLICT (session_id) DO NOTHING;

COMMIT;
```

The real billing rules have more nuance (rates and policies are business decisions, so I keep them in configuration rather than code), but the important properties are visible here: the job is **idempotent** (running it twice produces one billing entry), **atomic** (status and billing never disagree), and **derived from events** (if a rule changes, it can be re-run against the stored log). That's what "instantaneous billing reconciliation" means in practice — the invoice line exists the moment the session ends, without anyone typing it in.

## AI Assistance: Notes, Summaries, and Key Concepts

After each class, students get automated session notes, a transcript summary, and an index of key concepts. The pipeline runs in a background worker triggered by the `generate-notes` job.

### Why a Prompt Chain Instead of One Prompt

A full session transcript can be long, and asking one prompt to "summarize this and extract concepts and write notes" tends to produce output that's vague in the middle and hard to validate. Splitting the work into stages makes each step smaller, easier to evaluate, and easier to retry independently:

| Stage | Input | Output |
| --- | --- | --- |
| 1. Chunk | Raw transcript | Overlapping chunks sized to fit the model's context comfortably |
| 2. Extract | Each chunk | Bullet-point notes: explanations, examples, questions asked |
| 3. Summarize | All chunk notes | A concise, student-facing session summary |
| 4. Index | Summary + notes | Structured JSON list of key concepts |

```typescript
import OpenAI from 'openai';

const openai = new OpenAI(); // reads OPENAI_API_KEY
const MODEL = process.env.NOTES_MODEL!;

async function complete(system: string, user: string, json = false) {
  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...(json ? { response_format: { type: 'json_object' as const } } : {}),
  });
  return res.choices[0].message.content ?? '';
}

export async function generateSessionNotes(transcript: string, subject: string) {
  const chunks = chunkTranscript(transcript, { maxChars: 12000, overlap: 500 });

  // Stage 2: extract notes per chunk (in parallel).
  const chunkNotes = await Promise.all(
    chunks.map((chunk) =>
      complete(
        `You are a teaching assistant for a ${subject} tutoring session. ` +
          'Extract concise bullet-point notes: concepts explained, worked examples, ' +
          'and questions the student asked. Only use what is in the transcript.',
        chunk,
      ),
    ),
  );

  // Stage 3: merge into a student-facing summary.
  const summary = await complete(
    'Combine these notes into a clear summary a student can review later. ' +
      'Use short sections and avoid repeating points.',
    chunkNotes.join('\n\n'),
  );

  // Stage 4: structured key concepts for indexing and search.
  const conceptsRaw = await complete(
    'Return JSON of the form {"concepts":[{"name": string, "description": string}]} ' +
      'listing the key concepts covered. Only include concepts present in the notes.',
    summary,
    true,
  );

  const { concepts } = JSON.parse(conceptsRaw);
  return { summary, concepts };
}
```

The results land in `session_notes`, with `key_concepts` as `jsonb` so the student portal can filter and search concepts across sessions. A few practical guardrails:

- **Grounding instructions** ("only use what is in the transcript") noticeably reduce made-up content.
- **Low temperature** keeps notes consistent from session to session.
- **Validate the JSON** before saving and retry the indexing stage alone on failure — one of the main benefits of chaining.
- **Run it asynchronously.** Nobody is waiting on a spinner; the notes appear when they're ready and the student gets notified.

## Real-Time Synchronized Whiteboards

The whiteboard is the most latency-sensitive part of the platform. Rather than syncing pixels or whole canvas snapshots, it broadcasts **operations**: small, serializable descriptions of what changed.

```typescript
type WhiteboardOp =
  | { type: 'stroke:start'; id: string; color: string; width: number; point: [number, number] }
  | { type: 'stroke:points'; id: string; points: [number, number][] }
  | { type: 'stroke:end'; id: string }
  | { type: 'clear' };
```

On the server, each session's board is a Socket.io room. Ops are validated, appended to an in-memory log, and relayed to everyone else in the room:

```typescript
io.of('/whiteboard').on('connection', async (socket) => {
  const { sessionId } = socket.handshake.query as { sessionId: string };
  if (!(await canJoinSession(socket.data.user, sessionId))) return socket.disconnect(true);

  const room = `board:${sessionId}`;
  await socket.join(room);

  // Late joiners replay the op log to reconstruct the canvas.
  socket.emit('board:init', await boardStore.getOps(sessionId));

  socket.on('board:op', async (op: WhiteboardOp) => {
    if (!isValidOp(op)) return;
    await boardStore.append(sessionId, op);
    socket.to(room).emit('board:op', op); // everyone except the sender
  });

  // Cursor positions are ephemeral: drop them rather than queue them.
  socket.on('cursor:move', (pos) => {
    socket.volatile.to(room).emit('cursor:move', { userId: socket.data.user.id, ...pos });
  });
});
```

On the client, a few techniques keep it smooth:

- **Optimistic local rendering.** The drawer's stroke is painted immediately; the network is only for everyone else.
- **Batching points.** Pointer events fire far more often than the network needs. Points are buffered and sent as one `stroke:points` op per animation frame.
- **Layered canvases.** Completed strokes are drawn onto a background canvas once; only in-progress strokes and cursors are redrawn on a lightweight top layer.
- **Volatile cursors.** `socket.volatile` lets cursor updates be dropped under pressure — a stale cursor position is useless, so there's no point queuing it.
- **Snapshotting the log.** For long sessions, periodically collapsing the op log into a snapshot keeps late-join replay fast.

## Pitfalls and Lessons Learned

- **Enforce invariants in the database.** Double-booking checks in application code alone kept leaving room for races. The exclusion constraint closed that class of bugs for good.
- **Assume webhooks are duplicated, delayed, and out of order.** Idempotency keys, an append-only event log, and reconciliation that derives state from events made the pipeline robust to all three.
- **Store time as `timestamptz`, render in the user's timezone.** Tutoring across regions makes timezone bugs inevitable otherwise.
- **Keep AI output grounded and asynchronous.** A smaller, staged prompt chain was easier to debug and trust than one large prompt.
- **Don't sync pixels.** Operation-based sync with a replayable log made the whiteboard both lighter on bandwidth and easier to recover after reconnects.

## Key Takeaways

- Administrative overhead drops when you remove manual hand-offs, not when you add dashboards on top of them.
- PostgreSQL range types and exclusion constraints are a clean, race-free answer to scheduling conflicts.
- Webhook pipelines should verify, deduplicate, record, and defer — in that order.
- Prompt chains turn "summarize this class" into a series of small, testable, retryable steps.
- Real-time collaboration works best when you broadcast small operations and treat ephemeral data (like cursors) as droppable.

## Conclusion

SessionOrbit started as a way to stop the operations team from acting as human middleware between calendars, video calls, spreadsheets, and invoices. The features on the surface — real-time scheduling, automated attendance and billing, AI-generated notes, and a live whiteboard — all rest on the same few foundations: a relational source of truth with strong constraints, event-driven automation that's safe to retry, and real-time delivery layered on top. Getting those foundations right is what made the 40% reduction in administrative overhead possible, and it's the approach I'd take again for any coordination-heavy platform.
