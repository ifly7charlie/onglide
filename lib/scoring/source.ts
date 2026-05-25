// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// ScoringSource — adapter interface that the scoring scheduler talks to.
//
// The scheduler in `lib/scoring/scheduler.ts` decides *when* to fetch
// pilots / tasks / results based on competition-local time and the cached
// per-class compstatus. It does not care *how* the data gets pulled in;
// each implementation of this interface knows how to talk to one upstream
// (SoaringSpot HTML scrape, RST HTML scrape, SoaringSpot OAuth API, …) and
// hands parsed records off to the shared helpers in `lib/scoring/shared/*`
// for DB writes.
//

import type {Datecode} from '../types';

// Branded string aliases so the scheduler/adapter contract is harder to
// mix up with arbitrary strings. They're plain `string` at runtime.
export type ClassId = string;
export type CompNo = string;

//
// SourceCtx — handed to every adapter call. Carries the things the
// adapter needs from the scheduler (db handle, log fn, the `scoringsource`
// row's compid+url, and the cached competition timezone) without coupling
// adapters to the scheduler's internal state.
//
export interface SourceCtx {
    compid: string;
    url: string;
    tz: string; // IANA timezone, mirrored from competition.tz
    countrycode: string | null; // ISO alpha-2, mirrored from competition.countrycode
    db: any; // serverless-mysql instance
    log: (msg: string, ...args: unknown[]) => void;
    // Per-source row from `scoringsource` — adapters may pluck extra fields
    // (e.g. RST's contest_name) without us having to widen this interface.
    raw: Record<string, any>;
}

//
// FetchPilotsResult — what the scheduler needs back after a pilot fetch.
// `observed` is `classid -> set of compnos seen this fetch`; the scheduler
// uses it to prune pilots that have disappeared from the source. Adapters
// already write the rows themselves via the shared helpers; this is just
// a watermark.
//
export interface FetchPilotsResult {
    observed: Map<ClassId, Set<CompNo>>;
}

//
// FetchResultsResult — `observedClasses` is the set of classids the source
// reported in this fetch. The scheduler diffs it against `classes WHERE
// compid = ?` and cascade-deletes any classid in DB but missing from the
// source (rule 5).
//
export interface FetchResultsResult {
    observedClasses: Set<ClassId>;
}

//
// SkipDayPredicate — passed by the scheduler into fetchResultsAndTasks so
// the adapter can short-circuit per-day work for days the scheduler has
// already classified as "old" under rule 1. Returning `true` means
// "do not fetch, do not write".
//
export type SkipDayPredicate = (classid: ClassId, datecode: Datecode, dateISO: string) => boolean;

//
// FetchResultsOptions — additional flags the scheduler can pass to
// `fetchResultsAndTasks`. `tasksOnly` is set on the fast pre-task
// cadence: the adapter should still walk the overview page and import
// any newly-published task, but skip the per-pilot results parsing
// (no class has a task yet, so there are no results to fetch).
//
// `resultsOnly` is the symmetric flag for the results-cadence path:
// the adapter should skip the tasks HTTP chain entirely and only
// fetch/import per-pilot results. Used by the scheduler once results
// polling is allowed (post-F or post-18:00 local).
//
// `forceResults` overrides the adapter's "skip results for any day
// that isn't local today" safety check. Set only by CLI one-shot mode
// when the user has explicitly asked for a specific (class, datecode).
//
// `acceptYesterday` widens the "today only" gate to also accept the
// previous local day. The scheduler sets this on the first results
// fetch of each local day so any late-settling results from yesterday
// land before the front-end's datecode rolls over.
//
export interface FetchResultsOptions {
    tasksOnly?: boolean;
    resultsOnly?: boolean;
    forceResults?: boolean;
    acceptYesterday?: boolean;
}

//
// FetchPilotsOptions — options for the pilots fetch path. `skipPrune`
// suppresses `pruneUnseenPilots` (and per-pilot pilotresult writes)
// so the higher-cadence trackers stream can re-use the contestants
// endpoint without risking a flaky upstream wiping the roster.
//
export interface FetchPilotsOptions {
    skipPrune?: boolean;
}

//
// DiscoverCtx / DiscoveredCompetition — handed to the (optional) daily
// discovery hook. Each adapter exposing `discoverCompetitions()` returns
// the (compid, url) pairs it currently sees as "in progress" or
// "upcoming" on its upstream index page; the scheduler INSERT IGNOREs
// them into `scoringsource` so the normal heartbeat picks them up.
//
export interface DiscoverCtx {
    db: any;
    log: (msg: string, ...args: unknown[]) => void;
}

export interface DiscoveredCompetition {
    compid: string;
    url: string;
}

//
// The interface itself. Three idempotent methods; all may be called many
// times on the same compid across a process's lifetime.
//
export interface ScoringSource {
    // Stable type tag; matches the `scoringsource.type` column.
    readonly type: string;

    // Discover/refresh the competition row, name, dates, site, tz. Cheap
    // and idempotent — called the first time the scheduler sees a comp
    // and lazily afterwards (e.g. on tz refinement).
    ensureMetadata(ctx: SourceCtx): Promise<void>;

    // Fetch the pilot roster across all classes. Adapter writes pilots /
    // tracker via `lib/scoring/shared/pilots.ts` and returns what it saw
    // so the scheduler can prune unseen rows. `options.skipPrune` (set
    // by the trackers-cadence path) suppresses the prune + pilotresult
    // writes — see FetchPilotsOptions.
    fetchPilots(ctx: SourceCtx, options?: FetchPilotsOptions): Promise<FetchPilotsResult>;

    // Fetch tasks + per-day results across all classes. Adapter writes
    // tasks/taskleg/contestday/pilotresult via the shared helpers; the
    // scheduler hands in a `skipDay` so old days are not refetched, and
    // optionally `tasksOnly` / `resultsOnly` to fetch only one half on
    // the corresponding cadence.
    fetchResultsAndTasks(ctx: SourceCtx, skipDay: SkipDayPredicate, options?: FetchResultsOptions): Promise<FetchResultsResult>;

    // Fetch the live tracker (compno → FLARM ID) mapping. Optional —
    // only adapters that have a tracker source implement it. Driven on
    // the scheduler's trackers cadence (08:00-22:00 local, per-source
    // interval until AllHome, hourly after). Idempotent. The hint
    // `trackerIntervalMs` tells the scheduler how often to poll; the
    // scheduler falls back to 15 min if unset.
    fetchTrackers?(ctx: SourceCtx): Promise<void>;
    readonly trackerIntervalMs?: number;

    // Optional override for the tasks-fetch cadence during L (launching)
    // and S (post-start, within the launch window) class phases. When
    // unset, the scheduler uses INTERVAL_TASKS_FAST_MS for L and
    // INTERVAL_TASKS_SLOW_MS for S — fine for adapters whose tasks
    // payload is expensive. SGP sets this tight (60 s) because its
    // task+tracks JSON is cheap and the L→S nostart rewrite needs to
    // land in seconds, not minutes.
    readonly activeTasksCadenceMs?: number;

    // Optional daily competition discovery. The scheduler calls this at
    // most once per UTC day (at or after 05:00 UTC) and INSERT IGNOREs
    // each returned `{compid, url}` into `scoringsource` so any new
    // competitions become visible to the regular heartbeat on the next
    // tick. Implementations that don't have a sensible global index can
    // simply omit this method.
    discoverCompetitions?(ctx: DiscoverCtx): Promise<DiscoveredCompetition[]>;
}

//
// SourceRegistry — trivial type tag → adapter map. The entry binary
// instantiates it once and registers each available source. The
// scheduler looks adapters up by `scoringsource.type` per row.
//
export class SourceRegistry {
    private readonly sources = new Map<string, ScoringSource>();

    register(source: ScoringSource): void {
        this.sources.set(source.type, source);
    }

    get(type: string): ScoringSource | undefined {
        return this.sources.get(type);
    }

    types(): string[] {
        return Array.from(this.sources.keys());
    }
}
