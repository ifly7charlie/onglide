/**
 * Scoring chain runner for tests.
 *
 * Wires up the full async generator pipeline (enriched → taskPosition →
 * aatScoring/racingScoring → taskScores) and feeds synthetic positions
 * through it, collecting PilotScore outputs.
 *
 * Bypasses BroadcastChannel by constructing an InOrderGenerator directly
 * from the position array, matching the approach in mainthreadscore.ts.
 */
import type {
    Task,
    Epoch,
    Compno,
    PositionMessage,
    InOrderGenerator,
    AirfieldLocation,
    DistanceKM
} from '../../lib/types';
import {PositionStatus} from '../../lib/types';
import type {PilotScore} from '../../lib/protobuf/onglide';

import {enrichedPositionGenerator} from '../../lib/webworkers/enrichedPositionGenerator';
import {taskPositionGenerator} from '../../lib/webworkers/taskpositiongenerator';
import {assignedAreaScoringGenerator} from '../../lib/webworkers/assignedAreaScoringGenerator';
import {racingScoringGenerator} from '../../lib/webworkers/racingScoringGenerator';
import {taskScoresGenerator} from '../../lib/webworkers/taskScoresGenerator';

import {sortedIndexBy as _sortedIndexBy} from 'lodash';

// ── types ─────────────────────────────────────────────────────────────────

export interface ScoringResult {
    /** All PilotScore values emitted by the chain. */
    scores: PilotScore[];
    /** The final (live) score — typically the most interesting. */
    final: PilotScore;
}

export interface RunOptions {
    /** Competition number. Default 'AA'. */
    compno?: string;
    /** Pilot handicap (100 = no handicap). Default 100. */
    handicap?: number;
    /** Official start time (from task sheet / results system). Default: task's nostartutc for AAT, 0 for racing. */
    utcStart?: Epoch;
    /** Logging function. Default silent. */
    log?: Function;
}

// ── InOrderGenerator from array ───────────────────────────────────────────

/**
 * Build an InOrderGenerator directly from a sorted array of PositionMessages.
 * This replaces bindChannelForInOrderPackets for testing — no BroadcastChannel,
 * no timers, no waiting.
 */
function makeInOrderGenerator(compno: Compno, positions: PositionMessage[]): () => InOrderGenerator {
    return function () {
        return (async function* (): InOrderGenerator {
            let position = 0;
            let hiccup: Epoch = 0 as Epoch;

            while (position < positions.length) {
                const message = positions[position++];
                const isLast = position >= positions.length;
                const nextPoint: Epoch | void = yield {...message, _: isLast || !!message._};

                // Handle rewind requests from the scoring chain
                if (nextPoint) {
                    position = _sortedIndexBy(positions, {t: nextPoint} as any, (o: any) => o.t);
                    continue;
                }

                // Emit periodic ticks (every 60s of flight time) to drive landout detection
                if (!isLast && message.t - hiccup > 60) {
                    hiccup = message.t;
                    const tickPoint: Epoch | void = yield {c: compno, _: false, tick: true, t: hiccup} as any;
                    if (tickPoint) {
                        position = _sortedIndexBy(positions, {t: tickPoint} as any, (o: any) => o.t);
                    }
                }
            }

            // Final tick to flush any pending state
            yield {c: compno, _: true, tick: true, t: positions[positions.length - 1]?.t ?? (0 as Epoch)} as any;
        })();
    };
}

// ── main runner ───────────────────────────────────────────────────────────

/**
 * Run the full scoring chain on a task + positions and collect all PilotScore outputs.
 */
export async function runScoringChain(task: Task, positions: PositionMessage[], opts: RunOptions = {}): Promise<ScoringResult> {
    const compno = (opts.compno ?? positions[0]?.c ?? 'AA') as Compno;
    const handicap = opts.handicap ?? 100;
    const utcStart = opts.utcStart ?? (0 as Epoch);
    const log = opts.log ?? (() => {});

    // Build the airfield location from the start leg
    const startLeg = task.legs[0];
    const airfield: AirfieldLocation = {
        name: 'Test Airfield',
        tz: 'UTC' as any,
        tzoffset: 0,
        sunset: (task.rules.nostartutc + 36000) as Epoch, // 10 hours after start
        lat: startLeg.nlat,
        lng: startLeg.nlng,
        start: '08:00',
        end: '20:00',
        officialDelay: 0 as Epoch,
        altitude: startLeg.altitude ?? (0 as any),
        point: {
            type: 'Feature',
            properties: {},
            geometry: {type: 'Point', coordinates: [startLeg.nlng, startLeg.nlat]}
        }
    };

    // Wire up the generator chain
    const inorder = makeInOrderGenerator(compno, positions);
    const epg = enrichedPositionGenerator(airfield, inorder(), log);
    const tpg = taskPositionGenerator(task, utcStart, epg, log);
    const distances = task.rules.aat ? assignedAreaScoringGenerator(task, tpg, log) : racingScoringGenerator(task, tpg, log);
    const scores = taskScoresGenerator(task, compno, handicap, distances, log);

    // Collect all scores
    const allScores: PilotScore[] = [];
    for await (const score of scores) {
        allScores.push(score);
        // Break on live score (end of flight data)
        if (score.live) {
            break;
        }
    }

    if (allScores.length === 0) {
        throw new Error('Scoring chain produced no output');
    }

    return {
        scores: allScores,
        final: allScores[allScores.length - 1]
    };
}
