# Download Lane Isolation — Design

**Date:** 2026-06-22
**Status:** Approved (design); spec under review
**Scope:** Foundation for turning FDM into a general-purpose download manager without
letting casual/secondary downloads disturb the primary Drive/Dropbox footage work.

## Goal

FDM's primary purpose is large Drive/Dropbox footage downloads. We want to add
secondary download types (generic HTTP URLs, later browser captures and torrents)
**without ever slowing the primary work**. This spec defines the *scheduling lane
model* that enforces that, plus a **minimal generic HTTP download** so the lanes
are real and testable.

This spec deliberately does NOT build: full generic-download UX, browser capture,
or torrents. Those are later projects that layer onto the lanes defined here.

## Lane model

Every download belongs to exactly one **lane**, decided by its source:

- **PRIMARY** — Google Drive, Dropbox, their share-links, and BDM-dispatched jobs.
  Concretely: account ids beginning `drive`, `drivelink`, `dropbox`, `dropboxlink`.
- **SECONDARY** — everything else. For this spec: generic HTTP(S) URL downloads.
  Later: browser captures, torrents.

Classification is a pure function of the item, not user choice.

## Scheduling rules

1. **Priority gate.** A secondary download may start **only when the primary lane is
   empty** — no primary download active **and** no startable (non-user-paused) primary
   queued. While the primary lane has any work to do, secondary stays queued.
2. **Preemption.** When a primary download becomes active while a secondary is running,
   the secondary **auto-pauses immediately** (its `.fdmpart`/`.fdmmeta` partial is kept)
   and returns to the queue.
3. **Auto-resume.** When the primary lane drains (no active, no startable-queued primary),
   auto-paused secondary downloads resume from their bitmaps, up to the secondary
   concurrency limit.
4. **Auto-pause ≠ user-pause.** A download the *user* paused stays paused and is never
   auto-resumed. Only lane-gated (auto-paused) downloads auto-resume. These are tracked
   by distinct flags.
5. **Per-lane concurrency.** Each lane has its own concurrency limit. Primary keeps the
   existing `download_concurrency` setting; secondary gets its own (default 3). Because
   the lanes never run simultaneously (rule 2), the two limits never compete.

### Why no bandwidth-splitting

Because a running secondary is preempted the instant primary starts, **the two lanes
never transfer at the same time**. There is therefore no bandwidth contention to
arbitrate — the existing global token-bucket cap (`set_bw_limit`) is sufficient as-is.
Isolation is a *scheduling gate*, not a throttle. This removes an entire subsystem
(per-lane buckets, dynamic throttling) from the build.

## Architecture

The scheduler already lives in the frontend (`src/store/transfers.ts` — the `pump()`),
and the Rust engine already supports pause (cancel flag preserves the partial) and
resume (block bitmap). Isolation reuses both; the gate is pure orchestration.

### Components

- **`src/lib/lane.ts`** (new, pure, unit-tested)
  - `laneOf(accountId: string): 'primary' | 'secondary'` — classify by id prefix.
  - One responsibility, no dependencies, trivially testable.

- **`src/store/transfers.ts`** (modified — the scheduler)
  - `QueueItem` / `InflightItem` gain a derived `lane` and a new `autoPaused?: boolean`
    flag (distinct from the existing user `paused`).
  - `pump()` rewrite:
    1. Start startable **primary** items up to `primaryConcurrency`.
    2. Compute `primaryBusy` = any active primary **or** any startable-queued primary.
    3. If `primaryBusy`: auto-pause every active **secondary** (cancel job, keep partial,
       requeue with `autoPaused: true`); start no secondary.
    4. Else: clear `autoPaused` on gated secondary and start secondary up to
       `secondaryConcurrency`.
  - `refresh()` already reconciles jobs; extend it to drive auto-resume when the primary
    lane drains.
  - Reuses existing `cancelJob` (keeps `.fdmpart`) and bitmap resume — no new engine
    pause path.

- **Minimal generic HTTP download** (so the secondary lane is real)
  - **Rust `provider.rs`**: add `Kind::Http`. `send_range` for `Http` issues a plain
    ranged GET against the URL (no bearer, no provider auth).
  - **Rust `transfer.rs`**: `Auth` becomes a no-op for `Http` (no token fetch/refresh).
    A generic item carries the URL in the existing `fid` field; filename from the URL
    path or `Content-Disposition`.
  - **Command**: `add_url_download(url, dest)` (or a synthetic `DownloadItem` through the
    existing `start_download`) that enqueues a single-file secondary job.
  - **UI**: a minimal "Download from URL" input (paste URL → pick dest → enqueue). This
    is intentionally bare; the polished generic-download UX is a later project.

### UI

- A small **lane badge** on each download row (e.g. "Drive"/"Dropbox" vs "Web").
- Gated secondary rows show a **"Waiting for Drive/Dropbox to finish"** state instead of
  a generic queued state, so the behavior is legible.

## Data flow

```
enqueue(item) → laneOf(item) tags lane → pump():
  primary items → start (existing path)
  primaryBusy? → auto-pause active secondary (cancel+requeue autoPaused)
  primary drained? → auto-resume autoPaused secondary, then start queued secondary
```

State persists in the existing localStorage queue/inflight; `lane` is re-derivable and
`autoPaused` is persisted so a relaunch mid-gate restores correctly.

## Error handling

- Auto-pause uses the same path as user-pause: the worker sees the cancel flag, stops,
  leaves the partial. No new failure mode.
- If a secondary fails (network), it follows the existing failed→Resume-from-history flow.
- A generic URL that doesn't support Range falls back to a single non-resumable stream
  (still gated/preemptible at the request boundary; a preempt mid-stream restarts that
  file — acceptable for v1, noted as a limitation).

## Testing

- **Unit (`lane.ts`):** classification of every id prefix → correct lane.
- **Unit (scheduler):** with a mocked job list, assert: secondary never starts while
  primary busy; active secondary auto-pauses on primary start; auto-paused resumes on
  primary drain; user-paused never auto-resumes; per-lane concurrency respected.
- **Manual E2E:** start a generic URL download; start a Drive download → the URL download
  pauses immediately; finish/cancel Drive → URL download resumes from its partial.

## Out of scope (later projects, layered on these lanes)

- Full generic-download UX (multi-URL, history, content-type handling).
- Browser/Chrome capture (extension + native-messaging host).
- Torrents (embedded BitTorrent client, seed/peer, ratio). Note: when built, a torrent
  is a secondary job; seeding pauses under primary too (refine in that project).
- Review-player quality/proxy transcoding (separate brainstorm — next).

## Known boundaries

- The scheduler lives in the frontend, so downloads are driven while the app/webview is
  open (already true today). Headless/background scheduling is out of scope.
