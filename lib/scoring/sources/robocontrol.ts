// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// RobocontrolSource — `ScoringSource` adapter for the robocontrol
// tracker feed. Robocontrol carries no pilots / tasks / results — only
// the (CN → FLARM id) mapping — so this adapter only implements
// `fetchTrackers`. ensureMetadata is a no-op (the comp must already
// exist; robocontrol is never the authoritative metadata source) and
// the pilots / results methods return empty observed sets.
//
// Replaces the standalone `setInterval(fetchRobocontrol, ...)` block
// previously in `bin/ssscrape.ts` so robocontrol now runs on the same
// per-competition cadence (08:00-22:00 local; 15-minute interval until
// AllHome, hourly after) as every other tracker source.
//

import {fetchRobocontrolOne} from '../shared/robocontrol';

import type {FetchPilotsResult, FetchResultsResult, ScoringSource, SourceCtx} from '../source';

export class RobocontrolSource implements ScoringSource {
    readonly type = 'robocontrol';
    readonly trackerIntervalMs = 15 * 60 * 1000;

    async ensureMetadata(_ctx: SourceCtx): Promise<void> {
        // Robocontrol has no comp metadata. The scheduler treats the
        // adapter that handles tasks/results (soaringspotkey / scrape /
        // sgp) as the metadata owner.
    }

    async fetchPilots(_ctx: SourceCtx): Promise<FetchPilotsResult> {
        return {observed: new Map()};
    }

    async fetchResultsAndTasks(_ctx: SourceCtx): Promise<FetchResultsResult> {
        return {observedClasses: new Set()};
    }

    async fetchTrackers(ctx: SourceCtx): Promise<void> {
        await fetchRobocontrolOne(ctx.db, ctx.log, ctx.compid, ctx.url);
    }
}
