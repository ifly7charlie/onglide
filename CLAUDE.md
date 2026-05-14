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
yarn soaringspot        # data sync from SoaringSpot (OAuth API)
yarn ssscrape           # data sync via HTML scrape; also drives SGP sources
yarn rst                # RST Online sync
yarn ogn:dev            # tsc-watch + node --inspect (auto-restarts on rebuild)
yarn soaringspot:dev    # same pattern for the scraper
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
2. **`bin/{soaringspot,ssscrape,rst,sgp}.ts`** — one of these runs alongside `ogn.ts` to pull pilots / tasks / results from the contest's upstream system into the DB. Choice depends on the contest (see `readme.md`).
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

`lib/scoring/scheduler.ts` runs a 60-second heartbeat in competition-local time and decides what's due to fetch. Each upstream (SoaringSpot OAuth, SoaringSpot scrape, RST, SGP) implements the `ScoringSource` interface in `lib/scoring/source.ts` and hands parsed records to the shared helpers in `lib/scoring/shared/` (pilots, tasks, classes, airfield). The adapter knows nothing about timing; the scheduler knows nothing about HTTP. Adding a new upstream = new file under `lib/scoring/sources/` + a `bin/` entry point.

### Task geometry

`lib/flightprocessing/taskhelper.ts` (`calculateTask`) builds the in-memory `Task` (turnpoints with prepared line/sector geometry). `PreparedTurnpoint.hasCrossed(prev, pos)` is the line-crossing primitive used everywhere — including `findtrackers`, scoring, and the AAT max-distance graph. `taskBbox` produces the APRS pre-filter bbox.

AAT (Assigned Area Task) optimal-distance computation uses a Dijkstra-style graph in `lib/flightprocessing/dijkstras.ts` + `computeOptimalGrid.ts` and is visualised through `lib/react/optimalDirection.ts` / `optimalGridLayers.tsx`. Active refactor in flight on the `all_of_it` branch (see memory).

### findtrackers / matchtrackers

`bin/findtrackers.ts` (+ `lib/scoring/shared/findtrackers.ts`, `lib/scoring/shared/trackerScore.ts`) identifies which FLARM ID belongs to which pilot by replaying APRS against the day's start/finish lines and scoring crossings in log-likelihood units. See `findtrackers.md` at repo root for the full design doc — it's the authoritative reference for that pipeline.

### Map rendering

Vector basemap is a single self-hosted `.pmtiles` file served over HTTP range requests (no tile server). Style assembled in `lib/react/mapStyle.ts`; overlays are deck.gl layers in `lib/react/*Layer*.ts(x)` composed in `lib/react/deckgl.tsx`. Glyph fonts are pre-baked SDF atlases under `public/fonts/glyphs/` (see `readme.md` for `build-glyphs` recipe).

## Repository quirks

- `dist/` is the build output for daemons — don't edit it. `nextdest/` is similar for the front-end type-check pass.
- A few stray `*~` and `#…#` editor backup files are checked in alongside their real counterparts; ignore them.
- `.aprs` files at the repo root are recorded APRS logs used for replay/testing (large — `476.aprs` is ~230 MB).
- The Next.js version pinned here **is not safe to expose directly** — always run behind Apache/Cloudflare (see `readme.md`).
- `readme.md` (lowercase) is the operator's deployment guide. It documents env vars (`NEXT_PUBLIC_PMTILES_URL`, `MYSQL_PASSWORD`, `SOARINGSPOT_*`, `ROBOCONTROL_URL`, etc.), Planetiler invocations for pmtiles, and the docker-compose topology (`mysql`, `soaringspot`, `ogn`, `next`, `apache`).

# IMPORTANT

*DO NOT SPECULATE ABOUT HOW COMPETITIONS WORK IN COMMENTS - include information only if provided in discussion or review of rules*
