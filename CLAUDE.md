# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and run

Two TypeScript build outputs coexist — they are not interchangeable:

- `tsconfig.json` — Next.js front-end (`pages/`, `lib/react/`, `lib/redux/`, `lib/view/`, `lib/i18n/`, plus the JSX-free helpers in `lib/flightprocessing/taskhelper.ts`). `noEmit: true`; Next compiles via SWC.
- `tsconfig-bin.json` — every CLI/daemon in `bin/` and the rest of `lib/` (workers, scoring, flightprocessing internals, scraping). Emits CommonJS into `dist/`. Several files are excluded from `tsconfig.json` because they import worker-only modules.

Common commands:

```
yarn build              # protobuf + tsc for daemons (run before bin/* scripts)
yarn build:protobuf     # only the .proto -> ts regen
yarn dev                # next dev (webpack mode)
yarn ogn                # OGN/APRS daemon (frontends connect via its websocket)
yarn ssscrape           # data sync daemon: drives SoaringSpot OAuth API, HTML scrape, and SGP sources
yarn rst                # RST Online sync
yarn ogn:dev            # tsc-watch + node --inspect (auto-restarts on rebuild)
yarn ssscrape:dev       # same pattern for the scoring scraper
yarn test               # vitest run (test/**/*.test.ts)
yarn test:watch         # vitest watch
```

Run a single test file:
```
yarn vitest run test/trackerScore.test.ts
```

`yarn build:protobuf` regenerates `lib/protobuf/onglide.ts` from `onglide.proto` via `protoc` + `ts-proto`. You need `protoc` installed locally. If types in `OnglideWebSocketMessage` look stale, rerun this before debugging.

Prettier: 4-space, **225-char print width**, single quotes, no bracket spacing, no trailing comma. Don't fight it on long lines — the config is wide on purpose.

## Architecture

This is a soaring-competition tracking platform. The repo runs as **two cooperating processes** that share a MySQL DB:

1. **`bin/ogn.ts`** — long-running daemon that subscribes to the OGN APRS feed, scores every pilot in real time, and exposes a websocket (`ws://…:8080`) to browsers. Owns all scoring state in-process.
2. **`bin/ssscrape.ts`** — the scoring scraper daemon. Runs the scheduler in `lib/scoring/scheduler.ts`, which drives every registered `ScoringSource` adapter: SoaringSpot OAuth API, SoaringSpot HTML scrape, SGP, and robocontrol (tracker-only). The choice of primary upstream is per-competition via a row in `scoringsource`; robocontrol rows are orthogonal and coexist with the primary. **`bin/rst.ts`** is the legacy RST sync (still its own daemon — not a `ScoringSource`).
3. **Next.js (`pages/`)** — front-end. Reads competition metadata via `getServerSideProps` (direct DB), then connects to the OGN daemon's websocket for live tracks + scores. Almost no API routes; live state flows over the websocket, not REST.

### Front-end → daemon channel

The browser opens one websocket to the OGN daemon. Two channel kinds:

- `all` — reserved global feed (landing page globe). Daemon sends a full snapshot of every active comp on connect, then deltas.
- `{ClassName}{Datecode}` — per-class live tracks + scores for one comp day.

Wire format is **protobuf** (`OnglideWebSocketMessage` in `lib/protobuf/onglide.proto`). Adding a websocket field means editing the `.proto` and rerunning `yarn build:protobuf`.

Client decode happens in `lib/react/useWebsocketDecoder.tsx`, which dispatches into Redux slices in `lib/redux/` (`tracksSlice`, `scoresSlice`, `taskSlice`, `nowSlice`, `otherPilotsSlice`, `competitionsSlice`). Components subscribe via `useSelector`; deck.gl layers in `lib/react/*Layer*.ts(x)` read from Redux.

### Tracks & scores broadcast

Tracks are not streamed per-position. They're bulk-broadcast via `generateRecentPilotTracks(channel)` in `bin/ogn.ts`, called only from:

- `sendCurrentState` — new client connect (sends to one client)
- `_live` handler in `sendScore` — channel scoring transitions to live
- `finaliseTracksBroadcast` — after `updateTrackers` when new pilots were configured this tick

`generateRecentPilotTracks` first calls `generateHistoricalTracks`, which (every ~5 min, or whenever `channel.webPathBaseTime` is 0) freezes the prior window into `channel.webPathData[now]` and bumps `webPathBaseTime = now`. The frozen snapshot is served from RAM at `/tracks/{CLASS}{DATECODE}.{baseTime}.bin` (`Cache-Control: immutable max-age=300`). The websocket message carries only the delta past the snapshot plus the current `baseTime`.

Client reconciliation (`lib/redux/tracksSlice.ts`):
- `baseTime === 0` in the message → erase existing decks, apply residual inline (no HTTP fetch).
- `baseTime > 0` → fetch the snapshot URL (its internal `baseTime: 0` triggers erase), then apply the residual delta.
- `trackVersion` (random uint32 stamped on each `initialiseDeck`) is the *per-pilot* equivalent: mismatch triggers a per-pilot deck rebuild regardless of `baseTime`. Only changes when the deck is rebuilt from scratch — first pilot setup (`ogn.ts:1961`) or a `message.t == 0` reset from the scoring worker (`ogn.ts:2964`). It does **not** change on rescore, `_live`, or `utcStart` changes.

`primeAndBroadcast(channel, label)` wraps `generateRecentPilotTracks` for all-clients broadcasts: before sending, it fires a self-GET via `NEXT_PUBLIC_HISTORY_HOST || NEXT_PUBLIC_SITEURL` (1s timeout, best-effort) to warm the upstream proxy/CDN cache so concurrent client fetches hit warm. Single-client sends skip the prime.

Convention: deferred channel-level work uses a `*Required` boolean on `Channel`, consumed by a `finalise*` function called from `tickCompetitionTrackersAndTasks` — see `scoreIdUpdateRequired`/`finaliseScoreId` and `tracksBroadcastRequired`/`finaliseTracksBroadcast`.

Scores broadcast on three paths:
- Live per-pilot — `sendScore` emits `{scores: {scoreId, pilots: {[compno]: score}}}` on every `score.live`.
- Bulk — `sendAllScores` (on connect) and `sendIdentifiersToAll(channel, includeScore=true)` (on `_live`).
- Historical — served via HTTP at `/scorehistory/{CLASS}{DATECODE}.{timestamp}/{scoreId}.bin` in 30-min chunks from `channel.scoreHistory`.

### Scoring pipeline (the core of `bin/ogn.ts`)

Scoring is an **async-generator chain**, one chain per glider. APRS packets feed in at the top; scored output flows out the bottom. From `lib/webworkers/scoring.ts`:

```
APRS (broadcast channel, per ClassName_Compno)
  → inordergenerator        (sort/de-dup, allow backtracking)
  → enrichedPositionGenerator (AGL, status flags)
  → taskpositiongenerator    (which leg / sector / start / finish)
  → racingScoringGenerator | assignedAreaScoringGenerator
  → taskScoresGenerator
  → scoreCollector (everysooftengenerator throttles fan-out)
  → broadcast channel (per ClassName) → websocket clients
```

Threads: `[APRS worker] → [Scoring worker] → [main / websocket]`. Inter-thread comms is `BroadcastChannel` from `node:worker_threads`. A full rescore is implemented by destroying and rebuilding the per-pilot generator chain — not by mutating state in place.

Generators in `lib/webworkers/` receive a `log` parameter; **use it, not `console.log`**, so the per-pilot prefix gets attached.

### Scoring sources (data-sync adapters)

`lib/scoring/scheduler.ts` runs a 60-second heartbeat in competition-local time and decides what's due to fetch. Each upstream — SoaringSpot OAuth, SoaringSpot scrape, SGP, and robocontrol — implements the `ScoringSource` interface in `lib/scoring/source.ts` and hands parsed records to the shared helpers in `lib/scoring/shared/` (pilots, tasks, classes, airfield, trackers). The adapter knows nothing about timing; the scheduler knows nothing about HTTP. RST is *not* a `ScoringSource` yet — it runs as the standalone `bin/rst.ts` daemon. Adding a new upstream = new file under `lib/scoring/sources/` registered in `bin/ssscrape.ts`.

**Four independent streams per heartbeat.** The scheduler dispatches pilots, tasks, results, and trackers separately, each on its own cadence and gate:

- **pilots** — daily 10:00 local gate, plus urgent path when the comp is active but the DB is empty.
- **tasks** — per-class cadence via `desiredTaskCadence`: FAST (10 min) while pre-task or status='L'; SLOW (30 min) for briefed-pre-launch or post-start; stops once every today-class is F/H/Z or past its `30m + 1m × pilotsInClass` post-launch window. Stop at 22:00 local. An adapter may set `activeTasksCadenceMs` to override the L/S cadence — SGP uses 60 s because its task+tracks JSON is cheap and the L→S `nostart` rewrite (start-line time) needs to land in seconds. The "fast"/"slow" reason labels were replaced by `formatCadence` (e.g. `1m`, `10m`, `30m`).
- **results** — gated on the sticky `everFOrHToday` (any class today has hit `'F'` or `'H'`) OR `localNow >= 18:00`. SLOW (30 min) cadence until 22:00.
- **trackers** — per-adapter `trackerIntervalMs` (SGP 5 min, OAuth/robocontrol 15 min) between 10:00 and 22:00; drops to hourly once every non-`'Z'` today-class is `'F'` or `'H'`. Adapters that don't expose `fetchTrackers` are skipped. SGP's `fetchTrackers` installs the task from the same JSON payload it already pulls for pilots/trackers — so the 5-min trackers cadence picks up tasks for free, and the separate tasks-cadence GET is only the extra polling above that.

On daemon startup `initSourceState` jitters the first per-stream fetch over `STARTUP_JITTER_MS` (5 min). The 30-min `oneSidedJitter` is reserved for "tomorrow at HH:MM local" parking — using it for first-fetch would swallow the entire FAST tasks cadence on a restart during launch.

Dispatch state (`nextPilotsAt` / `nextTasksAt` / `nextResultsAt` / `nextTrackersAt` and the `lastXFetch` bookkeeping) lives in `SourceState` keyed by `ScoringSource.type` inside each `CompState` — so robocontrol's no-op pilots/results stubs can't advance the primary adapter's timestamps. Comp-wide state (`observations`, `firstLaunch`, `everFOrHToday`, comp window, pilot/task counts) stays at the `CompState` level.

Each `ClassObservation` carries `laststatuschange` (UTC epoch ms, from `compstatus.laststatuschange`, maintained by BEFORE INSERT/UPDATE triggers that bump only on real transitions — see `conf/sql/onglide_schema.sql`). The scheduler uses it on restart as a fallback to seed `firstLaunch` for classes already in L/S/F, so the post-launch task window is anchored even when the in-memory map is empty.

**Override gate.** A comp with a `scoringsource` row of `type='soaringspotkey'` suppresses its `soaringspotscrape` row (the OAuth API is authoritative). Robocontrol is not suppressed — see `OVERRIDE_TARGET_TYPES` in `scheduler.ts`.

**Debug.** `dumpSchedulerState()` is exported from the scheduler and wired to `SIGUSR1` in `bin/ssscrape.ts`. `kill -USR1 <pid>` prints the full per-comp / per-source state to stdout.

### Task geometry

`lib/flightprocessing/taskhelper.ts` (`calculateTask`) builds the in-memory `Task` (turnpoints with prepared line/sector geometry). `PreparedTurnpoint.hasCrossed(prev, pos)` is the line-crossing primitive used everywhere — including `findtrackers`, scoring, and the AAT max-distance graph. `taskBbox` produces the APRS pre-filter bbox.

AAT (Assigned Area Task) optimal-distance computation uses a Dijkstra-style graph in `lib/flightprocessing/dijkstras.ts` + `computeOptimalGrid.ts` and is visualised through `lib/react/optimalDirection.ts` / `optimalGridLayers.tsx`. Active refactor in flight on the `all_of_it` branch (see memory).

### findtrackers / matchtrackers

`bin/findtrackers.ts` (+ `lib/scoring/shared/findtrackers.ts`, `lib/scoring/shared/trackerScore.ts`) identifies which FLARM ID belongs to which pilot by replaying APRS against the day's start/finish lines and scoring crossings in log-likelihood units. See `findtrackers.md` at repo root for the full design doc — it's the authoritative reference for that pipeline.

### Map rendering

Vector basemap is a single self-hosted `.pmtiles` file served over HTTP range requests (no tile server). Style assembled in `lib/react/mapStyle.ts`; overlays are deck.gl layers in `lib/react/*Layer*.ts(x)` composed in `lib/react/deckgl.tsx`. Glyph fonts are pre-baked SDF atlases under `public/fonts/glyphs/` (see `readme.md` for `build-glyphs` recipe).

## Repository quirks

- `dist/` is the build output for daemons — don't edit it. `nextdest/` is similar for the front-end type-check pass.
- Emacs leaves `*~` and `#…#` backup files alongside their real counterparts; `.gitignore` excludes them so they never make it into commits.
- `.aprs` files at the repo root are recorded APRS logs used for replay/testing (large — `476.aprs` is ~230 MB).
- The Next.js version pinned here **is not safe to expose directly** — always run behind Apache/Cloudflare (see `readme.md`).
- `readme.md` (lowercase) is the operator's deployment guide. It documents env vars (`NEXT_PUBLIC_PMTILES_URL`, `MYSQL_PASSWORD`, `SOARINGSPOT_*`, `ROBOCONTROL_URL`, etc.), Planetiler invocations for pmtiles, and the docker-compose topology (`mysql`, `soaringspot`, `ogn`, `next`, `apache`).

## Error handling

Catch errors only to handle a *specific, expected* condition; report everything else loudly. The failure mode to avoid is a broad catch that swallows a real bug as if it were the expected case — it turns a crash into a silent no-op that wastes far more time to diagnose than the original error would have. These principles hold everywhere; **where an unexpected error goes differs by execution context** (below).

- Make the catch predicate as narrow as the condition it handles. Example: a migration-not-applied skip should match a genuinely-absent table (`ER_NO_SUCH_TABLE`) **only** — *not* `Unknown column`, which means the table exists but is the wrong shape (a real bug). See `isMissingTable` in `bin/findtrackers.ts`; same shape as the `EADDRINUSE`-only catch in `bin/ogn.ts` (rethrows anything else).
- An unexpected error must never be downgraded to a warning or quietly ignored — it either crashes (CLI) or aborts just its unit of work *with a logged reason* (daemon). Never both swallowed and unlogged.
- A latched "feature unavailable" flag (e.g. `identityTablesUnavailable`, `priorEvidenceUnavailable`) must only ever be set by the narrow expected-condition branch. If it can also latch on an unexpected error, one swallowed failure silences the feature for the whole run.
- When a code path legitimately does nothing, say so on stdout (counts, "skipped: <reason>"). A run that produces no output and no error must be indistinguishable from success only when it *was* success.

**CLI / one-shot tools** (`bin/findtrackers.ts`, `bin/rst.ts`, `ssscrape --refetch`/arg-validation): an unexpected error should propagate to the top-level `main().catch` → `console.error` + **non-zero exit**, or `process.exit(1)` at the handling site. A failed one-shot must exit non-zero so the caller/cron sees it.

**Long-running daemons** (`bin/ogn.ts` tick loop, `bin/ssscrape.ts` scheduler): a single bad unit of work must **not** crash the process. The catch boundary is the loop body — per-competition, per-packet, per-heartbeat — not the top level:
- Wrap each unit and continue: `for (const comp of …) { try { await tickCompetition(comp) } catch (e) { console.error(\`tickCompetition(${comp.compid}) failed:\`, e) } }` (`bin/ogn.ts`). Always log with the identifying context (compid / datecode / flarmid) so the failing unit is identifiable.
- Background/fire-and-forget work uses `.catch((e) => console.log('<name> failed', e))` (the sweeps, `runScheduler`, `notifyCompetitionDelta`) — log and keep serving.
- Reserve `process.exit` for signal-driven graceful shutdown (`handleExit`) and unrecoverable startup failures — not for routine per-iteration errors.

# IMPORTANT

*DO NOT SPECULATE ABOUT HOW COMPETITIONS WORK IN COMMENTS - include information only if provided in discussion or review of rules*
