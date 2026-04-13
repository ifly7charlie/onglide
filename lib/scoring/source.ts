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
    // so the scheduler can prune unseen rows.
    fetchPilots(ctx: SourceCtx): Promise<FetchPilotsResult>;

    // Fetch tasks + per-day results across all classes. Adapter writes
    // tasks/taskleg/contestday/pilotresult via the shared helpers; the
    // scheduler hands in a `skipDay` so old days are not refetched.
    fetchResultsAndTasks(ctx: SourceCtx, skipDay: SkipDayPredicate): Promise<FetchResultsResult>;

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
